import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          'scaffolding': ['@turbowarp/scaffolding'],
          'react-vendor': ['react', 'react-dom'],
          'radix-vendor': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-label',
            '@radix-ui/react-slider',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-separator',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-slot',
          ],
        },
      },
    },
  },
});