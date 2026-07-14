#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const wasmDir = resolve(root, 'wasm-collision');
const cargoToml = resolve(wasmDir, 'Cargo.toml');
const pkgDir = resolve(wasmDir, 'pkg');
const wasmArtifact = resolve(pkgDir, 'tw_viewer_wasm_collision_bg.wasm');
const jsStub = resolve(pkgDir, 'tw_viewer_wasm_collision.js');
const dtsStub = resolve(pkgDir, 'tw_viewer_wasm_collision.d.ts');
const stampFile = resolve(pkgDir, '.last-build');

// ---------------------------------------------------------------------------
// Stub fallback (no Rust toolchain available).
//
// Cloudflare Pages (and most static-host CI environments) do not ship
// `cargo` / `wasm-pack`. When this script detects that, it materialises
// no-op `pkg/tw_viewer_wasm_collision.js` and `.d.ts` files at build
// time so the upstream
// `import '../../../wasm-collision/pkg/tw_viewer_wasm_collision'` in
// `src/runtime/tw-wasm/wasm-collision-client.ts` still resolves to a
// typecheckable, bundleable module. The runtime code already treats
// `wasmMemory === null` as the "use the JS fallback path" sentinel, so
// the observable behavior is identical to `performanceMode: 'legacy-only'`
// (the Definition-of-Done parity mode documented in README.md).
//
// These generated files live under `wasm-collision/pkg/` which is
// `.gitignore`'d — they are build-time artifacts and never get committed
// to the repo. A subsequent `wasm-pack build` overwrites them.
// ---------------------------------------------------------------------------

// Mirror of the wasm-bindgen-generated export surface for
// `wasm-collision/pkg/tw_viewer_wasm_collision`. Embedded as a string so
// this script is the single source of truth for both the JS stub and its
// `.d.ts`. Stay in lockstep with the real generated artifacts produced by
// `wasm-pack build` (see wasm-collision/pkg/tw_viewer_wasm_collision.d.ts
// after running the real build).
const STUB_DTS = `/* tslint:disable */
/* eslint-disable */
/* Auto-generated stub type declarations for environments without
   wasm-pack (e.g. Cloudflare Pages). Real declarations are produced
   by wasm-bindgen at wasm-pack build time. */

export class SilhouetteBuffer {
    free(): void;
    [Symbol.dispose](): void;
    clear(): void;
    data_ptr(): number;
    height(): number;
    constructor(width: number, height: number);
    width(): number;
}

export function batch_touching_color(bounds_left: number, bounds_right: number, bounds_bottom: number, bounds_top: number, target_r: number, target_g: number, target_b: number, mask_r: number, mask_g: number, mask_b: number, self_inv: Float32Array, self_sil: SilhouetteBuffer, cand_inv: Float32Array, cand_sil_offsets: Uint32Array, cand_sil_dims: Uint32Array, cand_sil_count: number, use_linear: number): number;

export function batch_touching_drawables(bounds_left: number, bounds_right: number, bounds_bottom: number, bounds_top: number, self_inv: Float32Array, self_sil: SilhouetteBuffer, cand_inv: Float32Array, cand_sil_offsets: Uint32Array, cand_sil_dims: Uint32Array, cand_sil_count: number, use_linear: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_silhouettebuffer_free: (a: number, b: number) => void;
    readonly batch_touching_color: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number) => number;
    readonly batch_touching_drawables: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => number;
    readonly silhouettebuffer_clear: (a: number) => void;
    readonly silhouettebuffer_data_ptr: (a: number) => number;
    readonly silhouettebuffer_height: (a: number) => number;
    readonly silhouettebuffer_new: (a: number, b: number) => number;
    readonly silhouettebuffer_width: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given \`module\`, which can either be bytes or
 * a precompiled \`WebAssembly.Module\`.
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If \`module_or_path\` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls \`WebAssembly.instantiate\` directly.
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
`;

// No-op ESM module providing the same exports as the wasm-pack output.
// `init()` returns `{ memory: null }` so the runtime code falls through
// to the JS fallback path (legacy-only equivalent). All function exports
// are no-ops; the runtime never calls them in the stub path because
// `isWasmCollisionReady()` (which checks `wasmMemory !== null`) returns
// false.
const STUB_JS = `// Auto-generated stub for environments without wasm-pack
// (e.g. Cloudflare Pages). The runtime treats \`memory: null\` as the
// "WASM unavailable" sentinel and falls through to the JS fallback path,
// which is behaviorally identical to \`performanceMode: 'legacy-only'\`.
//
// This file is overwritten whenever a real \`wasm-pack build\` runs;
// the regenerated artifacts take precedence and the stub is discarded.

export class SilhouetteBuffer {
  constructor(_width, _height) {
    // intentional no-op
  }
  free() {}
  clear() {}
  data_ptr() { return 0; }
  width() { return 0; }
  height() { return 0; }
  [Symbol.dispose]() {}
}

export function batch_touching_color() {
  return 0;
}

export function batch_touching_drawables() {
  return 0;
}

function stubInitOutput() {
  return {
    memory: null,
    __wbg_silhouettebuffer_free: () => {},
    batch_touching_color: () => 0,
    batch_touching_drawables: () => 0,
    silhouettebuffer_clear: () => {},
    silhouettebuffer_data_ptr: () => 0,
    silhouettebuffer_height: () => 0,
    silhouettebuffer_new: () => 0,
    silhouettebuffer_width: () => 0,
    __wbindgen_externrefs: null,
    __wbindgen_malloc: () => 0,
    __wbindgen_start: () => {},
  };
}

export function initSync() {
  return stubInitOutput();
}

export default async function __wbg_init() {
  return stubInitOutput();
}
`;

function writeStub() {
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(jsStub, STUB_JS, 'utf8');
  writeFileSync(dtsStub, STUB_DTS, 'utf8');
  writeFileSync(stampFile, new Date().toISOString(), 'utf8');
}

// ---------------------------------------------------------------------------
// Build flow.
// ---------------------------------------------------------------------------

if (!existsSync(cargoToml)) {
  console.warn('[build-wasm] wasm-collision/Cargo.toml not found; skipping WASM build.');
  process.exit(0);
}

const isDev = process.argv.includes('--dev');
const forceStub = process.argv.includes('--stub');

if (forceStub) {
  writeStub();
  console.log('[build-wasm] --stub: pkg/ populated with no-op JS/TS stubs.');
  console.log('[build-wasm] TurboWasm WASM collision detection will be disabled (JS fallback).');
  process.exit(0);
}

if (!isDev && existsSync(wasmArtifact)) {
  if (existsSync(stampFile)) {
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
  console.warn(
    '[build-wasm] no pkg/ artifact and no wasm-pack; generating no-op stub so the build can proceed.',
  );
  writeStub();
  console.log('[build-wasm] stub pkg/ written at', pkgDir);
  process.exit(0);
}

const args = ['build', wasmDir, isDev ? '--dev' : '--release', '--target', 'web', '--out-dir', 'pkg'];
console.log(`[build-wasm] running wasm-pack ${args.join(' ')}`);
const result = spawnSync('wasm-pack', args, { stdio: 'inherit', shell: false });
if (result.status !== 0) {
  console.error('[build-wasm] wasm-pack build failed.');
  process.exit(result.status ?? 1);
}

writeFileSync(stampFile, new Date().toISOString());

console.log('[build-wasm] wasm artifact ready at', wasmArtifact);
