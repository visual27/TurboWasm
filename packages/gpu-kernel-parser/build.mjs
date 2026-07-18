// Dual ESM + CJS + .d.ts build for @turbowasm/gpu-kernel-parser.
//
// Usage:
//   node build.mjs            # build to ./dist
//
// Mirrors the package.json `exports` map: every entry gets ESM (.js),
// CJS (.cjs) and a TypeScript declaration (.d.ts). The `tsc -p
// tsconfig.build.json` step emits the declarations; esbuild re-emits the
// runtime bundles from the same source.

import { build } from 'esbuild';
import { readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, 'dist');
const srcDir = path.join(here, 'src');

const packageJson = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));

const entryNames = Object.entries(packageJson.exports ?? {})
  .filter(([key]) => key !== './package.json')
  .map(([key, value]) => {
    const resolved = resolveExportEntry(value);
    if (!resolved) return null;
    const importPath = resolved.import ?? resolved.default;
    if (!importPath) return null;
    const local = importPath.replace(/^\.\/dist\//, '').replace(/\.js$/, '');
    return { exportKey: key, entry: path.join(srcDir, `${local}.ts`) };
  })
  .filter((value) => value !== null);

function resolveExportEntry(value) {
  if (typeof value === 'string') {
    return { import: value, require: value };
  }
  return value;
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

execFileSync(
  process.execPath,
  [path.join(here, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
  { cwd: here, stdio: 'inherit' },
);

const entries = entryNames.map(({ entry }) => entry);

await build({
  entryPoints: entries,
  outdir: distDir,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  outExtension: { '.js': '.js' },
});

await build({
  entryPoints: entries,
  outdir: distDir,
  format: 'cjs',
  target: 'es2022',
  platform: 'neutral',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  outExtension: { '.js': '.cjs' },
});

cpSync(path.join(here, 'README.md'), path.join(distDir, 'README.md'), { dereference: true });
cpSync(path.join(here, 'LICENSE'), path.join(distDir, 'LICENSE'), { dereference: true });

console.log(`[gpu-kernel-parser] built ${entries.length} entry points to ${distDir}`);
