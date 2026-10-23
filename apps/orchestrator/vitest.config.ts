import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several tests assert on rejected requests, and the error logs they produce
    // would otherwise bury the test output.
    env: { LOG_LEVEL: 'silent' },
    // Half the cores: `pnpm -r test` runs the web suite beside this one, and
    // its jsdom tests time out when the two together oversubscribe the CPU.
    maxWorkers: '50%',
    // Vitest 2 defaults the minimum to the full count and refuses a lower maximum.
    minWorkers: 1,
  },
});
