import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', '**/.venv/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  { files: ['src/**'], languageOptions: { globals: globals.browser } },
  { files: ['test/**', 'scripts/**', '*.config.{js,ts}'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
);
