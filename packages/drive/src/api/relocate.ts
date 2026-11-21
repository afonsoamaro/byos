import {
  ConflictError,
  NotFoundError,
  ProviderError,
  type CopyOptions,
  type DeleteOptions,
  type FileRef,
  type FileStat,
  type MoveOptions,
} from '@byos/core';

import type { DriveClient } from './client.js';
import { createWithReconcile, type CreateContext } from './creates.js';
import { FILE_FIELDS, copyUrl, driveFileSchema, filesUrl, toFileStat } from './files.js';

// move, copy and delete: the operations that change where a file lives or whether it exists.
// `delete` trashes unless `permanent` is explicit, and never touches anything but the one
// resolved id.

export interface RelocateContext {
  readonly client: DriveClient;
  readonly creates: CreateContext;
  /** Folder id paths are relative to (default `root`). */
  readonly root: string;
  readonly withRef: <T>(ref: FileRef, fn: (id: string) => Promise<T>) => Promise<T>;
  /** Resolves to `undefined` for a missing or trashed file. */
  readonly statById: (id: string) => Promise<FileStat | undefined>;
  /** Forgets a cached path, and everything under it, after it moved or went away. */
  readonly invalidate: (ref: FileRef) => void;
}

const fatal = (message: string) => new ProviderError(message, { retryable: false });
const JSON_HEADERS = { 'content-type': 'application/json; charset=UTF-8' } as const;
/** Bound of the walk up a folder chain: a real Drive tree is nowhere near this deep. */
const MAX_DEPTH = 256;

async function resolveId(ctx: RelocateContext, ref: FileRef): Promise<string> {
  return ctx.withRef(ref, (id) => Promise.resolve(id));
}

async function existing(ctx: RelocateContext, id: string): Promise<FileStat> {
  const stat = await ctx.statById(id);
  if (!stat) throw new NotFoundError('not found in Google Drive');
  return stat;
}

/** A folder can't go into itself or anything below it. */
async function assertNotInsideSelf(ctx: RelocateContext, source: FileStat, targetId: string) {
  let current: string | undefined = targetId;
  for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth += 1) {
    if (current === source.id) throw fatal('a folder cannot be moved into itself');
    current = (await ctx.statById(current))?.parents[0];
  }
}

export function move(ctx: RelocateContext, ref: FileRef, options: MoveOptions): Promise<FileStat> {
  if (options.parent === undefined && options.name === undefined) {
    return Promise.reject(fatal('move needs a new parent, a new name, or both'));
  }
  return ctx
    .withRef(ref, async (id) => {
      if (id === ctx.root || id === 'root') throw fatal('the root cannot be moved');
      const source = await existing(ctx, id);
      const currentParent = source.parents[0] ?? ctx.root;
      const targetParent = options.parent ? await resolveId(ctx, options.parent) : currentParent;
      const name = options.name ?? source.name;
      if (targetParent === currentParent && name === source.name) return source;

      if (source.isFolder) await assertNotInsideSelf(ctx, source, targetParent);
      const clash = (await ctx.creates.findChildren(targetParent, name)).find(
        (found) => found.id !== source.id,
      );
      if (clash) throw new ConflictError(`${name} already exists`);

      const reparent = targetParent !== currentParent;
      return toFileStat(
        await ctx.client.json(
          'drive.move',
          filesUrl(id, {
            fields: FILE_FIELDS,
            ...(reparent ? { addParents: targetParent, removeParents: currentParent } : {}),
          }),
          driveFileSchema,
          {
            method: 'PATCH',
            headers: JSON_HEADERS,
            body: JSON.stringify(name === source.name ? {} : { name }),
          },
        ),
      );
    })
    .finally(() => {
      ctx.invalidate(ref);
    });
}

export function copy(ctx: RelocateContext, ref: FileRef, options: CopyOptions): Promise<FileStat> {
  return ctx.withRef(ref, async (id) => {
    const source = await existing(ctx, id);
    if (source.isFolder) throw fatal('folders cannot be copied in v1');
    const targetParent = await resolveId(ctx, options.parent);
    const name = options.name ?? source.name;
    if ((await ctx.creates.findChildren(targetParent, name)).length > 0) {
      throw new ConflictError(`${name} already exists`);
    }
    // Sent explicitly, so the BYOS hash survives the copy without relying on Drive's defaults.
    const body = JSON.stringify({
      name,
      parents: [targetParent],
      appProperties: source.appProperties,
    });
    return createWithReconcile(
      ctx.creates,
      'drive.copy',
      targetParent,
      name,
      async () =>
        toFileStat(
          await ctx.client.jsonOnce(
            'drive.copy',
            copyUrl(id, { fields: FILE_FIELDS }),
            driveFileSchema,
            { method: 'POST', headers: JSON_HEADERS, body },
          ),
        ),
      // Nothing with this name existed before the create, so a match is our copy; the hash
      // tightens it when the source has one.
      (found) => !found.isFolder && (source.sha256 === undefined || found.sha256 === source.sha256),
    );
  });
}

export function remove(
  ctx: RelocateContext,
  ref: FileRef,
  options: DeleteOptions = {},
): Promise<void> {
  return ctx
    .withRef(ref, async (id) => {
      if (id === ctx.root || id === 'root') throw fatal('the root cannot be deleted');
      if (options.permanent) {
        await ctx.client.noContent('drive.delete', filesUrl(id, {}), { method: 'DELETE' });
        return;
      }
      await ctx.client.json('drive.trash', filesUrl(id, { fields: FILE_FIELDS }), driveFileSchema, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ trashed: true }),
      });
    })
    .finally(() => {
      ctx.invalidate(ref);
    });
}
