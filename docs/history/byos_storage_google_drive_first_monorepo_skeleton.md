# BYOS Storage (Google Drive first) — Monorepo Skeleton

Agnostic, open‑source TypeScript library for “Bring Your Own Storage”, starting with a **fully functional Google Drive provider**. File‑type agnostic (works for any binary/text files). Includes a minimal CLI and a NestJS wrapper.

---

## Monorepo layout (pnpm workspaces)
```
byos/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md
  .env.example
  packages/
    core/
      package.json
      src/
        index.ts
        types.ts
        errors.ts
        utils/
          backoff.ts
          stream.ts
          hashes.ts
        auth/
          token-store.ts
    drive/
      package.json
      src/
        index.ts
        drive-adapter.ts
        drive-auth.ts
        mappers.ts
    cli/
      package.json
      src/
        index.ts
        commands/
          auth.ts
          ls.ts
          put.ts
          get.ts
          rm.ts
          mkdir.ts
          mv.ts
          cp.ts
          sync.ts
    nestjs/
      package.json
      src/
        index.ts
        byos.module.ts
        byos.service.ts
        byos.constants.ts
```

---

## Package: `@byos/core`

### `types.ts`
```ts
export type FileId = string;
export type Cursor = string;

export interface FileStat {
  id: FileId;
  name: string;
  mimeType?: string;
  size?: number;
  md5?: string;
  sha256?: string;
  modifiedAt?: Date;
  createdAt?: Date;
  isFolder: boolean;
  parents?: string[];
}

export interface ListOptions {
  path?: string; // provider-specific path or folderId
  pageSize?: number;
  pageToken?: string;
}

export interface PutOptions {
  path?: string; // parent folder id or path
  name: string;
  size?: number;
  mimeType?: string;
  body: NodeJS.ReadableStream | Buffer | Uint8Array;
  checksum?: { md5?: string; sha256?: string };
  overwrite?: boolean;
}

export interface GetOptions { id?: FileId; path?: string; }
export interface DeleteOptions { id?: FileId; path?: string; recursive?: boolean }
export interface MkdirOptions { path: string; parents?: boolean }
export interface MoveCopyOptions { sourceId?: FileId; sourcePath?: string; targetPath: string; newName?: string }

export interface ChangesPage {
  cursor: Cursor; // next page cursor
  files: FileStat[]; // changed files (insert/update/delete indicated via isTrashed?)
}

export interface StorageAdapter {
  readonly name: string;
  list(opts?: ListOptions): Promise<{ items: FileStat[]; nextPageToken?: string }>
  stat(ref: { id?: FileId; path?: string }): Promise<FileStat | undefined>
  mkdir(opts: MkdirOptions): Promise<FileStat>
  put(opts: PutOptions): Promise<FileStat>
  get(opts: GetOptions): Promise<NodeJS.ReadableStream>
  delete(opts: DeleteOptions): Promise<void>
  move(opts: MoveCopyOptions): Promise<FileStat>
  copy(opts: MoveCopyOptions): Promise<FileStat>
  getStartCursor(): Promise<Cursor>
  getChanges(cursor: Cursor): Promise<ChangesPage>
}
```

### `errors.ts`
```ts
export class ByosError extends Error { constructor(msg: string, public cause?: unknown){ super(msg); }}
export class NotFoundError extends ByosError {}
export class ConflictError extends ByosError {}
export class PermissionError extends ByosError {}
```

### `auth/token-store.ts`
```ts
export interface TokenData {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number; // ms epoch
}

export interface TokenStore {
  load(key: string): Promise<TokenData | undefined>;
  save(key: string, token: TokenData): Promise<void>;
  clear(key: string): Promise<void>;
}
```

### `utils/backoff.ts`
```ts
export async function withBackoff<T>(fn: () => Promise<T>, opts: { retries?: number } = {}){
  const max = opts.retries ?? 5;
  let delay = 500;
  for(let i=0;i<=max;i++){
    try { return await fn(); } catch(e){
      if(i===max) throw e;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
  throw new Error('unreachable');
}
```

### `index.ts`
```ts
export * from './types';
export * from './errors';
export * from './auth/token-store';
export * as backoff from './utils/backoff';
```

---

## Package: `@byos/drive`

### `drive-auth.ts`
```ts
import { OAuth2Client } from 'google-auth-library';
import { TokenStore, TokenData } from '@byos/core';

export interface DriveAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string; // e.g. http://localhost:5173/callback or urn:ietf:wg:oauth:2.0:oob
  tokenKey: string; // where to store user token
  tokenStore: TokenStore;
}

export class DriveAuth {
  private oauth: OAuth2Client;
  constructor(private cfg: DriveAuthConfig){
    this.oauth = new OAuth2Client(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  }
  getClient(){ return this.oauth; }
  authUrl(scopes: string[] = ['https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive.appdata']){
    return this.oauth.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
  }
  async handleCode(code: string){
    const { tokens } = await this.oauth.getToken(code);
    await this.save(tokens);
    this.oauth.setCredentials(tokens);
    return tokens;
  }
  async load(){
    const data = await this.cfg.tokenStore.load(this.cfg.tokenKey);
    if(data){ this.oauth.setCredentials(data as TokenData); }
    return data;
  }
  async save(tokens: TokenData){ await this.cfg.tokenStore.save(this.cfg.tokenKey, tokens); }
}
```

### `mappers.ts`
```ts
import { drive_v3 } from 'googleapis';
import { FileStat } from '@byos/core';

export function mapFile(f: drive_v3.Schema$File): FileStat {
  return {
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType || undefined,
    size: f.size ? Number(f.size) : undefined,
    md5: f.md5Checksum || undefined,
    modifiedAt: f.modifiedTime ? new Date(f.modifiedTime) : undefined,
    createdAt: f.createdTime ? new Date(f.createdTime) : undefined,
    isFolder: f.mimeType === 'application/vnd.google-apps.folder',
    parents: f.parents ?? undefined,
  };
}
```

