import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@turbowarp/scaffolding': path.resolve(
        __dirname,
        './vendored/scaffolding/dist/scaffolding-min.js',
      ),
    },
  },
  optimizeDeps: {
    // The vendored scaffolding-min.js is a UMD bundle. Pre-bundle it with
    // esbuild so the dynamic `import('@turbowarp/scaffolding')` from
    // src/lib/scaffolding.ts gets a proper ESM module namespace with named
    // exports (Scaffolding, CloudVariables, Packages). Without this, Vite
    // loads the UMD file directly and `mod.Scaffolding` is undefined.
    include: ['@turbowarp/scaffolding'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          scaffolding: ['@turbowarp/scaffolding'],
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
