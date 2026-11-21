import { describe, it } from 'vitest';

import { MemoryProvider, storageContract } from '../src/testing/index.js';

// The in-memory fake is the reference: the shared contract has to pass on it as written.
describe('storage contract on MemoryProvider', () => {
  for (const contractCase of storageContract()) {
    it(contractCase.name, () => contractCase.run({ provider: new MemoryProvider() }));
  }
});
