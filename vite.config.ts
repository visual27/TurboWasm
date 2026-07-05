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
    exclude: ['@tw-viewer/wasm-collision'],
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (id.includes('@turbowarp/scaffolding')) return 'scaffolding';
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react-vendor';
          }
          if (
            id.includes('node_modules/@radix-ui/') &&
            !id.includes('node_modules/@radix-ui/react-popover')
          ) {
            return 'radix-vendor';
          }
          return undefined;
        },
      },
    },
  },
});
