import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Store and formatting logic needs no DOM. A component test opts in with a
    // `// @vitest-environment jsdom` line, so the fast majority stays fast.
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Half the cores, not all but one: `pnpm -r test` runs this suite and the
    // orchestrator's at once, and two suites each starting a worker per core
    // starved the jsdom tests past Testing Library's one-second findBy budget.
    maxWorkers: '50%',
    // Vitest 2 defaults the minimum to the full count and refuses a lower maximum.
    minWorkers: 1,
  },
});
