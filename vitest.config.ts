import { defineConfig } from 'vitest/config';

// Root project: cross-package tests only. Each package runs its own tests.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
