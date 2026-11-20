import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { escapeQueryValue } from '../../src/index.js';
import { FOLDER } from './fake-drive.js';
import { setup } from './setup.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('escapeQueryValue', () => {
  it('escapes backslashes, then single quotes', () => {
    expect(escapeQueryValue("it's")).toBe("it\\'s");
    expect(escapeQueryValue('a\\b')).toBe('a\\\\b');
    expect(escapeQueryValue("\\'")).toBe("\\\\\\'");
    expect(escapeQueryValue('plain name.jpg')).toBe('plain name.jpg');
  });
});

describe('path lookup', () => {
  it("finds names with ' and \\ and sends them escaped", async () => {
    const { provider, drive } = setup({
      files: [
        { id: 'd', name: "O'Brien\\notes", parents: ['root'], mimeType: FOLDER },
        { id: 'f', name: "it's.txt", parents: ['d'], content: 'x' },
      ],
    });
    expect((await provider.stat({ path: "O'Brien\\notes/it's.txt" }))?.id).toBe('f');
    const queries = drive.requests
      .map((r) => r.url.searchParams.get('q'))
      .filter((q): q is string => q !== null);
    expect(queries).toContain(
      "'root' in parents and name = 'O\\'Brien\\\\notes' and trashed = false",
    );
    expect(queries).toContain("'d' in parents and name = 'it\\'s.txt' and trashed = false");
  });
});
