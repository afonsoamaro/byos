import {
  ConflictError,
  retry,
  type ByosEvents,
  type FileStat,
  type RetryOptions,
} from '@byos/core';

import type { DriveClient } from './client.js';
import { FILE_FIELDS, FOLDER_MIME, driveFileSchema, filesUrl, toFileStat } from './files.js';

export interface CreateContext {
  readonly client: DriveClient;
  /** Children of `parentId` named `name` (the provider's Drive name query). */
  readonly findChildren: (parentId: string, name: string) => Promise<FileStat[]>;
  readonly events?: ByosEvents | undefined;
  readonly retry?: RetryOptions | undefined;
}

/**
 * Creates are not idempotent: if Drive created the item but the response was lost, a plain
 * retry would make a duplicate. So from the second attempt on, look for it first.
 */
export function createWithReconcile(
  ctx: CreateContext,
  operation: string,
  parentId: string,
  name: string,
  create: () => Promise<FileStat>,
  matches: (found: FileStat) => boolean,
): Promise<FileStat> {
  const onRetry = ctx.events?.onRetry;
  return retry(
    async (attempt) => {
      if (attempt > 1) {
        const hit = (await ctx.findChildren(parentId, name)).find(matches);
        if (hit) return hit;
      }
      return create();
    },
    { operation, ...(onRetry === undefined ? {} : { onRetry }), ...ctx.retry },
  );
}

/** Finds or creates folders; concurrent calls for the same parent and name share one creation. */
export class FolderMaker {
  readonly #ctx: CreateContext;
  /** In-flight folder creations by `parentId/name`. */
  readonly #ensuring = new Map<string, Promise<FileStat>>();

  constructor(ctx: CreateContext) {
    this.#ctx = ctx;
  }

  ensure(parentId: string, name: string): Promise<FileStat> {
    const key = `${parentId}/${name}`;
    let pending = this.#ensuring.get(key);
    if (!pending) {
      pending = this.#findOrCreate(parentId, name).finally(() => {
        this.#ensuring.delete(key);
      });
      this.#ensuring.set(key, pending);
    }
    return pending;
  }

  async #findOrCreate(parentId: string, name: string): Promise<FileStat> {
    const [existing, ...others] = await this.#ctx.findChildren(parentId, name);
    if (others.length > 0) throw new ConflictError(`more than one item named ${name}`);
    if (existing) {
      if (!existing.isFolder) throw new ConflictError(`${name} exists and is not a folder`);
      return existing;
    }
    return createWithReconcile(
      this.#ctx,
      'drive.mkdir',
      parentId,
      name,
      async () =>
        toFileStat(
          await this.#ctx.client.jsonOnce(
            'drive.mkdir',
            filesUrl(undefined, { fields: FILE_FIELDS }),
            driveFileSchema,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json; charset=UTF-8' },
              body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
            },
          ),
        ),
      (found) => found.isFolder,
    );
  }
}
