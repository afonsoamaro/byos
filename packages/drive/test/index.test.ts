import { describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { PACKAGE_NAME, REQUIRES } from '../src/index.js';

describe('@byos/drive entry', () => {
  it('exports its own package name', () => {
    expect(PACKAGE_NAME).toBe(pkg.name);
  });

  it('resolves @byos/core through the workspace', () => {
    expect(REQUIRES).toContain('@byos/core');
  });
});