### `drive-adapter.ts`
```ts
import { google, drive_v3 } from 'googleapis';
import { StorageAdapter, FileStat, ListOptions, PutOptions, GetOptions, DeleteOptions, MoveCopyOptions, Cursor, ChangesPage, NotFoundError } from '@byos/core';
import { OAuth2Client } from 'google-auth-library';
import { mapFile } from './mappers';

export interface DriveAdapterConfig { oauth: OAuth2Client; }

export class DriveAdapter implements StorageAdapter {
  readonly name = 'google-drive';
  private drive: drive_v3.Drive;
  constructor(cfg: DriveAdapterConfig){ this.drive = google.drive({ version: 'v3', auth: cfg.oauth }); }

  async list(opts: ListOptions = {}){
    // If path is a folderId; for path strings, a resolver could be added later
    const q = opts.path ? `'${opts.path}' in parents and trashed=false` : `'root' in parents and trashed=false`;
    const res = await this.drive.files.list({ q, pageSize: opts.pageSize ?? 100, pageToken: opts.pageToken, fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents)' });
    return { items: (res.data.files ?? []).map(mapFile), nextPageToken: res.data.nextPageToken ?? undefined };
  }

  async stat(ref: { id?: string; path?: string }): Promise<FileStat | undefined> {
    if(ref.id){
      const res = await this.drive.files.get({ fileId: ref.id, fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,trashed' });
      if(res.data.trashed) return undefined;
      return mapFile(res.data);
    }
    // path resolution can be implemented via incremental search; for MVP we focus on id-based ops
    return undefined;
  }

  async mkdir(opts: { path: string; parents?: boolean }): Promise<FileStat> {
    const res = await this.drive.files.create({ requestBody: { name: opts.path, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id,name,mimeType,createdTime' });
    return mapFile(res.data);
  }

  async put(opts: PutOptions): Promise<FileStat> {
    const res = await this.drive.files.create({
      uploadType: 'resumable',
      requestBody: { name: opts.name, parents: opts.path ? [opts.path] : undefined },
      media: { mimeType: opts.mimeType, body: opts.body as any },
      fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,parents'
    }, { maxBodyLength: Infinity });
    return mapFile(res.data);
  }

  async get(opts: GetOptions){
    if(!opts.id) throw new Error('get requires id for DriveAdapter');
    const res = await this.drive.files.get({ fileId: opts.id, alt: 'media' }, { responseType: 'stream' });
    return res.data as unknown as NodeJS.ReadableStream;
  }

  async delete(opts: DeleteOptions){
    const id = opts.id; if(!id) throw new Error('delete requires id');
    await this.drive.files.delete({ fileId: id });
  }

  async move(opts: MoveCopyOptions): Promise<FileStat> {
    if(!opts.sourceId) throw new Error('move requires sourceId');
    // get current parents
    const f = await this.drive.files.get({ fileId: opts.sourceId, fields: 'parents' });
    const prev = (f.data.parents || []).join(',');
    const res = await this.drive.files.update({ fileId: opts.sourceId, addParents: opts.targetPath, removeParents: prev || undefined, requestBody: { name: opts.newName } as any, fields: 'id,name,parents,mimeType,modifiedTime' });
    return mapFile(res.data);
  }

  async copy(opts: MoveCopyOptions): Promise<FileStat> {
    if(!opts.sourceId) throw new Error('copy requires sourceId');
    const res = await this.drive.files.copy({ fileId: opts.sourceId, requestBody: { name: opts.newName }, fields: 'id,name,parents,mimeType,modifiedTime' });
    return mapFile(res.data);
  }

  async getStartCursor(): Promise<Cursor> {
    const res = await this.drive.changes.getStartPageToken({});
    return res.data.startPageToken!;
  }

  async getChanges(cursor: Cursor): Promise<ChangesPage> {
    const res = await this.drive.changes.list({ pageToken: cursor, fields: 'newStartPageToken,nextPageToken,changes(file(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,trashed))' });
    const files = (res.data.changes ?? [])
      .map(c => c.file!)
      .filter(Boolean)
      .filter(f => !f.trashed)
      .map(mapFile);
    return { cursor: res.data.nextPageToken ?? res.data.newStartPageToken!, files };
  }
}
```

### `index.ts`
```ts
export * from './drive-adapter';
export * from './drive-auth';
```

---

## Package: `@byos/cli` (minimal, Node ≥18)

### `src/index.ts`
```ts
#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DriveAuth } from '@byos/drive';
import { DriveAdapter } from '@byos/drive';

class JsonTokenStore { constructor(private file = path.join(process.cwd(), '.byos-token.json')){}
  async load(){ try { return JSON.parse(fs.readFileSync(this.file,'utf8')); } catch{ return undefined; } }
  async save(_k: string, t: any){ fs.writeFileSync(this.file, JSON.stringify(t,null,2)); }
  async clear(){ try{ fs.unlinkSync(this.file); }catch{} }
}

const program = new Command();
program.name('byos').description('BYOS CLI (Google Drive first)').version('0.1.0');

function authFromEnv(){
  const tokenStore = new JsonTokenStore();
  const auth = new DriveAuth({
    clientId: process.env.BYOS_GOOGLE_CLIENT_ID!,
    clientSecret: process.env.BYOS_GOOGLE_CLIENT_SECRET!,
    redirectUri: process.env.BYOS_GOOGLE_REDIRECT_URI!,
    tokenKey: 'default',
    tokenStore
  });
  return { auth, tokenStore };
}

program.command('auth')
  .description('Authenticate with Google')
  .action(async ()=>{
    const { auth } = authFromEnv();
    const url = auth.authUrl();
    console.log('Open this URL and authorize:\n', url);
    process.stdout.write('Paste the code here: ');
    process.stdin.once('data', async (buf)=>{
      const code = String(buf).trim();
      const tokens = await auth.handleCode(code);
      console.log('Auth OK. Scopes:', tokens.scope);
      process.exit(0);
    });
  });

program.command('ls')
  .option('-p, --parent <id>', 'parent folder id')
  .action( async (opts)=>{
    const { auth } = authFromEnv();
    await auth.load();
    const adapter = new DriveAdapter({ oauth: auth.getClient() });
    const out = await adapter.list({ path: opts.parent });
    out.items.forEach(i => console.log(i.id, i.isFolder ? '[DIR]' : '     ', i.name, i.size ?? ''));
  });

program.command('put <file>')
  .option('-p, --parent <id>','destination folder id')
  .action(async (file, opts)=>{
    const { auth } = authFromEnv();
    await auth.load();
    const adapter = new DriveAdapter({ oauth: auth.getClient() });
    const stream = fs.createReadStream(file);
    const stat = await adapter.put({ name: path.basename(file), path: opts.parent, body: stream });
    console.log('Uploaded:', stat.id, stat.name);
  });

program.command('get <id> <out>')
  .action(async (id, out)=>{
    const { auth } = authFromEnv();
    await auth.load();
    const adapter = new DriveAdapter({ oauth: auth.getClient() });
    const rs = await adapter.get({ id });
    const ws = fs.createWriteStream(out);
    rs.pipe(ws);
    await new Promise(r=> ws.on('close', r));
    console.log('Downloaded to', out);
  });

program.parseAsync();
```

> Add more commands similarly (`rm`, `mkdir`, `mv`, `cp`, `sync`) following the adapter methods.

---

## Package: `@byos/nestjs`

### `byos.constants.ts`
```ts
export const BYOS_ADAPTER = Symbol('BYOS_ADAPTER');
```

### `byos.module.ts`
```ts
import { Module, DynamicModule } from '@nestjs/common';
import { BYOS_ADAPTER } from './byos.constants';
import { ByosService } from './byos.service';

@Module({ providers: [ByosService], exports: [ByosService] })
export class ByosModule {
  static forAdapter(adapter: any): DynamicModule {
    return { module: ByosModule, providers: [{ provide: BYOS_ADAPTER, useValue: adapter }], exports: [ByosService] };
  }
}
```

### `byos.service.ts`
```ts
import { Inject, Injectable } from '@nestjs/common';
import { StorageAdapter, PutOptions } from '@byos/core';
import { BYOS_ADAPTER } from './byos.constants';

@Injectable()
export class ByosService {
  constructor(@Inject(BYOS_ADAPTER) private readonly adapter: StorageAdapter) {}
  list(parent?: string){ return this.adapter.list({ path: parent }); }
  upload(opts: PutOptions){ return this.adapter.put(opts); }
  download(id: string){ return this.adapter.get({ id }); }
}
```

### `src/index.ts`
```ts
export * from './byos.module';
export * from './byos.service';
export * from './byos.constants';
```

---

## Root files

### `pnpm-workspace.yaml`
```yaml
packages:
  - 'packages/*'
```

