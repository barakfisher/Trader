import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite stubs global fetch; it must never reach a network or a service.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
