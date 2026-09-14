import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several tests assert on rejected requests, and the error logs they produce
    // would otherwise bury the test output.
    env: { LOG_LEVEL: 'silent' },
  },
});