### `tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "Node",
    "declaration": true,
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

### Root `package.json`
```json
{
  "name": "byos",
  "private": true,
  "workspaces": ["packages/*"],
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm -r --parallel dev"
  }
}
```

### Example `.env.example`
```
BYOS_GOOGLE_CLIENT_ID=your.apps.googleusercontent.com
BYOS_GOOGLE_CLIENT_SECRET=your_secret
BYOS_GOOGLE_REDIRECT_URI=http://localhost:4321/callback
```

---

## Quickstart (local)
1. **Create OAuth Client** (Google Cloud Console → OAuth Consent + Credentials → OAuth Client ID). Use redirect URI de desenvolvimento.
2. `pnpm i` (packages: `@byos/core`, `@byos/drive`, `@byos/cli`, `@byos/nestjs`)
3. `cd packages/cli && pnpm build && pnpm link --global`
4. No diretório do projeto: `export $(cat .env | xargs)`
5. `byos auth` → abre URL, cole o **code**.
6. `byos ls` → lista arquivos da raiz (ou use `--parent <folderId>`)
7. `byos put ./photo.jpg --parent <folderId>`
8. `byos get <fileId> ./out.jpg`

> **Observações**
> - O adapter foca em **ID‑based** para evitar ambiguidade de caminho; um `PathResolver` pode ser adicionado na próxima iteração.
> - Upload é **resumable** por padrão. Adicione `throttling`/`concurrency` facilmente no core.
> - `getChanges()`/`getStartCursor()` já permitem **sync multi‑dispositivo** (implementar um reconciliador simples por timestamps + hash em próxima etapa).

---

## Path Resolver (IDs a partir de caminhos)

### `@byos/core/src/utils/path-resolver.ts`
```ts
import type { drive_v3 } from 'googleapis';

export class DrivePathResolver {
  constructor(private readonly drive: drive_v3.Drive) {}

  /** Resolve a path like "/Folder/Sub/Leaf" to a Drive file/folder id. */
  async resolvePathToId(path: string): Promise<string> {
    const clean = (path || '').trim();
    if (!clean || clean === '/' ) return 'root';
    const parts = clean.replace(/^\/+|\/+$/g, '').split('/');
    let parentId = 'root';
    for (const name of parts) {
      // search for folder/file with this name under parentId
      const q = [
        `'${parentId}' in parents`,
        `name = '${name.replace(/'/g, "\'")}'`,
        'trashed = false'
      ].join(' and ');
      const res = await this.drive.files.list({ q, fields: 'files(id,name,mimeType)' });
      const match = (res.data.files || [])[0];
      if (!match) throw new Error(`Path segment not found: ${name}`);
      parentId = match.id!;
    }
    return parentId;
  }
}
```

> Nota: nomes duplicados no mesmo nível não são incomuns no Drive. Para o MVP, pegamos o **primeiro match**. Em produção, considere persistir IDs após primeira resolução e/ou permitir `--pick` interativo no CLI.

---

## Atualizações no `@byos/drive`

### `drive-adapter.ts` (trechos relevantes)
```ts
// ... imports
import { DrivePathResolver } from '@byos/core/utils/path-resolver';

export class DriveAdapter implements StorageAdapter {
  // ...
  private resolver: DrivePathResolver;
  constructor(cfg: DriveAdapterConfig){
    this.drive = google.drive({ version: 'v3', auth: cfg.oauth });
    this.resolver = new DrivePathResolver(this.drive);
  }

  private async ensureParentId(path?: string){
    if (!path) return 'root';
    // if looks like an id (simple heuristic), return as-is
    if (/^[a-zA-Z0-9_-]{10,}$/.test(path) && !path.startsWith('/')) return path;
    return this.resolver.resolvePathToId(path);
  }

  async list(opts: ListOptions = {}){
    const parentId = await this.ensureParentId(opts.path);
    const q = `'${parentId}' in parents and trashed=false`;
    const res = await this.drive.files.list({ q, pageSize: opts.pageSize ?? 100, pageToken: opts.pageToken, fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents)' });
    return { items: (res.data.files ?? []).map(mapFile), nextPageToken: res.data.nextPageToken ?? undefined };
  }

  async mkdir(opts: { path: string; parents?: boolean }): Promise<FileStat> {
    const parentPath = opts.path.includes('/') ? opts.path.split('/').slice(0, -1).join('/') : '';
    const name = opts.path.split('/').pop()!;
    const parentId = await this.ensureParentId(parentPath || undefined);
    const res = await this.drive.files.create({ requestBody: { name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' }, fields: 'id,name,mimeType,createdTime,parents' });
    return mapFile(res.data);
  }

  async put(opts: PutOptions): Promise<FileStat> {
    const parentId = await this.ensureParentId(opts.path);
    const res = await this.drive.files.create({
      uploadType: 'resumable',
      requestBody: { name: opts.name, parents: parentId ? [parentId] : undefined },
      media: { mimeType: opts.mimeType, body: opts.body as any },
      fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,parents'
    }, { maxBodyLength: Infinity });
    return mapFile(res.data);
  }

  async move(opts: MoveCopyOptions): Promise<FileStat> {
    if(!opts.sourceId) throw new Error('move requires sourceId');
    const targetId = await this.ensureParentId(opts.targetPath);
    const f = await this.drive.files.get({ fileId: opts.sourceId, fields: 'parents' });
    const prev = (f.data.parents || []).join(',');
    const res = await this.drive.files.update({ fileId: opts.sourceId, addParents: targetId, removeParents: prev || undefined, requestBody: { name: opts.newName } as any, fields: 'id,name,parents,mimeType,modifiedTime' });
    return mapFile(res.data);
  }

  async copy(opts: MoveCopyOptions): Promise<FileStat> {
    if(!opts.sourceId) throw new Error('copy requires sourceId');
    const targetId = await this.ensureParentId(opts.targetPath);
    const res = await this.drive.files.copy({ fileId: opts.sourceId, requestBody: { name: opts.newName, parents: [targetId] }, fields: 'id,name,parents,mimeType,modifiedTime' });
    return mapFile(res.data);
  }
}
```

---

## CLI — novos comandos (`rm`, `mkdir`, `mv`, `cp`, `sync`)

### `packages/cli/src/commands/rm.ts`
```ts
import { DriveAdapter } from '@byos/drive';
import { authFromEnv } from '../shared';

export default async function rm(id: string){
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });
  await adapter.delete({ id });
  console.log('Deleted', id);
}
```

### `packages/cli/src/commands/mkdir.ts`
```ts
import { DriveAdapter } from '@byos/drive';
import { authFromEnv } from '../shared';

export default async function mkdir(path: string){
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });
  const stat = await adapter.mkdir({ path });
  console.log('Folder:', stat.id, stat.name);
}
```

### `packages/cli/src/commands/mv.ts`
```ts
import { DriveAdapter } from '@byos/drive';
import { authFromEnv } from '../shared';

export default async function mv(sourceId: string, targetPath: string, newName?: string){
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });
  const stat = await adapter.move({ sourceId, targetPath, newName });
  console.log('Moved:', stat.id, '→', targetPath, newName ? `(renamed to ${newName})` : '');
}
```

### `packages/cli/src/commands/cp.ts`
```ts
import { DriveAdapter } from '@byos/drive';
import { authFromEnv } from '../shared';

