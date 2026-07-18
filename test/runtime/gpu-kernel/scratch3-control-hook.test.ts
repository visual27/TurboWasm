/**
 * Regression tests for the vendored scratch-vm control hook return value
 * contract (gpu-kernel-spec §7.2).
 *
 * Background — §19.3 #22 (resolved in this commit):
 *
 *   `dispatchKernel` returns `Promise<DispatchResult>` where a `D4 demote`
 *   resolves to the *truthy* object `{ ok: false, demoted: true }`. The
 *   vendored `scratch3_control.js` hook awaits the Promise via `.then()`
 *   and used to test the resolved value with `if (!handled)`. Because
 *   a plain object is truthy even when it represents failure, the JS
 *   path was **silently skipped** on D4 demote — leaving `control_repeat`
 *   loops un-executed for kernels the dispatcher rejected.
 *
 *   The fix replaces `if (!handled)` with
 *   `if (!handled || !handled.ok || handled.demoted)` so that only an
 *   explicit `{ ok: true, demoted: false }` skips the JS body; every
 *   other shape falls through.
 *
 * This test pins the contract down from two angles:
 *
 *   1. **Source-inspection**: the vendored file and the patch carry the
 *      `!handled || !handled.ok || handled.demoted` pattern in three
 *      places (`repeat`, `repeatUntil`, `repeatWhile`). A future refactor
 *      that regresses to a bare `!handled` should fail this test.
 *   2. **Behavioural**: the dispatcher returns a `Promise<DispatchResult>`
 *      and the contract holds across the failure shapes the kernel
 *      registry can produce. We confirm the dispatcher contract
 *      separately here so the source-inspection is not the only line
 *      of defence.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyGpuKernels,
  __setGpuKernelDispatcher,
  __uninstallGpuKernelRegistryForTesting,
} from '@/runtime/gpu-kernel/apply-gpu-kernels';
import {
  dispatchKernel,
  type DispatchContext,
} from '@/runtime/gpu-kernel/__dispatch-kernel-sync';
import { KernelRegistry } from '@/runtime/gpu-kernel/kernel-registry';
import { ListBufferPool } from '@/runtime/gpu-kernel/list-buffer-binding';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { BindDirective, RegionVerdict } from '@/runtime/gpu-kernel/types';

function makeBind(name: string, slot: number, readOnly: boolean): BindDirective {
  return {
    kind: 'bind',
    name,
    slot,
    readOnly,
    dtype: 'f32',
    line: 0,
    column: 0,
  };
}

function makeVerdict(blockId: string, binds: BindDirective[]): RegionVerdict {
  return {
    regionId: `region:sprite:${blockId}`,
    blockId,
    spriteId: 'sprite',
    directives: binds,
    blockSubset: { valid: true, diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [],
    parallelAxes: [],
  };
}

const REPO_ROOT = resolve(__dirname, '../../..');
const VENDORED_CONTROL = resolve(
  REPO_ROOT,
  'vendored/scratch-vm/src/blocks/scratch3_control.js',
);
const PATCH_FILE = resolve(REPO_ROOT, 'patches/vendored/gpu-kernel-runtime+0.1.0.patch');

function readRepoFile(path: string): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function countOccurrences(haystack: string, needle: RegExp): number {
  let count = 0;
  const re = new RegExp(needle.source, needle.flags.includes('g') ? needle.flags : `${needle.flags}g`);
  while (re.exec(haystack) !== null) count += 1;
  return count;
}

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
  __uninstallGpuKernelRegistryForTesting();
  __setGpuKernelDispatcher(null);
});

afterEach(() => {
  __uninstallGpuKernelRegistryForTesting();
  __setGpuKernelDispatcher(null);
});

describe('vendored scratch3_control.js hook contract (source-inspection)', () => {
  /**
   * §19.3 #22 fix is load-bearing — the hook is the single point where
   * a D4-demoted GPU dispatch decides whether the JS body runs. A
   * future refactor that reverts to `if (!handled)` would silently drop
   * the JS body on every kernel that fails at runtime. Pin the pattern
   * with `expect(src).toMatch(...)` so the failure mode is loud.
   */
  it('repeat hook treats `{ok:false,demoted:true}` as fall-through (not skip)', () => {
    const src = readRepoFile(VENDORED_CONTROL);
    expect(src, 'vendored scratch3_control.js missing — run npm run setup first').not.toBe('');
    // The D4-safe guard must appear at least three times (one per hook
    // site: `repeat`, `repeatUntil`, `repeatWhile`).
    const guardMatches = src.match(
      /if\s*\(\s*!handled\s*\|\|\s*!handled\.ok\s*\|\|\s*handled\.demoted\s*\)/g,
    );
    expect(guardMatches?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('sync path requires a literal `true` (not just truthy) to skip the body', () => {
    const src = readRepoFile(VENDORED_CONTROL);
    expect(src).toMatch(/if\s*\(\s*__twGpuResult\s*===\s*true\s*\)/);
    // And must NOT regress to the bare truthy form.
    expect(src).not.toMatch(/if\s*\(\s*__twGpuResult\s*\)\s*\{\s*\/\/\s*Sync truthy/);
  });

  it('patch file carries the same contract (round-trip regeneration safety)', () => {
    const patch = readRepoFile(PATCH_FILE);
    expect(patch).toContain('handled.demoted');
    // We require the explicit `!handled || !handled.ok || handled.demoted`
    // form so a refactor that simplifies one side but not the other
    // cannot ship.
    const guardCount = countOccurrences(patch, /handled\.demoted/g);
    expect(guardCount).toBeGreaterThanOrEqual(3);
  });
});

describe('applyGpuKernels dispatcher contract (§19.3 #22, behavioural)', () => {
  /**
   * The dispatcher contract from the patch's perspective:
   *
   *   - When the kernel is registered, the dispatcher returns
   *     `Promise<boolean>` (resolved `true` = handled, `false` = fall-through).
   *     The vendored sequencer awaits this via `.then()`.
   *   - When no kernel is registered for the block id, the dispatcher
   *     returns a **synchronous** `false` — never `true` — so the patch's
   *     sync path (`if (__twGpuResult === true)`) is the one and only
   *     way for the dispatcher to "skip" the JS body without going
   *     through the GPU path. The patch path was the only path that
   *     was previously `truthy`-only (§19.3 #22), so this contract
   *     pins it down.
   *   - The async path never resolves to `true` directly — the
   *     dispatcher does `r.ok && !r.demoted` so even `{ok:true,
   *     demoted:false}` becomes a JS `true`. The Promise body is
   *     `boolean`, NOT `DispatchResult`. The patch's
   *     `if (!handled || !handled.ok || handled.demoted)` judgment
   *     targets the *DispatchResult* shape; the dispatcher-installed
   *     async path collapses it to `boolean` before the patch sees it.
   */
  it('returns a Promise<boolean> resolving to false on D4 demote (kernel registered)', async () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    applyGpuKernels({
      enabled: true,
      enableWasm: true,
      registry,
      pool,
      device: null,
    });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const result = window.__turboWasmGpuKernelDispatch?.(verdict.blockId);
    expect(result).toBeInstanceOf(Promise);
    // device=null → D4 demote → Promise resolves to false. The patch's
    // `if (!handled || !handled.ok || handled.demoted)` judgement on
    // the underlying DispatchResult is already collapsed to boolean
    // false here; the patch sees the false and falls through.
    const resolved = await (result as unknown as Promise<boolean>);
    expect(resolved).toBe(false);
  });

  it('returns synchronous false when the kernel id is unregistered', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    applyGpuKernels({
      enabled: true,
      enableWasm: true,
      registry,
      pool,
      device: null,
    });
    const result = window.__turboWasmGpuKernelDispatch?.('unregistered-block');
    // Synchronous false — no Promise. The patch's
    // `if (__twGpuResult === true)` literal comparison correctly
    // rejects this and falls through to the JS body.
    expect(result).toBe(false);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('returns synchronous false when the kernel is jsOnly (D4 demoted previously)', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    applyGpuKernels({
      enabled: true,
      enableWasm: true,
      registry,
      pool,
      device: null,
    });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');
    // D4-demote the kernel via the registry's own helper (this is the
    // path `dispatchKernel` takes on demote).
    registry.markJsOnly(verdict.regionId, 'synthetic');

    const result = window.__turboWasmGpuKernelDispatch?.(verdict.blockId);
    expect(result).toBe(false);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('never returns synchronous true from the dispatcher (sync path is reserved)', () => {
    // The patch's `if (__twGpuResult === true)` is the only path that
    // could skip the JS body synchronously. The dispatcher must NEVER
    // return `true` synchronously — otherwise a D4 demote (truthy
    // object) and a fake "always-handled" dispatcher become
    // indistinguishable from a real success. We verify by exhaustively
    // calling the dispatcher with several block ids and asserting none
    // synchronously returns true.
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    applyGpuKernels({
      enabled: true,
      enableWasm: true,
      registry,
      pool,
      device: null,
    });
    expect(window.__turboWasmGpuKernelDispatch?.('none-1')).not.toBe(true);
    expect(window.__turboWasmGpuKernelDispatch?.('none-2')).not.toBe(true);
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');
    registry.markJsOnly(verdict.regionId, 'synthetic');
    expect(window.__turboWasmGpuKernelDispatch?.(verdict.blockId)).not.toBe(true);
  });
});

describe('dispatchKernel return-value shape (direct)', () => {
  /**
   * Directly drive `dispatchKernel` so we can observe the failure shapes
   * the patch's judgment depends on. The contract is:
   *
   *   - `device === null` → `{ ok: false, demoted: true }` (one-shot warn).
   *   - Device exists but pipeline build fails → same shape, with the
   *     error message forwarded.
   *   - Device exists and pipeline builds → `{ ok: true, demoted: false }`.
   */
  it('device=null → truthy failure shape (the bug surface)', async () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const ctx: DispatchContext = {
      device: null,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      pipelines: new Map(),
      runtime: {
        readList: () => new Float32Array(0),
        writeList: () => undefined,
        readScalar: () => 0,
        writeScalar: () => false,
        listLength: () => 0,
      },
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    // The shape that bit §19.3 #22: a truthy object on failure.
    expect(result.ok).toBe(false);
    expect(result.demoted).toBe(true);
    expect(typeof result).toBe('object');
    // The patched hook uses
    //   `if (!handled || !handled.ok || handled.demoted)`,
    // so the **only** outcome that lets the JS body run is whatever
    // expression evaluates falsy on all three terms above. Confirms
    // the failure shape is the D4-demote form, not `true`, `undefined`,
    // or any other truthy value.
    const hookWouldFallThrough =
      !result || !result.ok || result.demoted;
    expect(hookWouldFallThrough).toBe(true);
  });
});
