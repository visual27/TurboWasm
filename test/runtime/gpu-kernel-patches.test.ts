import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for `patches/vendored/gpu-kernel-runtime+0.1.0.patch`.
 *
 * This patch installs the per-primitive GPU hook
 * (`__turboWasmGpuKernelDispatch`) to scratch3_control.js's repeat /
 * repeatUntil / repeatWhile. The hook is only consulted when
 * `globalThis.__turboWasmGpuKernelDispatch` is installed at runtime — for
 * a normal load it's a no-op, so we keep the patch scope tight.
 *
 * The list/scalar buffer accessor APIs (`__getListBuffer*`,
 * `__setListBuffer*`, `__getScalarValue`, `__setScalarValue`) used to
 * live in a separate `patches/vendored/gpu-kernel-list-binding+0.1.0.patch`
 * but were absorbed into `patches/vendored/scratch-vm.patch` at commit
 * `263378e` (see AGENTS.md "SCRATCH_VM_REF の pin"). They are now covered
 * by `test/runtime/scratch-vm-patches-symbols.test.ts` via the
 * `// TurboWasm: list / scalar buffer accessors` marker.
 *
 * Same staleness-vs-UMD guard used by `wasm-collision-runtime-patch.test.ts`:
 * when the UMD is older than the patch file, skip the UMD-side checks to
 * avoid forcing every developer to run `npm run setup -- --force`.
 */
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
  const candidates = [RUNTIME_PATCH];
  if (!existsSync(VENDORED_SCAFFOLDING_UMD)) return false;
  const umdMtime = statSync(VENDORED_SCAFFOLDING_UMD).mtimeMs;
  for (const patch of candidates) {
    if (!existsSync(patch)) continue;
    if (statSync(patch).mtimeMs > umdMtime) return true;
  }
  return false;
}

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

  it('runtime.js carries the list/scalar accessor APIs via scratch-vm.patch (no standalone patch)', () => {
    if (!existsSync(SCRATCH_VM_RUNTIME)) return;
    const src = readFileSync(SCRATCH_VM_RUNTIME, 'utf8');
    expect(src, 'runtime.js should expose __getListBuffer').toMatch(/__getListBuffer\s*\(/);
    expect(src, 'runtime.js should expose __getListBufferById').toMatch(/__getListBufferById\s*\(/);
    expect(src, 'runtime.js should expose __setListBuffer').toMatch(/__setListBuffer\s*\(/);
    expect(src, 'runtime.js should expose __setListBufferById').toMatch(/__setListBufferById\s*\(/);
    expect(src, 'runtime.js should expose __getScalarValue').toMatch(/__getScalarValue\s*\(/);
    expect(src, 'runtime.js should expose __setScalarValue').toMatch(/__setScalarValue\s*\(/);
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
    expect(src, 'UMD should have __setListBuffer symbol').toMatch(/__setListBuffer/);
    expect(src, 'UMD should have __getScalarValue symbol').toMatch(/__getScalarValue/);
    expect(src, 'UMD should have __setScalarValue symbol').toMatch(/__setScalarValue/);
  });
});
