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

// Every public entry point of the Node-free packages, as `<package>/<path inside dist>`.
const ENTRIES = ['core/index', 'core/testing/index', 'drive/index'];

const entry = (name: string) => {
  const [pkg, ...rest] = name.split('/');
  return fileURLToPath(
    new URL(`../packages/${pkg ?? ''}/dist/${rest.join('/')}.js`, import.meta.url),
  );
};

describe('core and drive entry points bundle for the browser', () => {
  it.each(ENTRIES)('%s has no Node imports', async (name) => {
    const result = await build({ ...options, entryPoints: [entry(name)] });
    expect(result.errors).toEqual([]);
  });

  it('rejects a Node import (the guard bites)', async () => {
    await expect(
      build({ ...options, stdin: { contents: "import 'node:fs';", resolveDir: '.' } }),
    ).rejects.toThrow(/node:fs/);
  });
});
