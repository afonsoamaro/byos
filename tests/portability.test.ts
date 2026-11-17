import { fileURLToPath } from 'node:url';

import { build, type BuildOptions } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Portability guard, layer 3 of 3: bundle the built output for a browser target. This catches
// a Node import that arrives through a dependency, which the tsconfig and the lint rule can't see.
const options = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  logLevel: 'silent',
} satisfies BuildOptions;

const entry = (pkg: string) =>
  fileURLToPath(new URL(`../packages/${pkg}/dist/index.js`, import.meta.url));

describe('core and drive bundle for the browser', () => {
  it.each(['core', 'drive'])('%s has no Node imports', async (pkg) => {
    const result = await build({ ...options, entryPoints: [entry(pkg)] });
    expect(result.errors).toEqual([]);
  });

  it('rejects a Node import (the guard bites)', async () => {
    await expect(
      build({ ...options, stdin: { contents: "import 'node:fs';", resolveDir: '.' } }),
    ).rejects.toThrow(/node:fs/);
  });
});
