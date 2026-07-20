/**
 * Regression tests for the vendored scratch-vm control hook return value
 * contract (gpu-kernel-spec §7.2).
 *
 * Background — §19.3 #22:
 *
 *   `dispatchKernel` returns `Promise<DispatchResult>` (Phase 4
 *   unifies the contract; previously it returned `Promise<boolean>`
 *   collapsed from the structured result). A `D4 demote` resolves to
 *   the *truthy* object `{ ok: false, demoted: true }`. The vendored
 *   `scratch3_control.js` hook awaits the Promise via `.then()` and
 *   used to test the resolved value with `if (!handled)`. Because a
 *   plain object is truthy even when it represents failure, the JS
 *   path was **silently skipped** on D4 demote — leaving
 *   `control_repeat` loops un-executed for kernels the dispatcher
 *   rejected.
 *
 *   The fix replaces `if (!handled)` with
 *   `if (!handled || !handled.ok || handled.demoted)` so that only an
 *   explicit `{ ok: true, demoted: false }` skips the JS body; every
 *   other shape falls through. The sync path uses an explicit
 *   `ok === true && demoted === false` shape check (no truthy
 *   shortcut) for the same reason.
 *
 * This test pins the contract down from two angles:
 *
 *   1. **Source-inspection**: the vendored file and the patch carry the
 *      `!handled || !handled.ok || handled.demoted` pattern in three
 *      places (`repeat`, `repeatUntil`, `repeatWhile`). A future refactor
 *      that regresses to a bare `!handled` should fail this test.
 *   2. **Behavioural**: the dispatcher returns a
 *      `DispatchResult | Promise<DispatchResult>` and the contract holds
 *      across the failure shapes the kernel registry can produce.
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
    kernelContainerBlockId: blockId,
    
    firstSubstackBlockId: '',
  };
}

const REPO_ROOT = resolve(__dirname, '../../..');
const VENDORED_CONTROL = resolve(
  REPO_ROOT,
  'vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_control.js',
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

  it('sync path requires an explicit DispatchResult (not bare truthy) to skip the body', () => {
    const src = readRepoFile(VENDORED_CONTROL);
    // The sync path must check the structured DispatchResult shape,
    // not the boolean truthiness. The Phase 4 contract is:
    //   `__twGpuResult.ok === true && __twGpuResult.demoted === false`.
    expect(src).toMatch(
      /__twGpuResult\.ok\s*===\s*true\s*&&\s*__twGpuResult\.demoted\s*===\s*false/,
    );
    // Must NOT regress to a bare `__twGpuResult === true` form or any
    // truthy shortcut.
    expect(src).not.toMatch(/if\s*\(\s*__twGpuResult\s*===\s*true\s*\)/);
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
   *     `Promise<DispatchResult>`. The vendored sequencer awaits it via
   *     `.then()`. Only `{ ok: true, demoted: false }` skips the JS body;
   *     every other shape (including `{ ok: false, demoted: true }` for
   *     a D4 demote and `{ ok: false, demoted: false }` for an
   *     unregistered kernel) falls through.
   *   - When no kernel is registered for the block id, the dispatcher
   *     returns a **synchronous** `DispatchResult` shape
   *     (`{ ok: false, demoted: false }`) so the patch's sync path
   *     (`__twGpuResult.ok === true && __twGpuResult.demoted === false`)
   *     cleanly rejects it and falls through to the JS body.
   *   - The previous contract returned `boolean | Promise<boolean>` so
   *     `r.ok && !r.demoted` collapsed truthy D4 objects into
   *     `Promise<true>`. Phase 4 removes the collapse so the structured
   *     shape survives to the patch.
   */
  it('returns a Promise<DispatchResult> on D4 demote (kernel registered)', async () => {
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
    // device=null → D4 demote → Promise resolves to `{ ok: false,
    // demoted: true }`. The patch's structured judgement sees this as
    // a fall-through and the JS body runs exactly once.
    const resolved = await (result as unknown as Promise<{
      ok: boolean;
      demoted: boolean;
    }>);
    expect(resolved.ok).toBe(false);
    expect(resolved.demoted).toBe(true);
  });

  it('returns a synchronous DispatchResult when the kernel id is unregistered', () => {
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
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({ ok: false, demoted: false });
  });

  it('returns a synchronous D4 DispatchResult when the kernel is jsOnly', () => {
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
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({ ok: false, demoted: true });
  });

  it('never returns a truthy shortcut from the dispatcher (sync path is structured)', () => {
    // Phase 4: the dispatcher never returns a bare `true` /
    // truthy value — every sync result is a structured DispatchResult.
    // A future regression that returns `Promise.resolve(true)` or a
    // bare `true` would re-introduce §19.3 #22.
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    applyGpuKernels({
      enabled: true,
      enableWasm: true,
      registry,
      pool,
      device: null,
    });
    expect(typeof window.__turboWasmGpuKernelDispatch?.('none-1')).toBe('object');
    expect(typeof window.__turboWasmGpuKernelDispatch?.('none-2')).toBe('object');
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');
    registry.markJsOnly(verdict.regionId, 'synthetic');
    expect(typeof window.__turboWasmGpuKernelDispatch?.(verdict.blockId)).toBe('object');
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

describe('dispatch hook throw safety (§19.5 #33)', () => {
  /**
   * §19.5 #33: the vendored scratch-vm control hook must not propagate
   * synchronous throws (which would freeze the VM primitive) or async
   * rejections (which would crash the sequencer via unhandled rejection).
   * Both paths must fall through to the JS body. The test pins this from
   * the source-inspection angle — `git apply --recount` regenerates the
   * hunk headers from the actual context, so a hand-written patch that
   * accidentally drops the try/catch wrapper would fail this check.
   */
  it('synchronous hook throw is caught by try/catch and falls through', () => {
    const src = readRepoFile(VENDORED_CONTROL);
    expect(src, 'vendored scratch3_control.js missing — run npm run setup first').not.toBe('');
    // Each of the three hook sites (`repeat`, `repeatUntil`,
    // `repeatWhile`) must wrap the synchronous dispatch call in
    // try/catch and assign a false-y `__twGpuResult` on error.
    const guardCount = countOccurrences(src, /try\s*\{\s*__twGpuResult\s*=\s*__twGpuHook\s*\(/);
    expect(guardCount).toBeGreaterThanOrEqual(3);
    const catchCount = countOccurrences(src, /catch\s*\(__twGpuErr\s*\)/);
    expect(catchCount).toBeGreaterThanOrEqual(3);
  });

  it('async hook rejection is caught by `.then(fulfilled, rejected)` and falls through', () => {
    const src = readRepoFile(VENDORED_CONTROL);
    expect(src).not.toBe('');
    // Each hook site must use the 2-argument form of `.then` to handle
    // rejected promises. A bare `.then(fulfilled).catch(rejected)` is
    // rejected because (a) `Promise.resolve(__twGpuResult)` first absorbs
    // any thenable-throws, and (b) `.then().catch()` conflates the
    // handled-boolean path with rejection-handling.
    const onRejectedCount = countOccurrences(
      src,
      /Promise\.resolve\(__twGpuResult\)\.then\(\s*function\s*\(handled\)[\s\S]*?,\s*function\s*\(__twGpuErr\s*\)/,
    );
    expect(onRejectedCount).toBeGreaterThanOrEqual(3);
  });

  it('Promise.resolve wraps the dispatcher result so a thenable-throwing hook is also safe', () => {
    const src = readRepoFile(VENDORED_CONTROL);
    // `Promise.resolve(__twGpuResult).then(...)` ensures that even if
    // `__twGpuResult.then` itself throws (not just the awaited promise),
    // the rejection is caught and routed to the JS body.
    const wrapCount = countOccurrences(src, /Promise\.resolve\(__twGpuResult\)\.then/);
    expect(wrapCount).toBeGreaterThanOrEqual(3);
  });

  it('returns the Promise to the VM (no detached .then + util.yield race)', () => {
    // Phase 4 unification: the async hook returns the Promise so the
    // vendored sequencer awaits it on the same primitive frame. A
    // future refactor that falls back to `util.yield() + detached
    // .then()` would re-introduce the double-execute race on a fast
    // green-flag press.
    const src = readRepoFile(VENDORED_CONTROL);
    // The new shape is `return Promise.resolve(...).then(...)` for
    // each of the three hook sites. The detached `util.yield()` +
    // bare `return;` combination must NOT appear.
    const returnCount = countOccurrences(
      src,
      /return\s+Promise\.resolve\(__twGpuResult\)\.then/,
    );
    expect(returnCount).toBeGreaterThanOrEqual(3);
    // No `util.yield()` followed by a `.then(...)` chain — that path
    // is the legacy detached-callback design.
    expect(src).not.toMatch(/util\.yield\(\);\s*Promise\.resolve/);
  });

  it('patch file carries the throw safety contract (round-trip regeneration safety)', () => {
    const patch = readRepoFile(PATCH_FILE);
    expect(patch).toContain('try');
    expect(patch).toContain('catch (__twGpuErr)');
    expect(patch).toContain('Promise.resolve(__twGpuResult)');
    // The `.then(_, rejected)` form must appear in all three hook sites
    // in the patch (one per repeat/repeatUntil/repeatWhile).
    const rejectedCount = countOccurrences(patch, /function\s*\(__twGpuErr\s*\)/);
    expect(rejectedCount).toBeGreaterThanOrEqual(3);
  });

  it('console.error logs both sync throw and async rejection paths', () => {
    const src = readRepoFile(VENDORED_CONTROL);
    // The throw-safety design uses `console.error` (not the error log
    // store — vendored space cannot reach it). The two distinct log
    // messages let a future debugger tell which path failed.
    expect(src).toContain("'[gpu-kernel] dispatcher hook threw:'");
    expect(src).toContain("'[gpu-kernel] dispatcher hook rejected:'");
  });
});
