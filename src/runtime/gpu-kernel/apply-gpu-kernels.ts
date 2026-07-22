/**
 * Install the GPU kernel hook into the runtime handshake channel (M5).
 *
 * The vendored scratch-vm hook (M2 patch series) reads
 * `globalThis.__turboWasmGpuKernelDispatch(blockId)` whenever it enters
 * a `control_repeat` block. `applyGpuKernels` registers that global
 * so the M2 hook can dispatch the GPU kernel and decide whether the
 * JS body should run.
 *
 * Two short-circuit modes:
 *
 *   - `enabled === false`: no installation. The hook returns `false`,
 *     the M2 hook falls through to the JS path entirely.
 *   - `!enableWasm`: same as above. The WASM toggle is the user's master
 *     switch for every TurboWasm hook — the GPU compute kernel pipeline
 *     is one of those hooks, so disabling WASM also disables this path
 *     (a power user wanting to verify DoD parity should see no
 *     TurboWasm acceleration at all).
 *   - otherwise: install `dispatch(blockId)` and return
 *     `{ installed: true }`.
 *
 * The lookup helper `__turboWasmGpuKernelLookup(blockId)` is retained
 * as a test-only helper (used by `__installGpuKernelRegistryForTesting`)
 * because a few unit tests prefer the synchronous lookup path over the
 * full dispatcher.
 */
import type { KernelRegistry } from './kernel-registry';
import type {
  DispatchContext,
  DispatchResult,
  RuntimeAdapter,
} from './__dispatch-kernel-sync';
import { dispatchKernel } from './__dispatch-kernel-sync';
import type { ListLengthBinding } from './scalar-uniform-binding';
import type {
  ApplyGpuKernelsOptions,
  ApplyGpuKernelsResult,
  LookupFn,
} from './apply-gpu-kernels-types';

export type { ApplyGpuKernelsOptions, ApplyGpuKernelsResult, LookupFn };

declare global {
  interface Window {
    __turboWasmGpuKernelDispatch?: DispatchFn;
    __turboWasmGpuKernelLookup?: LookupFn;
  }
}

/**
 * Hook signature the vendored scratch-vm runtime expects.
 *
 * Phase 4 unifies the contract: the dispatcher returns a
 * {@link DispatchResult} (synchronously when no GPU work is needed, or
 * a `Promise<DispatchResult>` when the dispatch is async). The
 * vendored patch awaits the Promise and skips the JS body only when
 * the resolved shape is `{ ok: true, demoted: false }`; every other
 * shape falls through. The previous `boolean | Promise<boolean>`
 * contract is collapsed to the structured form so a truthy
 * `{ok:false,demoted:true}` object cannot silently skip the JS body
 * (see `scratch3-control-hook.test.ts`).
 */
export type DispatchFn = (
  blockId: string,
) => DispatchResult | Promise<DispatchResult>;

/**
 * Install / uninstall the GPU kernel dispatcher. Idempotent: calling
 * twice is a no-op when the same registry is already installed.
 */
export function applyGpuKernels(options: ApplyGpuKernelsOptions): ApplyGpuKernelsResult {
  if (!options.enabled) {
    uninstallDispatcher();
    uninstallLookup();
    return { installed: false, reason: 'disabled' };
  }
  if (!options.enableWasm) {
    uninstallDispatcher();
    uninstallLookup();
    return { installed: false, reason: 'wasm-disabled' };
  }
  installDispatcher(options);
  installLookup(options.registry);
  return { installed: true };
}

/**
 * Direct setter for the dispatcher. Used by tests and by the vendored
 * scratch-vm hook layer when it needs to override the default
 * registry.
 */
export function __setGpuKernelDispatcher(fn: DispatchFn | null): void {
  if (typeof window === 'undefined') return;
  if (fn === null) {
    delete window.__turboWasmGpuKernelDispatch;
    return;
  }
  window.__turboWasmGpuKernelDispatch = fn;
}

/**
 * Test-only: install a registry as the active GPU kernel lookup. The
 * companion uninstall entry point is
 * `__uninstallGpuKernelRegistryForTesting`.
 */
export function __installGpuKernelRegistryForTesting(registry: KernelRegistry): void {
  installLookup(registry);
}

/**
 * Test-only: remove the GPU kernel lookup. Pairs with
 * `__installGpuKernelRegistryForTesting`.
 */
export function __uninstallGpuKernelRegistryForTesting(): void {
  uninstallLookup();
}

/**
 * Snapshot for `window.__turbowasm.kernelRegistry` (M6 browser-verify).
 * Returns a plain object the verify script can introspect without
 * poking into private fields.
 */