export default async function cp(sourceId: string, targetPath: string, newName?: string){
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });
  const stat = await adapter.copy({ sourceId, targetPath, newName });
  console.log('Copied:', stat.id, '→', targetPath);
}
```

### `packages/cli/src/commands/sync.ts` (MVP: up/down)
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DriveAdapter } from '@byos/drive';
import { authFromEnv } from '../shared';

interface Opts { dir: string; parent?: string; direction: 'up'|'down' }

export default async function sync(opts: Opts){
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });
  const parent = opts.parent;

  if(opts.direction === 'up'){
    const entries = fs.readdirSync(opts.dir);
    for(const name of entries){
      const full = path.join(opts.dir, name);
      if(fs.statSync(full).isFile()){
        const stream = fs.createReadStream(full);
        const stat = await adapter.put({ name, path: parent, body: stream });
        console.log('Uploaded', name, '→', stat.id);
      }
    }
  } else {
    const list = await adapter.list({ path: parent });
    for(const f of list.items.filter(i=>!i.isFolder)){
      const rs = await adapter.get({ id: f.id });
      const out = path.join(opts.dir, f.name);
      const ws = fs.createWriteStream(out);
      await pipeline(rs as any, ws);
      console.log('Downloaded', f.name);
    }
  }
}
```

### `packages/cli/src/shared.ts` (refactor comum)
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DriveAuth } from '@byos/drive';

class JsonTokenStore { constructor(private file = path.join(process.cwd(), '.byos-token.json')){}
  async load(){ try { return JSON.parse(fs.readFileSync(this.file,'utf8')); } catch{ return undefined; } }
  async save(_k: string, t: any){ fs.writeFileSync(this.file, JSON.stringify(t,null,2)); }
  async clear(){ try{ fs.unlinkSync(this.file); }catch{} }
}

export function authFromEnv(){
  const tokenStore = new JsonTokenStore();
  const auth = new DriveAuth({
    clientId: process.env.BYOS_GOOGLE_CLIENT_ID!,
    clientSecret: process.env.BYOS_GOOGLE_CLIENT_SECRET!,
    redirectUri: process.env.BYOS_GOOGLE_REDIRECT_URI!,
    tokenKey: 'default',
    tokenStore
  });
  return { auth, tokenStore };
}
```

### `packages/cli/src/index.ts` (registrar comandos)
```ts
#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authFromEnv } from './shared';
import rm from './commands/rm';
import mkdir from './commands/mkdir';
import mv from './commands/mv';
import cp from './commands/cp';
import sync from './commands/sync';
import { DriveAdapter } from '@byos/drive';

const program = new Command();
program.name('byos').description('BYOS CLI (Google Drive first)').version('0.2.0');

program.command('auth').description('Authenticate with Google').action(async ()=>{
  const { auth } = authFromEnv();
  const url = auth.authUrl();
  console.log('Open this URL and authorize:
', url);
  process.stdout.write('Paste the code here: ');
  process.stdin.once('data', async (buf)=>{
    const code = String(buf).trim();
    const tokens = await auth.handleCode(code);
    console.log('Auth OK. Scopes:', tokens.scope);
    process.exit(0);
  });
});

program.command('ls').option('-p, --parent <pathOrId>', 'parent path or id').action( async (opts)=>{
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });
  const out = await adapter.list({ path: opts.parent });
  out.items.forEach(i => console.log(i.id, i.isFolder ? '[DIR]' : '     ', i.name, i.size ?? '')); 
});

program.command('put <file>').option('-p, --parent <pathOrId>','destination path or id').action(async (file, opts)=>{
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });
  const stream = fs.createReadStream(file);
  const stat = await adapter.put({ name: path.basename(file), path: opts.parent, body: stream });
  console.log('Uploaded:', stat.id, stat.name);
});

program.command('get <id> <out>').action(async (id, out)=>{
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });
  const rs = await adapter.get({ id });
  const ws = fs.createWriteStream(out);
  rs.pipe(ws);
  await new Promise(r=> ws.on('close', r));
  console.log('Downloaded to', out);
});

program.command('rm <id>').action(async (id)=> rm(id));
program.command('mkdir <path>').action(async (path)=> mkdir(path));
program.command('mv <sourceId> <targetPathOrId> [newName]').action(async (s,t,n)=> mv(s,t,n));
program.command('cp <sourceId> <targetPathOrId> [newName]').action(async (s,t,n)=> cp(s,t,n));
program.command('sync').requiredOption('-d, --dir <localDir>','local directory').option('-p, --parent <pathOrId>','remote folder path or id').option('--down','download remote→local').action(async (opts)=>{
  await sync({ dir: opts.dir, parent: opts.parent, direction: opts.down ? 'down':'up' });
});

program.parseAsync();
```

---

## Exemplo NestJS — API mínima (`examples/nestjs-api`)

```
examples/nestjs-api/
  package.json
  tsconfig.json
  src/
    main.ts
    app.module.ts
    drive.provider.ts
    files.controller.ts
```

### `package.json`
```json
{ "name": "byos-nestjs-api", "private": true, "type": "module", "scripts": { "start": "ts-node src/main.ts" }, "dependencies": { "@nestjs/common": "^10", "@nestjs/core": "^10", "reflect-metadata": "^0.1.13", "rxjs": "^7", "@byos/core": "workspace:*", "@byos/drive": "workspace:*", "google-auth-library": "^9", "googleapis": "^140", "multer": "^1.4.5-lts.1" }, "devDependencies": { "ts-node": "^10", "typescript": "^5" } }
```

### `src/drive.provider.ts`
```ts
import { Provider } from '@nestjs/common';
import { DriveAuth, DriveAdapter } from '@byos/drive';

