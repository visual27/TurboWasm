#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const wasmDir = resolve(root, 'wasm-collision');
const cargoToml = resolve(wasmDir, 'Cargo.toml');
const pkgDir = resolve(wasmDir, 'pkg');
const wasmArtifact = resolve(pkgDir, 'tw_viewer_wasm_collision_bg.wasm');

if (!existsSync(cargoToml)) {
  console.warn('[build-wasm] wasm-collision/Cargo.toml not found; skipping WASM build.');
  process.exit(0);
}

const isDev = process.argv.includes('--dev');

if (!isDev && existsSync(wasmArtifact)) {
  const stamp = resolve(pkgDir, '.last-build');
  if (existsSync(stamp)) {
    console.log('[build-wasm] cached wasm artifact present; skipping rebuild.');
    process.exit(0);
  }
}

const wasmPack = spawnSync('wasm-pack', ['--version'], { encoding: 'utf8' });
if (wasmPack.status !== 0) {
  console.warn('[build-wasm] wasm-pack is not installed.');
  if (existsSync(wasmArtifact)) {
    console.warn('[build-wasm] using existing pkg/ artifact (likely stale).');
    process.exit(0);
  }
  console.error(
    '[build-wasm] No wasm artifact available. Install wasm-pack via `cargo install wasm-pack` ' +
      'and re-run, or pre-build wasm-collision/pkg/. Aborting.',
  );
  process.exit(1);
}

const args = ['build', wasmDir, isDev ? '--dev' : '--release', '--target', 'web', '--out-dir', 'pkg'];
console.log(`[build-wasm] running wasm-pack ${args.join(' ')}`);
const result = spawnSync('wasm-pack', args, { stdio: 'inherit', shell: false });
if (result.status !== 0) {
  console.error('[build-wasm] wasm-pack build failed.');
  process.exit(result.status ?? 1);
}

const stamp = resolve(pkgDir, '.last-build');
writeFileSync(stamp, new Date().toISOString());

console.log('[build-wasm] wasm artifact ready at', wasmArtifact);
