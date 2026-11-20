import { describe, expect, it } from 'vitest';

import { mimeTypeFor } from '../../src/index.js';
import { buildMultipart, readBody, sha256Hex, SIMPLE_UPLOAD_LIMIT } from '../../src/api/upload.js';
import { parseMultipart } from './fake-drive.js';

const text = (value: string) => new TextEncoder().encode(value);

describe('sha256Hex', () => {
  it('matches known vectors', async () => {
    expect(await sha256Hex(text('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('buildMultipart', () => {
  it('writes the metadata part, then the exact bytes, framed by the boundary', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x41]);
    const { body, contentType } = buildMultipart(
      { name: 'a.bin', parents: ['p'] },
      bytes,
      'image/jpeg',
    );
    const boundary = /boundary=(byos-[0-9a-f]{24})$/.exec(contentType)?.[1];
    expect(contentType.startsWith('multipart/related; boundary=')).toBe(true);
    expect(boundary).toBeDefined();
    const raw = new TextDecoder('latin1').decode(body);
    expect(
      raw.startsWith(
        `--${String(boundary)}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      ),
    ).toBe(true);
    expect(raw.endsWith(`\r\n--${String(boundary)}--`)).toBe(true);
    const parts = parseMultipart(body, contentType);
    expect(parts.metadata).toEqual({ name: 'a.bin', parents: ['p'] });
    expect(parts.mimeType).toBe('image/jpeg');
    expect([...parts.bytes]).toEqual([...bytes]);
  });

  it('uses a new boundary every time', () => {
    const a = buildMultipart({}, new Uint8Array(), 'text/plain').contentType;
    const b = buildMultipart({}, new Uint8Array(), 'text/plain').contentType;
    expect(a).not.toBe(b);
  });
});

describe('readBody', () => {
  it('reads all three body kinds', async () => {
    expect([...(await readBody(text('hi')))]).toEqual([104, 105]);
    expect([...(await readBody(new Blob([text('hi')])))]).toEqual([104, 105]);
    expect([...(await readBody(new Blob([text('h'), text('i')]).stream(), 2))]).toEqual([104, 105]);
  });

  it('refuses unknown or too large sizes before reading, and a size mismatch', async () => {
    const stream = new Blob([text('hi')]).stream();
    await expect(readBody(stream)).rejects.toThrow(/resumable/);
    await expect(readBody(text('hi'), SIMPLE_UPLOAD_LIMIT + 1)).rejects.toThrow(/resumable/);
    await expect(readBody(new Uint8Array(SIMPLE_UPLOAD_LIMIT + 1))).rejects.toThrow(/resumable/);
    await expect(readBody(text('hi'), 3)).rejects.toThrow(/2 bytes but size says 3/);
  });
});

describe('mimeTypeFor', () => {
  it.each([
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['IMG.JPG', 'image/jpeg'],
    ['a.png', 'image/png'],
    ['a.heic', 'image/heic'],
    ['a.heif', 'image/heif'],
    ['a.webp', 'image/webp'],
    ['a.gif', 'image/gif'],
    ['a.mp4', 'video/mp4'],
    ['a.mov', 'video/quicktime'],
    ['a.pdf', 'application/pdf'],
    ['a.json', 'application/json'],
    ['a.txt', 'text/plain'],
    ['archive.tar.gz', 'application/octet-stream'],
    ['README', 'application/octet-stream'],
    ['.hidden', 'application/octet-stream'],
  ])('%s → %s', (name, type) => {
    expect(mimeTypeFor(name)).toBe(type);
  });
});
