/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@turbowasm/gpu-kernel-parser': path.resolve(__dirname, './src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.{test,spec}.ts'],
  },
});