export const DriveAdapterProvider: Provider = {
  provide: 'BYOS_ADAPTER',
  useFactory: async ()=>{
    const auth = new DriveAuth({
      clientId: process.env.BYOS_GOOGLE_CLIENT_ID!,
      clientSecret: process.env.BYOS_GOOGLE_CLIENT_SECRET!,
      redirectUri: process.env.BYOS_GOOGLE_REDIRECT_URI!,
      tokenKey: 'server',
      tokenStore: { async load(){ return undefined; }, async save(){}, async clear(){} }
    });
    // Para servidor, injete tokens obtidos via OAuth do usuário (ex.: header/DB) antes de criar o adapter.
    await auth.load();
    return new DriveAdapter({ oauth: auth.getClient() });
  }
};
```

### `src/files.controller.ts`
```ts
import { Controller, Get, Post, Delete, Param, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { DriveAdapter } from '@byos/drive';

@Controller('files')
export class FilesController {
  constructor(private readonly adapter: DriveAdapter) {}

  @Get()
  async list(@Query('parent') parent?: string){
    return this.adapter.list({ path: parent });
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: Express.Multer.File, @Query('parent') parent?: string){
    const stat = await this.adapter.put({ name: file.originalname, path: parent, mimeType: file.mimetype, body: file.stream });
    return stat;
  }

  @Get('download/:id')
  async download(@Param('id') id: string, @Res() res: Response){
    const stream = await this.adapter.get({ id });
    stream.pipe(res);
  }

  @Delete(':id')
  async remove(@Param('id') id: string){
    await this.adapter.delete({ id });
    return { ok: true };
  }
}
```

### `src/app.module.ts`
```ts
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { DriveAdapterProvider } from './drive.provider';

@Module({ controllers: [FilesController], providers: [DriveAdapterProvider] })
export class AppModule {}
```

### `src/main.ts`
```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(){
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
  console.log('Nest API on http://localhost:3000');
}
bootstrap();
```

---

## Quickstart extra (CLI com paths)
- `byos mkdir /BYOS` → cria pasta "BYOS" na raiz
- `byos put ./file.txt -p /BYOS` → sobe arquivo
- `byos ls -p /BYOS` → lista
- `byos mv <id> /BYOS/Sub 'renamed.txt'` → move/renomeia
- `byos cp <id> /BYOS/Copies` → copia
- `byos rm <id>` → apaga
- `byos sync -d ./local -p /BYOS` → **up** (local→Drive)
- `byos sync -d ./local -p /BYOS --down` → **down** (Drive→local)

---

## Dedupe por SHA‑256 + Conflitos (implementação)

### `@byos/core/src/utils/hashes.ts`
```ts
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export async function sha256FromStream(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function sha256FromBuffer(buf: Buffer | Uint8Array): Promise<string> {
  const hash = createHash('sha256');
  hash.update(buf);
  return hash.digest('hex');
}
```

### `@byos/core/src/types.ts` (novos tipos)
```ts
export enum ConflictPolicy {
  /** last writer wins (mtime do arquivo mais recente) */
  LWW = 'lww',
  /** preferir checksum (arquivos idênticos não geram conflito; se diferentes, cai no LWW) */
  CHECKSUM_THEN_LWW = 'checksum',
  /** preferir sempre o remoto em conflito */
  REMOTE_WINS = 'remote',
  /** preferir sempre o local em conflito */
  LOCAL_WINS = 'local'
}

export interface SyncOptions {
  parent?: string;           // folder path/id remoto
  localDir: string;          // pasta local
  policy?: ConflictPolicy;   // política de resolução
}

export interface IndexEntry {
  id?: FileId;               // id remoto, se houver
  name: string;
  size?: number;
  sha256?: string;
  modifiedAt?: Date;
}
```

### Gravar SHA‑256 no Drive (appProperties)

#### `@byos/drive/src/mappers.ts`
```ts
import { drive_v3 } from 'googleapis';
import { FileStat } from '@byos/core';

export function mapFile(f: drive_v3.Schema$File): FileStat {
  const appProps = (f.appProperties ?? {}) as Record<string,string>;
  return {
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType || undefined,
    size: f.size ? Number(f.size) : undefined,
    md5: f.md5Checksum || undefined,
    sha256: appProps['byos:sha256'] || undefined,
    modifiedAt: f.modifiedTime ? new Date(f.modifiedTime) : undefined,
    createdAt: f.createdTime ? new Date(f.createdTime) : undefined,
    isFolder: f.mimeType === 'application/vnd.google-apps.folder',
    parents: f.parents ?? undefined,
  };
}
```

#### `@byos/drive/src/drive-adapter.ts` (salvar SHA‑256 ao fazer upload)
```ts
import { sha256FromStream, sha256FromBuffer } from '@byos/core/utils/hashes';
// ... dentro de put()
  async put(opts: PutOptions): Promise<FileStat> {
    const parentId = await this.ensureParentId(opts.path);

    // calcular sha256 se não veio
    let sha256 = opts.checksum?.sha256;
    let body: any = opts.body as any;
    // se o body é stream e não temos sha256, precisamos duplicar stream → calcular e reenviar
    if(!sha256){
      if(Buffer.isBuffer(body) || body instanceof Uint8Array){
        sha256 = await sha256FromBuffer(body);
      } else {
        // consumir stream para hash e reabrir stream do arquivo local não é geral; para CLI funciona (readStream de path). Para casos genéricos, espere sha256 no opts.
        throw new Error('sha256 missing: provide PutOptions.checksum.sha256 when body is a stream not re-creatable');
      }
    }

    const res = await this.drive.files.create({
      uploadType: 'resumable',
      requestBody: { name: opts.name, parents: parentId ? [parentId] : undefined, appProperties: { 'byos:sha256': sha256 } },
      media: { mimeType: opts.mimeType, body },
      fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,parents,appProperties'
    }, { maxBodyLength: Infinity });
    return mapFile(res.data);
  }
```

> **Observação**: para clientes que só têm *stream* (ex. upload do navegador), passe `checksum.sha256` calculado antes (File/Blob → ArrayBuffer) para evitar *double read*.

---

## Sync bidirecional (MVP) com política

### `@byos/core/src/sync/sync-engine.ts`
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageAdapter, ConflictPolicy, SyncOptions } from '../types';

export class SyncEngine {
  constructor(private readonly adapter: StorageAdapter){}

  async syncBoth(opts: SyncOptions){
    const policy = opts.policy ?? ConflictPolicy.CHECKSUM_THEN_LWW;

    // 1) snapshot local
    const local = new Map<string,{ full:string, size:number, mtime:number, sha256?:string }>();
    for(const name of fs.readdirSync(opts.localDir)){
      const full = path.join(opts.localDir, name);
      const st = fs.statSync(full);
      if(st.isFile()) local.set(name, { full, size: st.size, mtime: st.mtimeMs });
    }

    // 2) snapshot remoto (apenas nível atual)
    const remoteList = await this.adapter.list({ path: opts.parent });
    const remote = new Map<string, typeof remoteList.items[number]>();
    for(const f of remoteList.items.filter(i=>!i.isFolder)) remote.set(f.name, f);

    // 3) reconciliação
    const names = new Set<string>([...local.keys(), ...remote.keys()]);

    for(const name of names){
      const L = local.get(name);
      const R = remote.get(name);

      if(L && !R){
        // UPLOAD
        const stream = fs.createReadStream(L.full);
        await this.adapter.put({ name, path: opts.parent, body: stream, checksum: { sha256: L.sha256 } });
        continue;
      }
      if(!L && R){
        // DOWNLOAD
        const rs = await this.adapter.get({ id: R.id });
        const ws = fs.createWriteStream(path.join(opts.localDir, name));
        await pipeline(rs as any, ws);
        continue;
      }
      if(L && R){
        // CONFLITO? comparar por checksum se existir; senão por mtime
        const rSha = R.sha256; // lido de appProperties
        const lMTime = L.mtime;
        const rMTime = R.modifiedAt?.getTime() ?? 0;

        if(rSha && L.sha256 && rSha === L.sha256){
          // iguais → nada a fazer
          continue;
        }

        switch(policy){
          case ConflictPolicy.REMOTE_WINS: {
            const rs = await this.adapter.get({ id: R.id });
            const ws = fs.createWriteStream(path.join(opts.localDir, name));
            await pipeline(rs as any, ws);
            break;
          }
          case ConflictPolicy.LOCAL_WINS: {
            const stream = fs.createReadStream(L.full);
            await this.adapter.put({ name, path: opts.parent, body: stream, checksum: { sha256: L.sha256 } });
            break;
          }
          case ConflictPolicy.CHECKSUM_THEN_LWW:
          default: {
            if(lMTime >= rMTime){
              const stream = fs.createReadStream(L.full);
              await this.adapter.put({ name, path: opts.parent, body: stream, checksum: { sha256: L.sha256 } });
            } else {
              const rs = await this.adapter.get({ id: R.id });
              const ws = fs.createWriteStream(path.join(opts.localDir, name));
              await pipeline(rs as any, ws);
            }
          }
        }
      }
    }
  }
}
```

> MVP: **nível único** da pasta. Próximas versões: recursivo, exclusões (tombstones), *renames* e *moves* com base em `getChanges()`.

---

## CLI — `sync` com bidirecional e política

### `packages/cli/src/commands/sync.ts`
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DriveAdapter } from '@byos/drive';
import { authFromEnv } from '../shared';
import { SyncEngine } from '@byos/core/sync/sync-engine';
import { ConflictPolicy } from '@byos/core';

interface Opts { dir: string; parent?: string; down?: boolean; both?: boolean; policy?: string }

export default async function sync(opts: Opts){
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });

  if(opts.both){
    const engine = new SyncEngine(adapter);
    await engine.syncBoth({ localDir: opts.dir, parent: opts.parent, policy: (opts.policy as ConflictPolicy) ?? ConflictPolicy.CHECKSUM_THEN_LWW });
    return;
  }

  // comportamento antigo: up/down simples
  if(!opts.down){
    const entries = fs.readdirSync(opts.dir);
    for(const name of entries){
      const full = path.join(opts.dir, name);
      if(fs.statSync(full).isFile()){
        const stream = fs.createReadStream(full);
        await adapter.put({ name, path: opts.parent, body: stream });
        console.log('Uploaded', name);
      }
    }
  } else {
    const list = await adapter.list({ path: opts.parent });
    for(const f of list.items.filter(i=>!i.isFolder)){
      const rs = await adapter.get({ id: f.id });
      const out = path.join(opts.dir, f.name);
      const ws = fs.createWriteStream(out);
      await new Promise(r=>{ rs.pipe(ws); ws.on('close', r); });
      console.log('Downloaded', f.name);
    }
  }
}
```

### `packages/cli/src/index.ts` (flags novas)
```ts
program.command('sync')
  .requiredOption('-d, --dir <localDir>','local directory')
  .option('-p, --parent <pathOrId>','remote folder path or id')
  .option('--down','download remote→local')
  .option('--both','bidirectional sync')
  .option('--policy <policy>','conflict policy: lww | checksum | remote | local', 'checksum')
  .action(async (opts)=>{ await sync(opts); });
