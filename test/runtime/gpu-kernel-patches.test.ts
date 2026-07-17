import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for `patches/vendored/gpu-kernel-{list-binding,runtime}+0.1.0.patch`.
 *
 * These patches add the four list/scalar accessor APIs to vendored
 * scratch-vm's runtime.js, plus the per-primitive GPU hook
 * (`__turboWasmGpuKernelDispatch`) to scratch3_control.js's repeat /
 * repeatUntil / repeatWhile. The hook is only consulted when
 * `globalThis.__turboWasmGpuKernelDispatch` is installed at runtime — for
 * a normal load it's a no-op, so we keep the patch scope tight.
 *
 * Same staleness-vs-UMD guard used by `wasm-collision-runtime-patch.test.ts`:
 * when the UMD is older than the patch files, skip the UMD-side checks to
 * avoid forcing every developer to run `npm run setup -- --force`.
 */
const LIST_BINDING_PATCH = resolve(
  process.cwd(),
  'patches/vendored/gpu-kernel-list-binding+0.1.0.patch',
);
const RUNTIME_PATCH = resolve(
  process.cwd(),
  'patches/vendored/gpu-kernel-runtime+0.1.0.patch',
);
const SCRATCH_VM_RUNTIME = resolve(
  process.cwd(),
  'vendored/scratch-vm/src/engine/runtime.js',
);
const SCRATCH_VM_CONTROL = resolve(
  process.cwd(),
  'vendored/scratch-vm/src/blocks/scratch3_control.js',
);
const VENDORED_SCAFFOLDING_UMD = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

function isUmdStale(): boolean {
  const candidates = [LIST_BINDING_PATCH, RUNTIME_PATCH];
  if (!existsSync(VENDORED_SCAFFOLDING_UMD)) return false;
  const umdMtime = statSync(VENDORED_SCAFFOLDING_UMD).mtimeMs;
  for (const patch of candidates) {
    if (!existsSync(patch)) continue;
    if (statSync(patch).mtimeMs > umdMtime) return true;
  }
  return false;
}

describe('gpu-kernel-list-binding patch', () => {
  it('the patch file exists', () => {
    expect(existsSync(LIST_BINDING_PATCH), `patch file missing: ${LIST_BINDING_PATCH}`).toBe(true);
  });

  it('extends vendored scratch-vm runtime.js with __getListBuffer', () => {
    if (!existsSync(SCRATCH_VM_RUNTIME)) return;
    const src = readFileSync(SCRATCH_VM_RUNTIME, 'utf8');
    expect(src, 'runtime.js should expose __getListBuffer').toMatch(/__getListBuffer\s*\(/);
  });

  it('extends vendored scratch-vm runtime.js with __getListBufferById', () => {
    if (!existsSync(SCRATCH_VM_RUNTIME)) return;
    const src = readFileSync(SCRATCH_VM_RUNTIME, 'utf8');
    expect(src, 'runtime.js should expose __getListBufferById').toMatch(/__getListBufferById\s*\(/);
  });

  it('extends vendored scratch-vm runtime.js with __getScalarValue', () => {
    if (!existsSync(SCRATCH_VM_RUNTIME)) return;
    const src = readFileSync(SCRATCH_VM_RUNTIME, 'utf8');
    expect(src, 'runtime.js should expose __getScalarValue').toMatch(/__getScalarValue\s*\(/);
  });

  it('extends vendored scratch-vm runtime.js with __setScalarValue', () => {
    if (!existsSync(SCRATCH_VM_RUNTIME)) return;
    const src = readFileSync(SCRATCH_VM_RUNTIME, 'utf8');
    expect(src, 'runtime.js should expose __setScalarValue').toMatch(/__setScalarValue\s*\(/);
  });
});

describe('gpu-kernel-runtime patch', () => {
  it('the patch file exists', () => {
    expect(existsSync(RUNTIME_PATCH), `patch file missing: ${RUNTIME_PATCH}`).toBe(true);
  });

  it('installs the __turboWasmGpuKernelDispatch hook in scratch3_control.js (repeat)', () => {
    if (!existsSync(SCRATCH_VM_CONTROL)) return;
    const src = readFileSync(SCRATCH_VM_CONTROL, 'utf8');
    expect(
      src,
      'scratch3_control.js should consult __turboWasmGpuKernelDispatch in repeat()',
    ).toMatch(/__turboWasmGpuKernelDispatch/);
  });

  it('UMD contains the GPU kernel dispatch hook symbol', () => {
    if (isUmdStale() || !existsSync(VENDORED_SCAFFOLDING_UMD)) return;
    const src = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(
      src,
      'UMD should have __turboWasmGpuKernelDispatch baked in',
    ).toMatch(/__turboWasmGpuKernelDispatch/);
  });

  it('UMD contains the GPU list buffer accessor symbols', () => {
    if (isUmdStale() || !existsSync(VENDORED_SCAFFOLDING_UMD)) return;
    const src = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(src, 'UMD should have __getListBuffer symbol').toMatch(/__getListBuffer/);
    expect(src, 'UMD should have __getScalarValue symbol').toMatch(/__getScalarValue/);
  });
});
