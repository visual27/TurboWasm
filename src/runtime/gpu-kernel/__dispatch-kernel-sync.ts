/**
 * Synchronous dispatch path for one GPU kernel (M5 — runtime dispatch layer).
 *
 * Per spec §7.2, the runtime path for one `control_repeat` block is:
 *
 *   pre-dispatch:
 *     list.length read → @max cap → alloc/write list buffer
 *   dispatch:
 *     beginComputePass + dispatchWorkgroups → submit (fire-and-forget)
 *   post-dispatch:
 *     mapAsync readback (Promise) → list write-back
 *     failure → D4 demote (registry marks js-only)
 *
 * In M5 we keep `dispatchKernelSync` synchronous for jsdom testability:
 *
 *   - `submit()` returns a Promise we deliberately do not await. We
 *     immediately call `mapAsync`-equivalent `syncToHost()` which reads
 *     the host-side mirror (the dispatcher's bookkeeping is
 *     the host-side mirror).
 *   - Tests can drive `completeReadback()` to flush pending readbacks in
 *     real-device scenarios; in jsdom the mirror is always up-to-date.
 *
 * A `device: null` ctx means "no WebGPU" — every dispatch short-circuits
 * to the JS-only result and the kernel is D4-demoted.
 */
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { GpuLikeQueue, ListBufferPool } from './list-buffer-binding';
import type { KernelRegistry, Kernel } from './kernel-registry';
import type { BindDirective, RegionVerdict } from './types';

/**
 * Structural shape of the GPU pipeline object the dispatcher builds per
 * kernel. We avoid importing `@webgpu/types` at runtime — these fields
 * are what `dispatchKernelSync` actually touches.
 */
export interface GPipeline {
  /**
   * Bind group layout / bind group, paired with the ListBufferPool
   * bindings at dispatch time. The dispatcher looks up
   * `pipeline.bindGroups[slot]` by `@bind name`'s slot.
   */
  bindGroups: Map<number, unknown>;
  /**
   * Pipeline layout / pipeline. Tests supply a stub; real WebGPU
   * adapters would expose `pipeline.getBindGroupLayout(0)`.
   */
  pipeline: unknown;
  /** Workgroup size from `@workgroup_size` (clamped in the emitter). */
  workgroupSize: { x: number; y: number; z: number };
}

export interface DispatchContext {
  /** WebGPU device. `null` means "no GPU"; dispatch is a no-op. */
  device: GpuLikeDispatchDevice | null;
  /** Registry of compiled kernels. */
  registry: KernelRegistry;
  /** Buffer pool to source list bindings from. */
  pool: ListBufferPool;
  /** The verdict driving this dispatch (for diagnostics + binding lookup). */
  regionVerdict: RegionVerdict;
  /** Dispatch dims (x, y, z). Computed from the parallel axes. */
  dims: { x: number; y: number; z: number };
  /** Pipeline cache keyed by `canonicalKey`. */
  pipelines: Map<string, GPipeline>;
  /**
   * Host-side list-length source. The dispatcher reads `hostListLengths[name]`
   * to size the GPU buffer before each sync. Tests inject a record;
   * production code calls `__getListBuffer` (M2 patch) here.
   */
  hostListLengths: Record<string, number>;
  /**
   * Read a host list into a typed array. Production code calls
   * `__getListBuffer` (M2 patch) here. Tests inject a stub.
   */
  readHostList: (
    listName: string,
    length: number,
  ) => number[] | Float32Array | Int32Array | Uint8Array;
  /**
   * Write a typed array back into the host list. Production code calls
   * `__setListBuffer` (M2 patch) here. Tests inject a stub.
   */
  writeHostList: (
    listName: string,
    value: Float32Array | Int32Array | Uint8Array,
  ) => void;
  /**
   * Optional callback invoked once the dispatcher has finished the
   * fire-and-forget submit. Tests use it to flush jsdom mocks; the
   * default implementation is a no-op.
   */
  onSubmit?: (kernel: Kernel) => void;
}

/**
 * Subset of `GpuLikeDevice` the dispatcher needs: an encoder factory and
 * `createComputePipeline` / `createBindGroup` for the per-dispatch bind
 * group construction. The `queue` field is intentionally typed as the
 * full `GpuLikeQueue` (from `list-buffer-binding`) so the dispatch
 * device can be plugged straight into a `ListBufferPool` without a cast.
 */
export interface GpuLikeDispatchDevice {
  queue: GpuLikeQueue;
  createCommandEncoder(): GpuLikeCommandEncoder;
  createComputePipeline?(desc: { compute: { module: unknown; entryPoint: string } }): unknown;
  createBindGroup?(desc: {
    layout: unknown;
    entries: Array<{ binding: number; resource: { buffer: unknown } }>;
  }): unknown;
}

export interface GpuLikeCommandEncoder {
  beginComputePass(): GpuLikeComputePassEncoder;
  finish(): unknown;
}

export interface GpuLikeComputePassEncoder {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  dispatchWorkgroups(x: number, y: number, z: number): void;
  end(): void;
}

export interface DispatchResult {
  ok: boolean;
  /** True when the dispatch failed and the kernel was D4-demoted. */
  demoted: boolean;
  /** Message describing the failure, if any. */
  message?: string;
}

