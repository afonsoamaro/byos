import { describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { PACKAGE_NAME } from '../src/index.js';

describe('@byos/core entry', () => {
  it('exports its own package name', () => {
    expect(PACKAGE_NAME).toBe(pkg.name);
  });
});