```

---

## Uso (CLI) — dedupe e conflitos
- Upload com checksum pré-calculado (recomendado com *streams*):
  - `byos put ./file.bin -p /BYOS --checksum <sha256>` *(ajuste do CLI opcional em futura iteração)*
- Sync bidirecional:
  - `byos sync -d ./local -p /BYOS --both` *(política padrão: `checksum` → LWW)*
  - `byos sync -d ./local -p /BYOS --both --policy lww`
  - `byos sync -d ./local -p /BYOS --both --policy remote` (remoto vence)
  - `byos sync -d ./local -p /BYOS --both --policy local` (local vence)

---

## Sync recursivo, exclusões (tombstones), renames/moves (changes) e melhorias de path-cache/concorrência

### Utilitários de concorrência e cache

#### `@byos/core/src/utils/semaphore.ts`
```ts
export class Semaphore {
  private counter: number;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number){ this.counter = limit; }
  async acquire(){
    if(this.counter > 0){ this.counter--; return; }
    await new Promise<void>(r => this.queue.push(r));
  }
  release(){
    this.counter++;
    const next = this.queue.shift();
    if(next){ this.counter--; next(); }
  }
}
```

#### `@byos/core/src/utils/lru.ts`
```ts
export class Lru<K,V> {
  private map = new Map<K, {v:V, t:number}>();
  constructor(private readonly max=500, private readonly ttlMs=60_000){}
  get(k:K){
    const e = this.map.get(k); if(!e) return undefined;
    if(Date.now() - e.t > this.ttlMs){ this.map.delete(k); return undefined; }
    this.map.delete(k); this.map.set(k, {v:e.v, t:Date.now()});
    return e.v;
  }
  set(k:K, v:V){
    if(this.map.has(k)) this.map.delete(k);
    this.map.set(k, {v, t:Date.now()});
    if(this.map.size > this.max){ const first = this.map.keys().next().value; this.map.delete(first); }
  }
  delete(k:K){ this.map.delete(k); }
  clear(){ this.map.clear(); }
}
```

---

### Path Resolver com cache (e invalidação)

#### `@byos/core/src/utils/path-resolver.ts` (atualizado)
```ts
import type { drive_v3 } from 'googleapis';
import { Lru } from './lru';

export class DrivePathResolver {
  private cache = new Lru<string,string>(1000, 5*60_000);
  constructor(private readonly drive: drive_v3.Drive) {}

  async resolvePathToId(path: string): Promise<string> {
    const clean = (path || '').trim();
    if (!clean || clean === '/' ) return 'root';
    const norm = clean.replace(/^\/+|\/+$/g, '');
    const cached = this.cache.get(norm); if(cached) return cached;
    const parts = norm.split('/');
    let parentId = 'root';
    for (const name of parts) {
      const q = [`'${parentId}' in parents`,`name = '${name.replace(/'/g, "\'")}'`,'trashed = false'].join(' and ');
      const res = await this.drive.files.list({ q, fields: 'files(id,name,mimeType)' });
      const match = (res.data.files || [])[0];
      if (!match) throw new Error(`Path segment not found: ${name}`);
      parentId = match.id!;
    }
    this.cache.set(norm, parentId);
    return parentId;
  }

  invalidate(path: string){ const norm = path.replace(/^\/+|\/+$/g, ''); this.cache.delete(norm); }
  clear(){ this.cache.clear(); }
}
```

> A invalidação será usada quando detectarmos renames/moves via *changes*.

---

### AppData: tombstones e cursor

#### `@byos/drive/src/appdata.ts`
```ts
import { drive_v3 } from 'googleapis';

export interface Tombstone { path?: string; id?: string; name: string; when: string; }
export interface AppState { cursor?: string }

export class AppDataStore {
  constructor(private readonly drive: drive_v3.Drive){}

  async ensureAppFile(name: string){
    const res = await this.drive.files.list({ spaces: 'appDataFolder', q: `name='${name}' and trashed=false`, fields: 'files(id,name)' });
    let id = res.data.files?.[0]?.id;
    if(!id){
      const created = await this.drive.files.create({ requestBody: { name, parents: ['appDataFolder'] }, media: { mimeType: 'application/json', body: '{}' }, fields: 'id' });
      id = created.data.id!;
    }
    return id!;
  }

  async readJson<T=any>(name: string, fallback: T): Promise<T>{
    const id = await this.ensureAppFile(name);
    const res = await this.drive.files.get({ fileId: id, alt:'media' }, { responseType:'json' });
    return (res.data as T) ?? fallback;
  }

