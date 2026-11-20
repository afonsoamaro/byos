const BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  json: 'application/json',
  txt: 'text/plain',
};

/** MIME type from the file name's extension; `application/octet-stream` when unknown. */
export function mimeTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(BY_EXTENSION, extension)
    ? (BY_EXTENSION[extension] ?? 'application/octet-stream')
    : 'application/octet-stream';
}
