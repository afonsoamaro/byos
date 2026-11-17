import { describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { createProgram } from '../src/program.js';

describe('createProgram', () => {
  it('reports the package version', () => {
    expect(createProgram().version()).toBe(pkg.version);
  });

  it('names the binary in its help', () => {
    expect(createProgram().helpInformation()).toContain('byos');
  });
});