  async writeJson(name: string, data: any){
    const id = await this.ensureAppFile(name);
    await this.drive.files.update({ fileId: id, media: { mimeType:'application/json', body: JSON.stringify(data) } });
  }
}
```

---

### Sync recursivo + exclusões + renames/moves

#### `@byos/core/src/sync/sync-engine.ts` (versão avançada)
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageAdapter, ConflictPolicy, SyncOptions, FileStat } from '../types';
import { Semaphore } from '../utils/semaphore';

export interface AdvancedSyncOptions extends SyncOptions {
  recursive?: boolean;
  delete?: boolean;              // propagar exclusões
  maxConcurrency?: number;       // uploads/downloads concorrentes
  useChanges?: boolean;          // tentar usar changes (se adapter suportar)
  onProgress?: (ev:{ op:'upload'|'download'|'delete'|'skip', name:string })=>void;
}

export class SyncEngine {
  constructor(private readonly adapter: StorageAdapter){}

  private async listAll(parent?: string): Promise<FileStat[]> {
    const out: FileStat[] = [];
    const stack: Array<{id?:string; path?:string}> = [{ path: parent }];
    while(stack.length){
      const cur = stack.pop()!;
      const page = await this.adapter.list({ path: cur.path ?? cur.id });
      for(const f of page.items){
        out.push(f);
        if(f.isFolder) stack.push({ id: f.id });
      }
    }
    return out;
  }

  async sync(opts: AdvancedSyncOptions){
    const policy = opts.policy ?? ConflictPolicy.CHECKSUM_THEN_LWW;
    const maxC = Math.max(1, opts.maxConcurrency ?? 3);
    const sem = new Semaphore(maxC);

    // snapshot local (recursivo opcional)
    const localFiles = new Map<string,{ full:string, size:number, mtime:number }>();
    const walkLocal = (dir:string, base='')=>{
      for(const name of fs.readdirSync(dir)){
        const full = path.join(dir, name);
        const rel = path.join(base, name);
        const st = fs.statSync(full);
        if(st.isDirectory()) { if(opts.recursive) walkLocal(full, rel); continue; }
        localFiles.set(rel, { full, size: st.size, mtime: st.mtimeMs });
      }
    };
    walkLocal(opts.localDir);

    // snapshot remoto
    const remoteList = opts.recursive ? await this.listAll(opts.parent) : (await this.adapter.list({ path: opts.parent })).items;
    const remoteFiles = new Map<string, FileStat>();
    for(const f of remoteList.filter(i=>!i.isFolder)) remoteFiles.set(f.name, f);

    const names = new Set<string>([...localFiles.keys(), ...remoteFiles.keys()]);

    const tasks: Array<Promise<void>> = [];

    const doUpload = async (name:string)=>{
      await sem.acquire();
      try{ const L = localFiles.get(name)!; await this.adapter.put({ name, path: opts.parent, body: fs.createReadStream(L.full) }); opts.onProgress?.({op:'upload', name}); } finally { sem.release(); }
    };

    const doDownload = async (name:string)=>{
      await sem.acquire();
      try{ const R = remoteFiles.get(name)!; const rs = await this.adapter.get({ id: R.id }); const ws = fs.createWriteStream(path.join(opts.localDir, name)); await pipeline(rs as any, ws); opts.onProgress?.({op:'download', name}); } finally { sem.release(); }
    };

    // Reconciliação + exclusões
    for(const name of names){
      const L = localFiles.get(name);
      const R = remoteFiles.get(name);

      if(L && !R){ tasks.push(doUpload(name)); continue; }
      if(!L && R){ if(opts.delete){ tasks.push((async()=>{ await sem.acquire(); try{ await this.adapter.delete({ id: R.id }); opts.onProgress?.({op:'delete', name}); } finally{ sem.release(); }})()); } else { tasks.push(doDownload(name)); } continue; }

      if(L && R){
        // conflito simples (checksum se houver, senão mtime)
        const lM = L.mtime; const rM = R.modifiedAt?.getTime() ?? 0;
        // se o adapter preencher sha256, poderíamos comparar aqui
        if(lM >= rM){ tasks.push(doUpload(name)); } else { tasks.push(doDownload(name)); }
      }
    }

    await Promise.all(tasks);
  }
}
```

> **Notas**
> - `recursive`: anda por subpastas (local e remoto). No remoto, usamos uma pilha e `list()` por pasta.
> - `delete`: se `true`, arquivos existentes **só no remoto** são removidos; se `false`, são baixados.
> - `maxConcurrency`: controla *backpressure* simples.
> - Versão acima ainda não aplica `useChanges`; abaixo, adicionamos integração com *changes* e tombstones.

---

### Renames/moves e tombstones com *changes*

#### `@byos/drive/src/changes-sync.ts`
```ts
import { drive_v3, google } from 'googleapis';
import { AppDataStore, AppState, Tombstone } from './appdata';
import { FileStat, StorageAdapter } from '@byos/core';

export class DriveChangeTracker {
  constructor(private readonly drive: drive_v3.Drive, private readonly app: AppDataStore){}

  async nextCursor(): Promise<string>{
    const s = await this.app.readJson<AppState>('byos-state.json', {} as any);
    if(s.cursor) return s.cursor;
    const t = await this.drive.changes.getStartPageToken({});
    s.cursor = t.data.startPageToken!; await this.app.writeJson('byos-state.json', s); return s.cursor;
  }

  async applyChanges(handle: (f: FileStat, change: drive_v3.Schema$Change)=>Promise<void>){
    let cursor = await this.nextCursor();
    while(true){
      const res = await this.drive.changes.list({ pageToken: cursor, fields: 'nextPageToken,newStartPageToken,changes(changeType,file(id,name,mimeType,parents,trashed,modifiedTime,appProperties))' });
      for(const ch of res.data.changes ?? []){
        const f = ch.file; if(!f) continue;
        // deletions
        if(ch.changeType === 'removed' || f.trashed){
          const t: Tombstone = { id: f.id!, name: f.name ?? '', when: new Date().toISOString() };
          const state = await this.app.readJson<any>('byos-tombstones.json', { items: [] });
          state.items.push(t); await this.app.writeJson('byos-tombstones.json', state);
          continue;
        }
        // renames/moves detectáveis via mudança de parents ou name
        await handle({
          id: f.id!, name: f.name!, isFolder: f.mimeType === 'application/vnd.google-apps.folder',
          mimeType: f.mimeType || undefined, parents: f.parents ?? undefined,
          modifiedAt: f.modifiedTime ? new Date(f.modifiedTime) : undefined,
          sha256: (f.appProperties as any)?.['byos:sha256']
        } as FileStat, ch);
      }
      if(res.data.nextPageToken){ cursor = res.data.nextPageToken; } else { cursor = res.data.newStartPageToken!; }
      const s = await this.app.readJson<AppState>('byos-state.json', {} as any); s.cursor = cursor; await this.app.writeJson('byos-state.json', s);
      break; // processar um lote por chamada (ajuste conforme necessidade)
    }
  }
}
```

> O *tracker* mantém `cursor` em `appDataFolder` e grava tombstones. Em uma integração real, chamaríamos `applyChanges` periodicamente e refletiríamos `renames/moves` e exclusões localmente.

---

### CLI — flags novas de sync

#### `packages/cli/src/index.ts` (com recursivo, delete, both, policy, concurrency)
```ts
program.command('sync')
  .requiredOption('-d, --dir <localDir>','local directory')
  .option('-p, --parent <pathOrId>','remote folder path or id')
  .option('-r, --recursive','walk subfolders')
  .option('--delete','if set, delete remote-only files (instead of downloading)')
  .option('--both','bidirectional sync')
  .option('--policy <policy>','conflict policy: lww | checksum | remote | local', 'checksum')
  .option('-c, --concurrency <n>','uploads/downloads concurrency', (v)=>parseInt(v,10), 3)
  .action(async (opts)=>{ await sync(opts); });
```

