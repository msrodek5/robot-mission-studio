import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live outside src/ so the sim core stays free of test imports.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
