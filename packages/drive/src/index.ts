import { PACKAGE_NAME as CORE } from '@byos/core';

export const PACKAGE_NAME = '@byos/drive';

/** Packages this one builds on. Exercises the workspace link until real code lands. */
export const REQUIRES: readonly string[] = [CORE];
