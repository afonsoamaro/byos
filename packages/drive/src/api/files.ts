import type { FileStat } from '@byos/core';
import { z } from 'zod';

export const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Google Docs, Sheets, Slides and other native types: no binary content to download. */
export const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
/** Partial response: only what `FileStat` needs. */
export const FILE_FIELDS =
  'id,name,parents,mimeType,size,modifiedTime,createdTime,md5Checksum,appProperties,trashed';

export const driveFileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  parents: z.array(z.string()).optional(),
  mimeType: z.string(),
  /** Drive sends int64 values as strings. */
  size: z.string().regex(/^\d+$/).optional(),
  modifiedTime: z.string().optional(),
  createdTime: z.string().optional(),
  md5Checksum: z.string().optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
  trashed: z.boolean().optional(),
});

export type DriveFile = z.infer<typeof driveFileSchema>;

export const listResponseSchema = z.object({
  files: z.array(driveFileSchema),
  nextPageToken: z.string().optional(),
});

/** `files/<id>` (or the collection) with query parameters. */
export function filesUrl(id: string | undefined, params: Record<string, string>): string {
  const url = new URL(id === undefined ? FILES_URL : `${FILES_URL}/${encodeURIComponent(id)}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

const SHA256 = /^[0-9a-f]{64}$/;

export function toFileStat(file: DriveFile): FileStat {
  const appProperties = file.appProperties ?? {};
  const sha256 = appProperties.byosSha256;
  return {
    id: file.id,
    name: file.name,
    parents: file.parents ?? [],
    isFolder: file.mimeType === FOLDER_MIME,
    mimeType: file.mimeType,
    ...(file.size === undefined ? {} : { size: Number(file.size) }),
    ...(file.modifiedTime === undefined ? {} : { modifiedAt: file.modifiedTime }),
    ...(file.createdTime === undefined ? {} : { createdAt: file.createdTime }),
    ...(file.md5Checksum === undefined ? {} : { md5: file.md5Checksum }),
    ...(sha256 !== undefined && SHA256.test(sha256) ? { sha256 } : {}),
    appProperties,
  };
}

export const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

/** `upload/drive/v3/files[/<id>]` with query parameters. */
export function uploadUrl(id: string | undefined, params: Record<string, string>): string {
  const url = new URL(id === undefined ? UPLOAD_URL : `${UPLOAD_URL}/${encodeURIComponent(id)}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