export function __getGpuKernelForBrowserVerify(registry: KernelRegistry): {
  size: number;
  jsOnly: number;
  canonicalKeys: string[];
} {
  const all = registry.list();
  return {
    size: all.length,
    jsOnly: all.filter((k) => k.jsOnly).length,
    canonicalKeys: all.map((k) => k.canonicalKey),
  };
}

/* ------------------------------------------------------------------ *
 * Internal helpers                                                    *
 * ------------------------------------------------------------------ */

function installDispatcher(options: ApplyGpuKernelsOptions): void {
  if (typeof window === 'undefined') return;
  const pipelines = options.pipelines ?? new Map();
  const runtime: RuntimeAdapter = options.runtime ?? makeNullRuntime();
  const fn: DispatchFn = (blockId) => {
    // Phase 4 dispatcher contract: every path returns a structured
    // `DispatchResult` (or its Promise). A kernel that was previously
    // D4-demoted is registered but marked `jsOnly`, so we have to
    // surface a `demoted: true` result here — `lookup()` hides
    // jsOnly kernels from the JS-visible path on purpose.
    const kernel = options.registry.lookup(blockId);
    if (!kernel) {
      const direct = options.registry.lookupJsOnly(blockId);
      if (direct) {
        return {
          ok: false,
          demoted: true,
          message: direct.jsOnlyReason || 'kernel is js-only',
        } satisfies DispatchResult;
      }
      return {
        ok: false,
        demoted: false,
        message: `kernel '${blockId}' not registered`,
      } satisfies DispatchResult;
    }
    const ctx: DispatchContext = {
      device: options.device,
      registry: options.registry,
      pool: options.pool,
      regionVerdict: kernel.regionVerdict,
      // §Phase 4 (15.5) — `dims` is now the fallback only. When
      // `kernel.dispatchPlan` is attached (the common path) the
      // dispatcher evaluates the WGSL expression per dispatch against
      // live host state, so `dims` is never reached.
      dims: { x: 1, y: 1, z: 1 },
      pipelines: pipelines as Map<string, unknown> as DispatchContext['pipelines'],
      runtime,
    };
    // §Phase 3 — wire the WGSL expression dispatch plan and scalar
    // uniform bindings through to the dispatcher. Both are precomputed
    // at `initializeGpuKernels` time and stored on the Kernel; we just
    // forward them here so the dispatcher can evaluate the plan
    // against live host state per dispatch.
    if (kernel.dispatchPlan) ctx.dispatchPlan = kernel.dispatchPlan;
    if (kernel.scalarBindings && kernel.scalarBindings.length > 0) {
      ctx.scalarBindings = kernel.scalarBindings;
    }
    // §Phase 4 (15.7/15.8) — derive list length bindings from the
    // kernel's list bindings so the uniform buffer (= `@group(1)
    // @binding(0)`) carries the live `<list>_length` slots for every
    // list binding, regardless of whether scalar bindings are
    // attached. This is what makes list-only kernels readable in the
    // WGSL body (group 1 is bound, list length fields are packed).
    const listLengthBindings: ListLengthBinding[] = kernel.listBindings.map((b) => ({
      name: b.name,
      // The WGSL field name = `<storage_name>_length`. The emitter's
      // rename pass may produce a hashed `internalName` for quoted
      // bindings, but we look it up via the rename table at apply
      // time. The dispatcher doesn't need the hashed form here
      // because it never writes the WGSL struct field name into the
      // GPU buffer — `packScalarUniformBuffer` only cares about the
      // host list length value keyed by `name`.
      wgslName: `${b.name}_length`,
    }));
    if (listLengthBindings.length > 0) {
      ctx.listLengthBindings = listLengthBindings;
    }
    try {
      // §M7 — per-dispatch timing. `performance.now()` brackets the
      // synchronous dispatch path so `scripts/measure-expo-custom-block.mjs`
      // can read accumulated wall-time via
      // `window.__turbowasm.gpuKernelTiming`. The async path (GPU
      // command submission + mapAsync) is awaited inside
      // `dispatchKernel`, so this measurement covers the full
      // dispatch from JS call to `pass` completion.
      const startedAt =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      const result = dispatchKernel(kernel.id, ctx);
      const finalize = (resolved: DispatchResult): DispatchResult => {
        const finishedAt =
          typeof performance !== 'undefined' ? performance.now() : Date.now();
        recordKernelDispatchTiming(finishedAt - startedAt);
        return resolved;
      };
      // The dispatcher returns `DispatchResult | Promise<DispatchResult>`
      // (per spec §7 — the GPU path awaits `queue.onSubmittedWorkDone`
      // for accurate wall-time). Normalise the union here so the
      // timing snapshot covers both shapes.
      const maybePromise = result as { then?: unknown };
      if (maybePromise && typeof maybePromise.then === 'function') {
        const promise = maybePromise as unknown as Promise<DispatchResult>;
        return promise.then(finalize);
      }
      return finalize(result as unknown as DispatchResult);
    } catch (err) {
      // Last-resort safety net: the dispatcher swallows throws, but
      // any synchronous failure here must not propagate to the VM.
      // eslint-disable-next-line no-console
      console.error('[gpu-kernel] dispatcher failed:', err);
      return {
        ok: false,
        demoted: true,
        message: err instanceof Error ? err.message : String(err),
      } satisfies DispatchResult;
    }
  };
  window.__turboWasmGpuKernelDispatch = fn;
}

