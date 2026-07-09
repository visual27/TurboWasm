/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Mirror the `@` alias for fixture-generator scripts that live
      // outside of `src/`. The `ensure-test-fixtures` test imports
      // `scripts/ensure-test-fixtures.mjs` (and indirectly all the other
      // generator scripts) using `@/../scripts/...` for symmetry with
      // existing test imports.
      '@/../scripts': path.resolve(__dirname, './scripts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
});
