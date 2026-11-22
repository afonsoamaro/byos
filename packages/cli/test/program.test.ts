import { afterEach, describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { createProgram } from '../src/program.js';
import { cleanup, harness } from './helpers.js';

afterEach(cleanup);

describe('createProgram', () => {
  it('reports the package version', async () => {
    const { io } = await harness();
    expect(createProgram(io).version()).toBe(pkg.version);
  });

  it('names the binary in its help', async () => {
    const { io } = await harness();
    expect(createProgram(io).helpInformation()).toContain('byos');
  });
});
