/**
 * Bootstraps the WebGPU compute kernel pipeline after a project load (M5).
 *
 * Per spec §7, this function:
 *
 *   1. Returns empty stub objects when the GPU tier is disabled or the
 *      user disabled the WASM toggle (`enableWasm === false`). The latter
 *      is the v8 successor to the v3..v7 `performanceMode: 'legacy-only'`
 *      shortcut — disabling WASM also short-circuits the GPU kernel
 *      pipeline so a parity-test run stays observably identical to
 *      unmodified scratch-render.
 *   2. Probes `globalThis.navigator?.gpu?.requestAdapter()` best-effort.
 *      When the API is missing (jsdom, Safari, older browsers), returns
 *      a `device: null` result and emits a single
 *      `gpu.adapter_unavailable` warn via `useErrorLogStore`.
 *   3. For every region that passed D1/D2/D3, emits WGSL and registers
 *      the kernel in the registry. Regions whose WGSL emitter produced
 *      an `error` diagnostic are skipped (D3 demote).
 *
 * Production code calls this after `loadProjectFromArrayBuffer` and
 * before the first `greenFlag()`. Tests construct a stub `requestAdapter`
 * via `globalThis.navigator` injection (or pass `null` to skip it).
 */
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { KernelRegistry } from './kernel-registry';
import { ListBufferPool } from './list-buffer-binding';
import { emitRegion } from './wgsl-emitter';
import type { GpuLikeDevice } from './list-buffer-binding';
import type {
  ParsedProject,
  RegionVerdict,
} from './types';

export interface InitializeInput {
  regions: RegionVerdict[];
  parsedProject: ParsedProject;
  runtimeState: { listLengths: Record<string, number> };
  enableWasm: boolean;
  enabled: boolean;
}

export interface InitializeResult {
  registry: KernelRegistry;
  pool: ListBufferPool;
  device: GpuLikeDevice | null;
}

/**
 * Optional WebGPU adapter requester. Production code uses the default
 * (which calls `navigator.gpu.requestAdapter()`); tests inject a stub.
 */
export type RequestAdapterFn = () => Promise<GpuLikeDevice | null>;

const defaultRequestAdapter: RequestAdapterFn = async () => {
  const nav = (globalThis as { navigator?: { gpu?: { requestAdapter?: () => Promise<unknown> } } })
    .navigator;
  const gpu = nav?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const requestDevice = (adapter as { requestDevice?: () => Promise<unknown> }).requestDevice;
    if (typeof requestDevice !== 'function') return null;
    const device = (await requestDevice()) as GpuLikeDevice | null;
    return device ?? null;
  } catch {
    return null;
  }
};

/**
 * Track whether we've already warned about a missing WebGPU adapter in
 * the current session — per spec §7.1, "no spam" means at most one
 * `gpu.adapter_unavailable` entry per session.
 */
let adapterUnavailableWarned = false;

/** Reset the adapter-unavailable warning flag. Test-only. */
export function __resetAdapterUnavailableWarningForTesting(): void {
  adapterUnavailableWarned = false;
}

/**
 * Bootstrap entry. Pure-ish: it allocates a fresh registry + pool but
 * does not register them with the runtime. The caller passes them to
 * `applyGpuKernels` once the runtime is ready.
 */
export async function initializeGpuKernels(
  input: InitializeInput,
  requestAdapter: RequestAdapterFn = defaultRequestAdapter,
): Promise<InitializeResult> {
  const empty: InitializeResult = {
    registry: new KernelRegistry(),
    pool: new ListBufferPool({ device: null }),
    device: null,
  };

  if (!input.enabled) return empty;
  if (!input.enableWasm) return empty;

  const device = await requestAdapter();
  if (device === null) {
    if (!adapterUnavailableWarned) {
      adapterUnavailableWarned = true;
      useErrorLogStore.getState().push('warn', 'gpu.adapter_unavailable');
    }
    return {
      registry: new KernelRegistry(),
      pool: new ListBufferPool({ device: null }),
      device: null,
    };
  }

  const registry = new KernelRegistry();
  const pool = new ListBufferPool({ device });
  for (const region of input.regions) {
    if (!region.blockSubset.valid) continue;
    if (!region.cascade.valid) continue;
    const emitted = emitRegion({
      regionVerdict: region,
      parsedProject: input.parsedProject,
      runtimeState: input.runtimeState,
    });
    const hasError = emitted.diagnostics.some((d) => d.severity === 'error');
    if (hasError) continue;
    registry.register(region, emitted.wgsl);
  }
  return { registry, pool, device };
}