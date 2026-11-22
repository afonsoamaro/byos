import process from 'node:process';

import { defineConfig } from 'vitest/config';

// The defaults stay. On a machine that is busy with something else, `BYOS_TEST_TIMEOUT=<ms>`
// gives the heavy resumable-upload tests (50 MiB through the fake Drive) room to finish.
export default defineConfig({
  test: { testTimeout: Number(process.env.BYOS_TEST_TIMEOUT) || 5000 },
});
