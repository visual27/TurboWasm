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
 * Hook signature the vendored scratch-vm runtime expects. Returns a
 * boolean (synchronous) OR a Promise<boolean> (async); the vendored
 * patch is patched to await the Promise and translate truthy →
 * skip-body, falsy → fall through.
 */
export type DispatchFn = (blockId: string) => boolean | Promise<boolean>;

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
    const kernel = options.registry.lookup(blockId);
    if (!kernel) return false;
    if (kernel.jsOnly) return false;
    const ctx: DispatchContext = {
      device: options.device,
      registry: options.registry,
      pool: options.pool,
      regionVerdict: kernel.regionVerdict,
      // Legacy fallback dims (1, 1, 1). With §Phase 3 scalar bindings
      // present, the dispatcher overrides these per-dispatch from
      // `kernel.dispatchPlan` + the live scalar snapshot. The fallback
      // only fires when scalarBindings is empty (= legacy fixture path).
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
    try {
      return dispatchKernel(kernel.id, ctx).then(
        (r: DispatchResult): boolean => r.ok && !r.demoted,
        (): boolean => false,
      );
    } catch (err) {
      // Last-resort safety net: the dispatcher swallows throws, but
      // any synchronous failure here must not propagate to the VM.
      // eslint-disable-next-line no-console
      console.error('[gpu-kernel] dispatcher failed:', err);
      return false;
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
