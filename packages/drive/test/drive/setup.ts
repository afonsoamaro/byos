import type { ByosEvents, StoredToken, TokenStore } from '@byos/core';

import { DriveProvider, TokenManager } from '../../src/index.js';
import { fakeGoogle, tokenReply, type FakeReply } from '../oauth/fake-google.js';
import { fakeDrive, type FakeFile } from './fake-drive.js';

export const NOW = Date.UTC(2026, 10, 20);

export function setup(
  options: {
    files?: FakeFile[];
    oauth?: FakeReply[];
    events?: ByosEvents;
    random?: boolean;
    chunkSize?: number;
  } = {},
) {
  const tokens = new Map<string, StoredToken>([
    [
      'me',
      {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: NOW + 3_600_000,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
        consentedAt: NOW - 86_400_000,
      },
    ],
  ]);
  const store: TokenStore = {
    load: (key) => Promise.resolve(tokens.get(key)),
    save: (key, token) => {
      tokens.set(key, token);
      return Promise.resolve();
    },
    clear: (key) => {
      tokens.delete(key);
      return Promise.resolve();
    },
  };
  const google = fakeGoogle(options.oauth ?? [tokenReply('access-2')]);
  const manager = new TokenManager({
    store,
    key: 'me',
    clientId: 'client',
    fetch: google.fetch,
    now: () => NOW,
    retry: { random: () => 0 },
  });
  const drive = fakeDrive(options.files);
  const provider = new DriveProvider({
    tokens: manager,
    fetch: drive.fetch,
    ...(options.events ? { events: options.events } : {}),
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
    ...(options.random === false ? {} : { retry: { random: () => 0 } }),
  });
  return { provider, drive, google, manager };
}
