/**
 * Install the GPU kernel hook into the runtime handshake channel (M5).
 *
 * The vendored scratch-vm hook (M2 patch series) reads
 * `window.__turboWasmGpuKernelLookup(blockId)` whenever it enters a
 * `control_repeat` block. `applyGpuKernels` registers that global so
 * the M2 hook can find the compiled kernel for the block.
 *
 * Two short-circuit modes:
 *
 *   - `enabled === false`: no installation. The lookup returns
 *     `undefined`, the M2 hook skips the GPU path entirely.
 *   - `!enableWasm`: same as above. The WASM toggle is the user's master
 *     switch for every TurboWasm hook — the GPU compute kernel pipeline
 *     is one of those hooks, so disabling WASM also disables this path
 *     (a power user wanting to verify DoD parity should see no
 *     TurboWasm acceleration at all).
 *   - otherwise: install `lookup(blockId)` and return `{ installed: true }`.
 *
 * Tests install / uninstall the lookup via
 * `__installGpuKernelRegistryForTesting` so they can drive the dispatch
 * path without a real vendored VM.
 */
import type { Kernel, KernelRegistry } from './kernel-registry';
import type { ListBufferPool } from './list-buffer-binding';
import type { GpuLikeDispatchDevice } from './__dispatch-kernel-sync';

export type LookupFn = (blockId: string) => Kernel | undefined;

export interface ApplyGpuKernelsOptions {
  enabled: boolean;
  enableWasm: boolean;
  registry: KernelRegistry;
  pool: ListBufferPool;
  device: GpuLikeDispatchDevice | null;
}

export interface ApplyGpuKernelsResult {
  installed: boolean;
  reason?: string;
}

declare global {
  interface Window {
    __turboWasmGpuKernelLookup?: LookupFn;
  }
}

/**
 * Install / uninstall the GPU kernel lookup. Idempotent: calling twice
 * is a no-op when the same registry is already installed.
 */
export function applyGpuKernels(options: ApplyGpuKernelsOptions): ApplyGpuKernelsResult {
  if (!options.enabled) {
    uninstallLookup();
    return { installed: false, reason: 'disabled' };
  }
  if (!options.enableWasm) {
    uninstallLookup();
    return { installed: false, reason: 'wasm-disabled' };
  }
  installLookup(options.registry);
  return { installed: true };
}

/**
 * Direct setter for the lookup. Used by the vendored scratch-vm hook
 * layer when it needs to override the default registry (e.g. when the
 * player wants to swap in a different registry between projects). Also
 * useful for unit tests.
 */
export function __setGpuKernelLookup(fn: LookupFn | null): void {
  if (typeof window === 'undefined') return;
  if (fn === null) {
    delete window.__turboWasmGpuKernelLookup;
    return;
  }
  window.__turboWasmGpuKernelLookup = fn;
}

/**
 * Test-only: install a registry as the active GPU kernel lookup. The
 * companion uninstall entry point is `__uninstallGpuKernelRegistryForTesting`.
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

function installLookup(registry: KernelRegistry): void {
  if (typeof window === 'undefined') return;
  const fn: LookupFn = (blockId) => registry.lookup(blockId);
  window.__turboWasmGpuKernelLookup = fn;
}

function uninstallLookup(): void {
  if (typeof window === 'undefined') return;
  delete window.__turboWasmGpuKernelLookup;
}

export type { GpuLikeDispatchDevice };