/**
 * Run one dispatch for the kernel referenced by `regionVerdict.regionId`.
 * Returns `{ ok: true }` on success and `{ ok: false, demoted: true }` on
 * any failure (which is then routed to the JS path by the next
 * `lookup()` call).
 */
export function dispatchKernelSync(
  kernelId: string,
  ctx: DispatchContext,
): DispatchResult {
  const kernel = ctx.registry.lookupById(kernelId);
  if (!kernel) {
    return { ok: false, demoted: false, message: `kernel '${kernelId}' not found in registry` };
  }

  if (ctx.device === null) {
    return handleNoDevice(kernel, ctx);
  }

  // Pre-dispatch: ensure every @bind directive has a pool binding sized
  // to the current host list length, then sync the host data in.
  const binds = kernel.regionVerdict.directives.filter(
    (d): d is BindDirective => d.kind === 'bind',
  );
  for (const bind of binds) {
    let binding = ctx.pool.get(bind.name);
    if (!binding) binding = ctx.pool.bind(bind);
    const requestedLength = Math.min(
      ctx.hostListLengths[bind.name] ?? binding.length ?? 0,
      MAX_BUFFER_LENGTH,
    );
    const data = ctx.readHostList(bind.name, requestedLength);
    binding.syncFromHost(data);
  }

  // Dispatch.
  try {
    let pipeline = ctx.pipelines.get(kernel.canonicalKey) ?? null;
    if (!pipeline) {
      pipeline = buildPipelineForKernel(kernel, binds, ctx);
      if (!pipeline) {
        return demoteKernel(kernel, ctx, 'pipeline creation failed', 'd4');
      }
      ctx.pipelines.set(kernel.canonicalKey, pipeline);
    }

    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, pipeline.bindGroups.get(0) ?? null);
    pass.dispatchWorkgroups(Math.max(1, ctx.dims.x), Math.max(1, ctx.dims.y), Math.max(1, ctx.dims.z));
    pass.end();
    ctx.device.queue.submit([encoder.finish()]);
    ctx.onSubmit?.(kernel);

    // Post-dispatch: read every rw binding back into the host list.
    for (const bind of binds) {
      if (bind.readOnly) continue;
      const binding = ctx.pool.get(bind.name);
      if (!binding) continue;
      const result = binding.syncToHost();
      ctx.writeHostList(bind.name, result);
    }
    return { ok: true, demoted: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return demoteKernel(kernel, ctx, message, 'd4');
  }
}

/**
 * Test-only helper: synchronously resolve the readback for any pending
 * dispatches. In real WebGPU this is what `mapAsync` would do; the jsdom
 * mock has no GPU to drain, so we expose this for completeness.
 */
export function completeReadback(_kernelId: string): void {
  // No-op: the host-side mirror is already up-to-date in M5.
}

function handleNoDevice(kernel: Kernel, _ctx: DispatchContext): DispatchResult {
  // device is null. Treat as a one-shot D4 demote with a single
  // console-ish message; do NOT spam the error log (spec §7.1: "no
  // spam").
  useErrorLogStore
    .getState()
    .push(
      'warn',
      `gpu.adapter_unavailable: kernel '${kernel.id}' falls back to JS (no WebGPU)`,
    );
  kernel.jsOnly = true;
  kernel.jsOnlyReason = 'adapter_unavailable';
  return { ok: false, demoted: true, message: 'adapter_unavailable' };
}

function demoteKernel(
  kernel: Kernel,
  _ctx: DispatchContext,
  message: string,
  code: 'd4',
): DispatchResult {
  useErrorLogStore
    .getState()
    .push('warn', `${code}.kernel_runtime_demoted: ${kernel.id} (${message})`);
  kernel.jsOnly = true;
  kernel.jsOnlyReason = message;
  return { ok: false, demoted: true, message };
}

function buildPipelineForKernel(
  kernel: Kernel,
  binds: readonly BindDirective[],
  ctx: DispatchContext,
): GPipeline | null {
  if (
    !ctx.device ||
    typeof ctx.device.createComputePipeline !== 'function' ||
    typeof ctx.device.createBindGroup !== 'function'
  ) {
    return null;
  }
  const module = makeFakeModule(kernel);
  const pipeline = ctx.device.createComputePipeline({
    compute: { module, entryPoint: 'main' },
  });
  const bindGroups = new Map<number, unknown>();
  if (binds.length > 0) {
    const entries = binds.map((bind) => {
      const binding = ctx.pool.get(bind.name);
      return {
        binding: bind.slot,
        resource: { buffer: binding?.gpuBuffer ?? null },
      };
    });
    bindGroups.set(0, ctx.device.createBindGroup({ layout: null, entries }));
  }
  return { bindGroups, pipeline, workgroupSize: { x: 1, y: 1, z: 1 } };
}

function makeFakeModule(kernel: Kernel): unknown {
  // Real WebGPU would compile WGSL here. M5 doesn't run WGSL — the
  // dispatcher is exercised in jsdom with a mock device. We return the
  // WGSL string as the module "handle" so tests can assert what was
  // handed to createComputePipeline.
  return { __wgsl: kernel.wgsl, __canonicalKey: kernel.canonicalKey };
}

/** Cap on buffer length to prevent a runaway `@max` from OOM-ing. */
const MAX_BUFFER_LENGTH = 1 << 20;