import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Store and formatting logic needs no DOM. A component test opts in with a
    // `// @vitest-environment jsdom` line, so the fast majority stays fast.
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
