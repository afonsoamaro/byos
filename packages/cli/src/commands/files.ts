import { createReadStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  ConflictError,
  NotFoundError,
  type FileRef,
  type FileStat,
  type StorageProvider,
} from '@byos/core';
import type { Command } from 'commander';

import { openContext, openStorage, type GlobalFlags } from '../context.js';
import { CliError } from '../errors.js';
import { formatBytes, printable } from '../format.js';
import type { CliIO } from '../io.js';
import { pathApi, safeLocalName, sha256File } from '../local.js';
import { assertRemotePath, joinRemote, parseRemote, splitRemote } from '../remote.js';

/**
 * A failure of the local disk (missing folder, no permission, disk full) as a CliError with a
 * stable code, so a subprocess consumer never sees UNEXPECTED for something it can act on.
 */
function localIoError(error: unknown, path: string): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
    return new CliError(`${path} can not be used as a local path (${code})`, 2, 'USAGE');
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC' || code === 'EROFS') {
    return new CliError(`can not write ${path} (${code})`, 1, 'LOCAL_IO');
  }
  return error;
}

// The eight file commands. Their `--json` output and exit codes are a public API (a Python
// app calls `byos put --json` as a subprocess), so the shapes below are the PP-02 ones:
// docs/cli-output.md. Stdout carries one JSON document, stderr one { code, message }.

/** What `ls`, `stat`, `mkdir`, `mv` and `cp` print under `--json`. */
interface Entry {
  readonly id: string;
  readonly name: string;
  /** Known when the file was reached by path; Drive ids carry no path. */
  readonly path?: string;
  readonly kind: 'file' | 'folder';
  readonly size?: number;
  readonly modifiedTime?: string;
  readonly sha256?: string;
}

function toEntry(file: FileStat, path?: string): Entry {
  return {
    id: file.id,
    name: file.name,
    ...(path === undefined ? {} : { path }),
    kind: file.isFolder ? 'folder' : 'file',
    ...(file.size === undefined ? {} : { size: file.size }),
    ...(file.modifiedAt === undefined ? {} : { modifiedTime: file.modifiedAt }),
    ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
  };
}

const pathOf = (ref: FileRef, name?: string): string | undefined =>
  ref.path === undefined ? undefined : name === undefined ? ref.path : joinRemote(ref.path, name);

async function requireStat(
  provider: StorageProvider,
  ref: FileRef,
  label: string,
): Promise<FileStat> {
  const found = await provider.stat(ref);
  if (!found) throw new NotFoundError(`no file at ${label}`);
  return found;
}

/** The folder part of a destination: `a/b/` means "into a/b", `a/b` means "as b in a". */
function parseDestination(arg: string): { parent: FileRef; name?: string } {
  const ref = parseRemote(arg);
  if (ref.path === undefined) {
    throw new CliError('the destination must be a path, not an id', 2, 'USAGE');
  }
  if (arg.endsWith('/') || arg === '') return { parent: { path: ref.path } };
  const { dir, name } = splitRemote(ref.path);
  return { parent: { path: dir }, name };
}

// ── ls, stat, mkdir ──────────────────────────────────────────────────────────

