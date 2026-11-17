import { builtinModules } from 'node:module';

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const NODE_FREE =
  'core and drive must run outside Node (React Native, browser): no Node built-ins.';

// Prettier formats, ESLint judges: eslint-config-prettier only switches off the rules that
// would fight the formatter, and `prettier --check` runs inside `pnpm lint`.
export default defineConfig(
  {
    ignores: ['**/dist/**', '**/coverage/**', '.claude/**', 'docs/history/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Portability guard, layer 2 of 3 (the tsconfig without Node types and the browser
    // bundle test in tests/portability.test.ts are the other two).
    files: ['packages/core/src/**/*.ts', 'packages/drive/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.map((name) => ({ name, message: NODE_FREE })),
          patterns: [{ group: ['node:*'], message: NODE_FREE }],
        },
      ],
    },
  },
  {
    // Config files sit outside every tsconfig; lint them without type information.
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
