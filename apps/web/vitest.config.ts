import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Store and formatting logic needs no DOM. A component test opts in with a
    // `// @vitest-environment jsdom` line, so the fast majority stays fast.
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // The wait budget for findBy/waitFor, and why it is not one second.
    setupFiles: ['test/waitBudget.ts'],
    // Above several waits of that budget, so Testing Library reports first.
    testTimeout: 30_000,
  },
});