async function runLs(io: CliIO, flags: GlobalFlags, remote: string): Promise<void> {
  const ctx = openContext(io, flags);
  const provider = await openStorage(ctx);
  const parent = parseRemote(remote);
  const items: FileStat[] = [];
  let pageToken: string | undefined;
  do {
    const page = await provider.list({
      parent,
      pageSize: 1000,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    items.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  for (const item of items) {
    const name = printable(item.name);
    ctx.out.line(item.isFolder ? `${name}/` : `${name}  ${formatBytes(item.size ?? 0)}`);
  }
  ctx.out.data(items.map((item) => toEntry(item, pathOf(parent, item.name))));
}

async function runStat(io: CliIO, flags: GlobalFlags, remote: string): Promise<void> {
  const ctx = openContext(io, flags);
  const provider = await openStorage(ctx);
  const ref = parseRemote(remote);
  const found = await requireStat(provider, ref, remote);
  const entry = toEntry(found, pathOf(ref));
  ctx.out.rows(
    Object.entries(entry).map(([key, value]) => [key, printable(String(value))] as const),
    '',
  );
  ctx.out.data(entry);
}

async function runMkdir(io: CliIO, flags: GlobalFlags & { parents?: boolean }, remote: string) {
  const ctx = openContext(io, flags);
  const provider = await openStorage(ctx);
  const ref = parseRemote(remote);
  if (ref.path === undefined) throw new CliError('mkdir needs a path, not an id', 2, 'USAGE');
  const { dir, name } = splitRemote(ref.path);
  if (name === '') throw new CliError('mkdir needs a folder name', 2, 'USAGE');
  const folder = await provider.mkdir({
    parent: { path: dir },
    name,
    ...(flags.parents === true ? { parents: true } : {}),
  });
  ctx.out.ok(`Folder ${printable(joinRemote(dir, name))}`);
  ctx.out.data(toEntry(folder, joinRemote(dir, name)));
}

// ── put, get ─────────────────────────────────────────────────────────────────

interface PutFlags extends GlobalFlags {
  readonly remote?: string;
  readonly name?: string;
  readonly mkdir?: boolean;
  readonly overwrite?: boolean;
  readonly ifAbsent?: boolean;
}

async function runPut(io: CliIO, flags: PutFlags, localArg: string): Promise<void> {
  const ctx = openContext(io, flags);
  const api = pathApi(io.platform);
  const local = api.resolve(localArg);
  const info = await stat(local).catch(() => undefined);
  if (!info?.isFile()) {
    throw new CliError(`${localArg} is not a file that can be read`, 2, 'USAGE');
  }
  const parent = parseRemote(flags.remote ?? '');
  const name = flags.name ?? api.basename(local);
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new CliError('--name must be a plain file name, without folders', 2, 'USAGE');
  }
  // Hashed first: a resumable upload needs it up front, and --if-absent compares with it.
  const sha256 = await sha256File(local).catch((error: unknown) => {
    throw localIoError(error, localArg);
  });
  const provider = await openStorage(ctx);

  if (flags.mkdir === true && parent.path !== undefined && parent.path !== '') {
    const { dir, name: folder } = splitRemote(parent.path);
    await provider.mkdir({ parent: { path: dir }, name: folder, parents: true });
  }

  let result: FileStat | undefined;
  if (flags.ifAbsent === true) {
    const existing =
      parent.path === undefined
        ? (await provider.list({ parent, pageSize: 1000 })).items.find((i) => i.name === name)
        : await provider.stat({ path: joinRemote(parent.path, name) });
    if (existing) {
      if (existing.sha256 === sha256) result = existing;
      else if (flags.overwrite !== true) {
        throw new ConflictError(`${name} already exists with different content`);
      }
    }
  }

  result ??= await provider.put({
    parent,
    name,
    body: Readable.toWeb(createReadStream(local)) as ReadableStream<Uint8Array>,
    size: info.size,
    sha256,
    overwrite: flags.overwrite === true,
  });
  const path = pathOf(parent, name);
  ctx.out.ok(`Uploaded ${printable(path ?? name)} (${formatBytes(info.size)})`);
  ctx.out.data({
    id: result.id,
    name: result.name,
    sha256: result.sha256 ?? sha256,
    size: result.size ?? info.size,
    ...(path === undefined ? {} : { path }),
  });
}

async function runGet(
  io: CliIO,
  flags: GlobalFlags & { force?: boolean },
  remote: string,
  localArg: string | undefined,
): Promise<void> {
  const ctx = openContext(io, flags);
  const provider = await openStorage(ctx);
  const ref = parseRemote(remote);
  const file = await requireStat(provider, ref, remote);
  const toStdout = localArg === undefined || localArg === '-';
  if (toStdout && ctx.out.json) {
    throw new CliError('--json can not be combined with writing the file to stdout', 2, 'USAGE');
  }
  const stream = await provider.get(ref);
  if (toStdout) {
    const sink = io.out;
    if (!sink.writeBytes) {
      throw new CliError("this terminal can't take file bytes; give a local path", 2, 'USAGE');
    }
    for await (const chunk of Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0])) {
      sink.writeBytes(chunk as Uint8Array);
    }
    return;
  }
  const api = pathApi(io.platform);
  let dest = api.resolve(localArg);
  if ((await stat(dest).catch(() => undefined))?.isDirectory()) {
    // The remote name is not trusted: it must not walk out of the folder the user chose.
    const name = safeLocalName(file.name, io.platform);
    if (name === undefined) {
      await stream.cancel();
      throw new CliError(
        `refusing to save a file named ${JSON.stringify(file.name)}; give a local file name`,
        2,
        'USAGE',
      );
    }
    const folder = dest;
    dest = api.join(folder, name);
    const relative = api.relative(folder, dest);
    // Only a first segment of exactly `..` leaves the folder; `.._x` is just a file name.
    if (relative.split(/[\\/]/)[0] === '..' || api.isAbsolute(relative)) {
      await stream.cancel();
      throw new CliError(
        'the remote name escapes the target folder; give a local file name',
        2,
        'USAGE',
      );
    }
  }
  let handle;
  try {
    // Exclusive create: an existing local file is never overwritten without --force.
    handle = await open(dest, flags.force === true ? 'w' : 'wx');
  } catch (error) {
    await stream.cancel();
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliError(`${dest} already exists; use --force to overwrite it`, 4, 'CONFLICT');
    }
    throw localIoError(error, dest);
  }
  try {
    await pipeline(
      Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]),
      handle.createWriteStream(),
    );
  } catch (error) {
    await rm(dest, { force: true });
    throw localIoError(error, dest);
  }
  ctx.out.ok(`Saved ${printable(dest)} (${formatBytes(file.size ?? 0)})`);
  ctx.out.data({ id: file.id, name: file.name, size: file.size ?? 0, path: dest });
}