function installLookup(registry: KernelRegistry): void {
  if (typeof window === 'undefined') return;
  const fn: LookupFn = (blockId) => registry.lookup(blockId);
  window.__turboWasmGpuKernelLookup = fn;
}

function uninstallDispatcher(): void {
  if (typeof window === 'undefined') return;
  delete window.__turboWasmGpuKernelDispatch;
}

function uninstallLookup(): void {
  if (typeof window === 'undefined') return;
  delete window.__turboWasmGpuKernelLookup;
}

/**
 * Minimal runtime adapter used when the caller doesn't supply one.
 * Reads return zero/empty; writes are no-ops. Real bootstrap always
 * passes a fully-wired adapter.
 */
function makeNullRuntime(): RuntimeAdapter {
  return {
    readList: (_name, len) => new Float32Array(len),
    writeList: () => undefined,
    readScalar: () => 0,
    writeScalar: () => false,
    listLength: () => 0,
  };
}

/**
 * Per-process dispatch-timing accumulator. Exposed on
 * `window.__turbowasm.gpuKernelTiming` (see `__exposeForBrowserVerify`
 * in `src/runtime/player.ts`) so browser-side benchmarks can read
 * GPU kernel wall-time without poking into module-private state.
 *
 * §M7 (gpu-kernel §16) — `scripts/measure-expo-custom-block.mjs`
 * reads this snapshot via `chrome-devtools-mcp evaluate_script` to
 * compare GPU-kernel dispatch time against the scratch-VM JS path
 * for the user-facing pixel-level expo calculation.
 *
 * The accumulator is published as a **live reference** (not a frozen
 * snapshot) so browser-side `evaluate_script` polls see fresh counts
 * each tick. `resetKernelTimingForTesting()` zeroes the accumulator;
 * `recordKernelDispatchTiming()` updates it on every dispatch.
 */
interface KernelTimingSnapshot {
  count: number;
  totalMs: number;
  lastMs: number;
  minMs: number;
  maxMs: number;
}
const ZERO_TIMING: KernelTimingSnapshot = {
  count: 0,
  totalMs: 0,
  lastMs: 0,
  minMs: Number.POSITIVE_INFINITY,
  maxMs: 0,
};

let kernelTiming: KernelTimingSnapshot = { ...ZERO_TIMING };

/**
 * Live handle the browser exposes via `window.__turbowasm.gpuKernelTiming`.
 * Returns a getter-backed object so `evaluate_script(...).gpuKernelTiming`
 * reads the current accumulator every time it's accessed (= the
 * measure script can poll mid-flight without needing to re-call
 * `__exposeForBrowserVerify`). Mutating the returned object is a
 * no-op (= the live reference is read-only externally).
 */
export function getKernelTimingLiveHandle(): {
  readonly count: number;
  readonly totalMs: number;
  readonly lastMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** Zero the accumulator. Browser-side measure script calls this between modes. */
  reset(): void;
} {
  return {
    get count() {
      return kernelTiming.count;
    },
    get totalMs() {
      return kernelTiming.totalMs;
    },
    get lastMs() {
      return kernelTiming.lastMs;
    },
    get minMs() {
      return kernelTiming.minMs;
    },
    get maxMs() {
      return kernelTiming.maxMs;
    },
    reset() {
      kernelTiming = { ...ZERO_TIMING };
    },
  };
}

export function recordKernelDispatchTiming(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  kernelTiming = {
    count: kernelTiming.count + 1,
    totalMs: kernelTiming.totalMs + durationMs,
    lastMs: durationMs,
    minMs: Math.min(kernelTiming.minMs, durationMs),
    maxMs: Math.max(kernelTiming.maxMs, durationMs),
  };
}

export function resetKernelTimingForTesting(): void {
  kernelTiming = { ...ZERO_TIMING };
}

export function getKernelTimingSnapshot(): KernelTimingSnapshot {
  return { ...kernelTiming };
}
