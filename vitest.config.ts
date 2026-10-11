import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The integration server's Python virtualenv is in `test/`, and thousands of files long.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.venv/**'],
    // The integration tests start a real pg-sse server and wait on its clocks (an age limit, a goodbye delay).
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'html'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
