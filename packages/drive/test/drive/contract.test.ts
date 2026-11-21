import { storageContract } from '@byos/core/testing';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { setup } from './setup.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The same cases the in-memory fake passes, run against DriveProvider and the Drive fake.
describe('storage contract on DriveProvider', () => {
  for (const contractCase of storageContract()) {
    it(contractCase.name, () => contractCase.run({ provider: setup().provider }));
  }
});
