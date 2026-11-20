import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { driveError, FOLDER } from './fake-drive.js';
import { setup } from './setup.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hook events', () => {
  it('carry the operation and attempt, never a token, header or URL', async () => {
    const payloads: unknown[] = [];
    const events = {
      onRequest: (event: unknown) => payloads.push(event),
      onRetry: (event: unknown) => payloads.push(event),
    };
    const { provider, drive } = setup({
      events,
      files: [
        { id: 'd', name: 'dir', parents: ['root'], mimeType: FOLDER },
        { id: 'f', name: 'a.txt', parents: ['d'], content: 'x' },
      ],
    });
    await provider.list({ parent: { id: 'd' } });
    await provider.stat({ path: 'dir/a.txt' });
    await provider.get({ id: 'f' });
    drive.failNext(/\/files\/d\?/, driveError(429));
    await provider.list({ parent: { id: 'd' } });
    drive.state.validToken = 'access-2';
    await provider.stat({ id: 'f' });

    // Control: the capture saw requests and a retry, so the absence below means something.
    expect(payloads.length).toBeGreaterThanOrEqual(5);
    expect(payloads).toContainEqual(expect.objectContaining({ operation: 'drive.list' }));
    expect(payloads).toContainEqual(expect.objectContaining({ code: 'RATE_LIMITED' }));

    const text = JSON.stringify(payloads);
    for (const forbidden of ['access-1', 'access-2', 'Bearer', 'authorization', 'googleapis.com']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