// ── mv, cp, rm ───────────────────────────────────────────────────────────────

async function relocate(
  io: CliIO,
  flags: GlobalFlags,
  verb: 'move' | 'copy',
  source: string,
  destination: string,
): Promise<void> {
  const ctx = openContext(io, flags);
  const provider = await openStorage(ctx);
  const ref = parseRemote(source);
  const file = await requireStat(provider, ref, source);
  const { parent, name } = parseDestination(destination);
  const options = { parent, ...(name === undefined ? {} : { name }) };
  const result =
    verb === 'move' ? await provider.move(ref, options) : await provider.copy(ref, options);
  const path = joinRemote(parent.path ?? '', result.name);
  ctx.out.ok(
    `${verb === 'move' ? 'Moved' : 'Copied'} ${printable(file.name)} to ${printable(path)}`,
  );
  ctx.out.data(toEntry(result, path));
}

async function runRm(
  io: CliIO,
  flags: GlobalFlags & { permanent?: boolean },
  remote: string,
): Promise<void> {
  const ctx = openContext(io, flags);
  const provider = await openStorage(ctx);
  const ref = parseRemote(remote);
  // A file already in the trash can still be deleted for good by its id.
  const id = ref.id ?? (await requireStat(provider, ref, remote)).id;
  await provider.delete(ref, { permanent: flags.permanent === true });
  ctx.out.ok(
    flags.permanent === true ? `Deleted ${remote} for good` : `Moved ${remote} to the trash`,
  );
  ctx.out.data({ id, trashed: flags.permanent !== true });
}

export function registerFiles(program: Command, io: CliIO): void {
  program
    .command('ls')
    .argument('[remote]', 'a remote folder (path or id:<fileId>)', '')
    .description('List the contents of a remote folder')
    .action(async (remote: string, _o: unknown, c: Command) => {
      await runLs(io, c.optsWithGlobals<GlobalFlags>(), remote);
    });
  program
    .command('stat')
    .argument('<remote>', 'a remote path or id:<fileId>')
    .description('Show one file or folder')
    .action(async (remote: string, _o: unknown, c: Command) => {
      await runStat(io, c.optsWithGlobals<GlobalFlags>(), remote);
    });
  program
    .command('mkdir')
    .argument('<remote>', 'a remote folder path')
    .option('--parents', 'create missing folders on the way')
    .description('Create a remote folder (it is fine if it already exists)')
    .action(async (remote: string, _o: unknown, c: Command) => {
      await runMkdir(io, c.optsWithGlobals<GlobalFlags & { parents?: boolean }>(), remote);
    });
  program
    .command('put')
    .argument('<local>', 'a local file')
    .option('--remote <dir>', 'the remote folder (path or id:<fileId>); default: the root')
    .option('--name <name>', 'the remote file name; default: the local name')
    .option('--mkdir', 'create the remote folder first')
    .option('--overwrite', 'replace a file with the same name (a new revision)')
    .option('--if-absent', 'do nothing when the same content is already there (safe to retry)')
    .description('Upload a file, with its SHA-256')
    .action(async (local: string, _o: unknown, c: Command) => {
      assertRemotePath(c.opts<PutFlags>().remote ?? '');
      await runPut(io, c.optsWithGlobals<GlobalFlags & PutFlags>(), local);
    });
  program
    .command('get')
    .argument('<remote>', 'a remote path or id:<fileId>')
    .argument('[local]', 'where to save it; default or - : stdout')
    .option('--force', 'overwrite an existing local file')
    .description('Download a file')
    .action(async (remote: string, local: string | undefined, _o: unknown, c: Command) => {
      await runGet(io, c.optsWithGlobals<GlobalFlags & { force?: boolean }>(), remote, local);
    });
  program
    .command('mv')
    .argument('<remote>', 'what to move')
    .argument('<dest>', 'the new path; a trailing / means into that folder')
    .description('Move or rename a remote file or folder')
    .action(async (source: string, dest: string, _o: unknown, c: Command) => {
      await relocate(io, c.optsWithGlobals<GlobalFlags>(), 'move', source, dest);
    });
  program
    .command('cp')
    .argument('<remote>', 'what to copy (a file)')
    .argument('<dest>', 'the new path; a trailing / means into that folder')
    .description('Copy a remote file')
    .action(async (source: string, dest: string, _o: unknown, c: Command) => {
      await relocate(io, c.optsWithGlobals<GlobalFlags>(), 'copy', source, dest);
    });
  program
    .command('rm')
    .argument('<remote>', 'a remote path or id:<fileId>')
    .option('--permanent', 'delete for good instead of moving to the trash')
    .description('Move a remote file to the trash (or delete it for good)')
    .action(async (remote: string, _o: unknown, c: Command) => {
      await runRm(io, c.optsWithGlobals<GlobalFlags & { permanent?: boolean }>(), remote);
    });
}
