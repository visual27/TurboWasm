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
 *   4. Captures `adapter.limits` and passes them to `emitRegion` so
 *      `clampWorkgroupSize` can clamp against the real device's
 *      `maxComputeWorkgroupSizeX/Y/Z` instead of the conservative
 *      defaults (Q17 / spec §4.3).
 *
 * Production code calls this after `loadProjectFromArrayBuffer` and
 * before the first `greenFlag()`. Tests construct a stub `requestAdapter`
 * via `globalThis.navigator` injection (or pass `null` to skip it).
 */
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { KernelRegistry } from './kernel-registry';
import { ListBufferPool, type GpuLikeDevice } from './list-buffer-binding';
import { emitRegion, type WorkgroupLimits } from './wgsl-emitter';
import type { ParsedProject, RegionVerdict } from './types';

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
  /**
   * Workgroup limits read from `adapter.limits`, if the adapter exposed
   * them. Tests inject their own via `requestAdapter`. Production code
   * stores this on `window.__turbowasm.workgroupLimits` for browser-verify
   * inspection.
   */
  workgroupLimits?: WorkgroupLimits;
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
    const adapter = (await gpu.requestAdapter()) as
      | (unknown & { requestDevice?: () => Promise<unknown>; limits?: Record<string, number> })
      | null;
    if (!adapter) return null;
    // WebIDL safety: call `requestDevice` *on* the adapter, not as a
    // method-detached reference. Some implementations (Safari, older
    // Chromium) reject `Illegal invocation` when the receiver is
    // forgotten. `Reflect.apply` is the WebIDL-spec-friendly way to do
    // this; it always invokes the method with `adapter` as `this`.
    const requestDevice = adapter.requestDevice;
    if (typeof requestDevice !== 'function') return null;
    const rawDevice = await Reflect.apply(requestDevice, adapter, []);
    if (!rawDevice) return null;
    const device = rawDevice as GpuLikeDevice;
    // Capture adapter.limits so emitRegion can clamp workgroup size to
    // the real device. The structural GpuLikeDevice type already has an
    // optional `limits` field — production code here provides the
    // concrete numbers when available.
    if (adapter.limits && !device.limits) {
      const typedLimits = adapter.limits as unknown as WorkgroupLimits &
        GpuLikeDevice['limits'];
      (device as { limits?: GpuLikeDevice['limits'] }).limits = typedLimits;
    }
    return device;
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

  // Read workgroup limits once and reuse for every emit call so the
  // device's `maxComputeWorkgroupSizeX/Y/Z` actually clamps the kernel
  // (Q17). Devices that don't expose limits fall back to conservative
  // defaults via `wgsl-emitter.ts:DEFAULT_WORKGROUP_LIMITS`.
  const workgroupLimits = device.limits
    ? extractWorkgroupLimits(device.limits)
    : undefined;

  const registry = new KernelRegistry();
  const pool = new ListBufferPool({ device });
  for (const region of input.regions) {
    if (!region.blockSubset.valid) continue;
    if (!region.cascade.valid) continue;
    const emitted = emitRegion({
      regionVerdict: region,
      parsedProject: input.parsedProject,
      runtimeState: input.runtimeState,
      ...(workgroupLimits ? { workgroupLimits } : {}),
    });
    const hasError = emitted.diagnostics.some((d) => d.severity === 'error');
    if (hasError) continue;
    const kernel = registry.register(region, emitted.wgsl);
    // Stash the resolved shape so the dispatcher can use it without
    // re-evaluating the emitter.
    kernel.workgroupSize = emitted.workgroupSize;
    kernel.dispatchPlan = emitted.dispatchPlan;
    // §Phase 3 — forward the scalar uniform bindings so the dispatcher
    // can allocate the `@group(1) @binding(0)` uniform buffer and
    // evaluate the dispatch plan against the live scalar snapshot.
    kernel.scalarBindings = emitted.scalarBindings;
  }
  const result: InitializeResult = {
    registry,
    pool,
    device,
    ...(workgroupLimits ? { workgroupLimits } : {}),
  };
  return result;
}

/**
 * Map the WebGPU `GPUSupportedLimits` shape to the emitter's
 * `WorkgroupLimits`. WebGPU exposes `maxComputeWorkgroupSizeX/Y/Z` and
 * `maxComputeInvocationsPerWorkgroup` directly, so this is a 1:1 field
 * pick. We accept any superset (extra fields are ignored).
 */
function extractWorkgroupLimits(limits: NonNullable<GpuLikeDevice['limits']>): WorkgroupLimits {
  const x = (limits as { maxComputeWorkgroupSizeX?: number }).maxComputeWorkgroupSizeX;
  const y = (limits as { maxComputeWorkgroupSizeY?: number }).maxComputeWorkgroupSizeY;
  const z = (limits as { maxComputeWorkgroupSizeZ?: number }).maxComputeWorkgroupSizeZ;
  const inv = (limits as { maxComputeInvocationsPerWorkgroup?: number })
    .maxComputeInvocationsPerWorkgroup;
  return {
    maxComputeWorkgroupSizeX: typeof x === 'number' ? x : 256,
    maxComputeWorkgroupSizeY: typeof y === 'number' ? y : 256,
    maxComputeWorkgroupSizeZ: typeof z === 'number' ? z : 64,
    maxComputeInvocationsPerWorkgroup: typeof inv === 'number' ? inv : 256,
  };
}