#### `packages/cli/src/commands/sync.ts` (aceitar novas flags)
```ts
import { DriveAdapter } from '@byos/drive';
import { authFromEnv } from '../shared';
import { SyncEngine } from '@byos/core/sync/sync-engine';
import { ConflictPolicy } from '@byos/core';

export default async function sync(opts: any){
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });

  const engine = new SyncEngine(adapter);
  await engine.sync({
    localDir: opts.dir,
    parent: opts.parent,
    recursive: !!opts.recursive,
    delete: !!opts.delete,
    both: true,
    policy: (opts.policy as ConflictPolicy) ?? ConflictPolicy.CHECKSUM_THEN_LWW,
    maxConcurrency: Number(opts.concurrency) || 3,
  } as any);
}
```

> Simplificamos: `sync` agora usa sempre o motor avançado com opções. O modo *only up/down* pode ser mantido via flags no futuro, se necessário.

---

## Uso (CLI) — novos cenários
- **Sync recursivo e bidirecional**: `byos sync -d ./local -p /BYOS -r --both`
- **Propagar exclusões (apaga remoto-only)**: `byos sync -d ./local -p /BYOS -r --both --delete`
- **Controlar concorrência**: `byos sync -d ./local -p /BYOS -r --both -c 6`
- **Política**: `--policy lww | checksum | remote | local`

---

## Observações de implementação
- *Changes feed* (`DriveChangeTracker`) e `AppDataStore` dão base para renames/moves/exclusões sem *full scan*.
- `tombstones` ficam em `appDataFolder` (arquivo `byos-tombstones.json`). Em próxima etapa, podemos reconciliar tombstones locais → remoto também.
- O **path-cache (LRU)** reduz *lookups* do resolver; invalidar via *changes* em renames/moves futuros.
- `Semaphore` limita *uploads/downloads* concorrentes para evitar *rate limits*.

---

## Integração do *changes* no CLI (`--use-changes`) + subcomando `changes`

### Expor utilitários no pacote `@byos/drive`

#### `packages/drive/src/index.ts`
```ts
export * from './drive-adapter';
export * from './drive-auth';
export * from './appdata';
export * from './changes-sync';
```

---

### CLI: subcomando `changes`

#### `packages/cli/src/commands/changes.ts`
```ts
import { DriveAdapter, AppDataStore } from '@byos/drive';
import { authFromEnv } from '../shared';
import { google } from 'googleapis';
import { DriveChangeTracker } from '@byos/drive';

export default async function changes(){
  const { auth } = authFromEnv();
  await auth.load();
  const drive = google.drive({ version: 'v3', auth: auth.getClient() });
  const app = new AppDataStore(drive);
  const tracker = new DriveChangeTracker(drive, app);
  let count = 0;
  await tracker.applyChanges(async (f, ch)=>{
    count++;
    const kind = ch.changeType || (f.isFolder ? 'folder' : 'file');
    console.log(`[${kind}]`, f.id, f.name, f.modifiedAt?.toISOString() ?? '');
  });
  console.log('Processed changes:', count);
}
```

---

### CLI: `sync` com `--use-changes`

#### `packages/cli/src/commands/sync.ts` (atualizado)
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DriveAdapter, AppDataStore } from '@byos/drive';
import { authFromEnv } from '../shared';
import { SyncEngine } from '@byos/core/sync/sync-engine';
import { ConflictPolicy } from '@byos/core';
import { google } from 'googleapis';
import { DriveChangeTracker } from '@byos/drive';

export default async function sync(opts: any){
  const { auth } = authFromEnv();
  await auth.load();
  const adapter = new DriveAdapter({ oauth: auth.getClient() });

  if(opts.useChanges){
    // Aplica mudanças incrementais do Drive → espelha no diretório local
    const drive = google.drive({ version: 'v3', auth: auth.getClient() });
    const app = new AppDataStore(drive);
    const tracker = new DriveChangeTracker(drive, app);

    await tracker.applyChanges(async (f, ch)=>{
      if(f.isFolder) return; // ignorar pastas neste MVP
      // remoções: apagar localmente se --delete
      if(ch.changeType === 'removed' || (ch.file && ch.file.trashed)){
        if(opts.delete){
          const out = path.join(opts.dir, f.name);
          if(fs.existsSync(out)) fs.unlinkSync(out);
          console.log('Deleted local tombstone:', f.name);
        } else {
          console.log('Remote deleted, skip local:', f.name);
        }
        return;
      }
      // atualizações/criações: baixar arquivo
      const rs = await adapter.get({ id: f.id });
      const out = path.join(opts.dir, f.name);
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const ws = fs.createWriteStream(out);
      await pipeline(rs as any, ws);
      console.log('Synced change → download:', f.name);
    });
    return;
  }

  if(opts.both){
    const engine = new SyncEngine(adapter);
    await engine.sync({
      localDir: opts.dir,
      parent: opts.parent,
      recursive: !!opts.recursive,
      delete: !!opts.delete,
      both: true,
      policy: (opts.policy as ConflictPolicy) ?? ConflictPolicy.CHECKSUM_THEN_LWW,
      maxConcurrency: Number(opts.concurrency) || 3,
    } as any);
    return;
  }

  // modo compatível (up/down) – mantido
  if(!opts.down){
    const entries = fs.readdirSync(opts.dir);
    for(const name of entries){
      const full = path.join(opts.dir, name);
      if(fs.statSync(full).isFile()){
        const stream = fs.createReadStream(full);
        await adapter.put({ name, path: opts.parent, body: stream });
        console.log('Uploaded', name);
      }
    }
  } else {
    const list = await adapter.list({ path: opts.parent });
    for(const f of list.items.filter(i=>!i.isFolder)){
      const rs = await adapter.get({ id: f.id });
      const out = path.join(opts.dir, f.name);
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const ws = fs.createWriteStream(out);
      await new Promise(r=>{ rs.pipe(ws); ws.on('close', r); });
      console.log('Downloaded', f.name);
    }
  }
}
```

#### `packages/cli/src/index.ts` (registrar `changes` e flag `--use-changes`)
```ts
import changes from './commands/changes';
// ...
program.command('changes').description('List & apply incremental changes from Drive to local (MVP)').action(async ()=>{ await changes(); });

program.command('sync')
  .requiredOption('-d, --dir <localDir>','local directory')
  .option('-p, --parent <pathOrId>','remote folder path or id')
  .option('-r, --recursive','walk subfolders')
  .option('--delete','if set, delete local files when remote tombstone is seen')
  .option('--both','bidirectional sync (scan-based)')
  .option('--use-changes','apply incremental changes from Drive to local (one pass)')
  .option('--policy <policy>','conflict policy: lww | checksum | remote | local', 'checksum')
  .option('-c, --concurrency <n>','uploads/downloads concurrency', (v)=>parseInt(v,10), 3)
  .action(async (opts)=>{ await sync(opts); });
```

---

## Uso (CLI) — changes + sync
- **Inspecionar/aplicar mudanças incrementais (um ciclo):** `byos changes`
- **Sincronizar usando changes (Drive → local):** `byos sync -d ./local --use-changes`
- **Bidirecional por varredura (recursivo, com concorrência):** `byos sync -d ./local -p /BYOS -r --both -c 6`
- **Deletar local ao detectar remoção remota:** `byos sync -d ./local --use-changes --delete`

> Observação: `--use-changes` neste MVP só aplica **Drive → local**. Na próxima etapa, podemos combinar *changes* com um índice local para tornar o bidirecional verdadeiramente incremental.

