import type { FileStat } from '@byos/core';

import type { DriveClient } from './client.js';
import { FILE_FIELDS, driveFileSchema, toFileStat, uploadUrl } from './files.js';
import { buildMultipart } from './upload.js';

export interface SimpleUploadOptions {
  /** Upload a new revision of this file (PATCH, retried); without it, create one (POST). */
  readonly existingId?: string;
  readonly parentId: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly appProperties: Readonly<Record<string, string>>;
}

/**
 * Multipart upload of a body already in memory (≤ 5 MiB). A create is sent once, without
 * retry: the caller wraps it in a retry that looks for the file first, since a create isn't
 * idempotent. A new revision is retried here: resending only adds the same content again.
 */
export async function simpleUpload(
  client: DriveClient,
  options: SimpleUploadOptions,
): Promise<FileStat> {
  const { existingId, parentId, name, bytes, mimeType, appProperties } = options;
  if (existingId !== undefined) {
    const { body, contentType } = buildMultipart({ mimeType, appProperties }, bytes, mimeType);
    return toFileStat(
      await client.json(
        'drive.put',
        uploadUrl(existingId, { uploadType: 'multipart', fields: FILE_FIELDS }),
        driveFileSchema,
        { method: 'PATCH', headers: { 'content-type': contentType }, body },
      ),
    );
  }
  const { body, contentType } = buildMultipart(
    { name, parents: [parentId], mimeType, appProperties },
    bytes,
    mimeType,
  );
  return toFileStat(
    await client.jsonOnce(
      'drive.put',
      uploadUrl(undefined, { uploadType: 'multipart', fields: FILE_FIELDS }),
      driveFileSchema,
      { method: 'POST', headers: { 'content-type': contentType }, body },
    ),
  );
}
