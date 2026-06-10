import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000, // git operations in temp repos can be slow on CI
    hookTimeout: 30000,
  },
});
