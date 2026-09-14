import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Store logic is plain MobX with the API client mocked, so no DOM is needed.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
