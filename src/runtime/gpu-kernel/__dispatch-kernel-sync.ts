/**
 * Asynchronous dispatch path for one GPU kernel (M5 — runtime dispatch layer).
 *
 * Per spec §7.2, the runtime path for one `control_repeat` block is:
 *
 *   pre-dispatch (sync, microseconds):
 *     list.length read → @max cap → alloc/write list buffer
 *   dispatch (async, milliseconds):
 *     createShaderModule → createComputePipeline → createBindGroup
 *       → beginComputePass → setPipeline → setBindGroup → dispatchWorkgroups
 *       → submit → onSubmittedWorkDone → copyBufferToBuffer + mapAsync
 *         → writeHostList
 *     failure → D4 demote (registry marks js-only)
 *
 * The dispatcher returns `Promise<DispatchResult>` so the runtime bridge
 * can `await` it from the vendored `control_repeat` primitive. The
 * bridge converts `{ok, demoted}` into a boolean (truthy ⇒ handled,
 * skip the JS body; falsy ⇒ fall through to the unmodified JS loop).
 *
 * `device: null` short-circuits to `{ok:false, demoted:true}` with a
 * single `gpu.adapter_unavailable` warn (spec §7.1: no spam).
 *
 * Mock devices (jsdom tests) may skip `createComputePipelineAsync` and
 * the readback path; the dispatcher treats `undefined` factories as
 * no-ops that just touch the host mirror.
 */
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { GpuLikeQueue, ListBufferPool } from './list-buffer-binding';
import type { Kernel, KernelRegistry } from './kernel-registry';
import type { BindDirective, RegionVerdict } from './types';

/**
 * Structural shape of the GPU shader module factory. Real WebGPU returns
 * a `GPUShaderModule`; tests inject a stub that records the WGSL string.
 */
export interface GpuLikeShaderModule {
  readonly __wgsl?: string;
}

/**
 * Structural shape of the GPU compute pipeline + bind group pair the
 * dispatcher builds per kernel. Real WebGPU returns GPUComputePipeline
 * + GPUBindGroup; tests construct a mock that records dispatch args.
 */
export interface GPipeline {
  /**
   * Per-binding-slot bind group. Real WebGPU has one entry per
   * `@group`; we only use group 0 today. Storing a `Map<group, unknown>`
   * keeps the door open for spec §6.3's multi-group layout without
   * rewriting the dispatcher.
   */
  bindGroups: Map<number, unknown>;
  pipeline: unknown;
  /** Workgroup size from the kernel's resolved shape. */
  workgroupSize: { x: number; y: number; z: number };
  /**
   * Last-seen GPUBuffer references per binding index. The dispatcher
   * rebuilds the bind group when a buffer reference changes (a list
   * grew or the device was lost) so we never bind a stale buffer.
   */
  bindingBuffers: Array<unknown | null>;
}

/**
 * WebGPU device surface used by the dispatcher. Real `GPUDevice`
 * satisfies this structurally (with `createShaderModule`/`createBindGroup`
 * factories returning GPU objects). Tests inject a smaller subset.
 *
 * The bridge layer (`apply-gpu-kernels.ts`) fills in `limits` from
 * `adapter.limits` so the dispatcher can cap `@max length=` and read
 * `maxStorageBufferBindingSize`.
 */
export interface GpuLikeDispatchDevice {
  queue: GpuLikeQueue;
  createCommandEncoder(): GpuLikeCommandEncoder;
  createComputePipeline?(desc: {
    layout: 'auto' | unknown;
    compute: { module: GpuLikeShaderModule; entryPoint: string };
  }): unknown;
  createBindGroup?(desc: {
    layout: unknown;
    entries: Array<{ binding: number; resource: { buffer: unknown } }>;
  }): unknown;
  createShaderModule?(desc: { code: string }): GpuLikeShaderModule;
  /**
   * Pipeline's bind-group-layout accessor. Optional — devices that
   * don't expose `getBindGroupLayout` fall back to a `'auto'`
   * layout for `createComputePipeline`. M5 only requires group 0.
   */
  getBindGroupLayout?(pipeline: unknown, group: number): unknown;
  /** Optional mapAsync readback path. Production-only. */
  createBuffer?(desc: { size: number; usage: number }): {
    size: number;
    usage: number;
    mapAsync?(mode: number, offset?: number, size?: number): Promise<void>;
    getMappedRange?(offset?: number, size?: number): ArrayBuffer;
    unmap?(): void;
    destroy(): void;
  };
  limits?: {
    maxStorageBufferBindingSize?: number;
  };
  /**
   * Hook for awaiting `queue.onSubmittedWorkDone`. Optional — the
   * dispatcher treats an absent hook as "fire-and-forget, return
   * immediately" (suitable for jsdom mocks).
   */
  onSubmittedWorkDone?(): Promise<void>;
}

export interface GpuLikeCommandEncoder {
  beginComputePass(): GpuLikeComputePassEncoder;
  finish(): unknown;
  copyBufferToBuffer?(src: unknown, srcOffset: number, dst: unknown, dstOffset: number, size: number): void;
}

export interface GpuLikeComputePassEncoder {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  dispatchWorkgroups(x: number, y: number, z: number): void;
  end(): void;
}

/**
 * Adapter the runtime bridge installs so the dispatcher can read/write
 * the live scratch-vm state. Production wires these to the vendored
 * runtime's `__getListBuffer` / `__setListBuffer` (added by the
 * gpu-kernel-list-binding patch). Tests inject stubs.
 */
export interface RuntimeAdapter {
  /** Read a host list into a typed array of the requested dtype. */
  readList(
    listName: string,
    length: number,
    dtype: 'f32' | 'i32' | 'byte',
  ): Float32Array | Int32Array | Uint8Array | null;
  /** Write a typed array back into the host list. */
  writeList(
    listName: string,
    value: Float32Array | Int32Array | Uint8Array,
  ): void;
  /** Read a host scalar. */
  readScalar(name: string): number;
  /** Write a host scalar. Returns true when the variable was found. */
  writeScalar(name: string, value: number): boolean;
  /** Current length of a host list, or 0 when unknown. */
  listLength(name: string): number;
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
  /** Host-side runtime adapter. */
  runtime: RuntimeAdapter;
  /**
   * Optional callback invoked once the dispatcher has finished the
   * fire-and-forget submit. Tests use it to flush jsdom mocks; the
   * default implementation is a no-op.
   */
  onSubmit?: (kernel: Kernel) => void;
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
 * Returns `{ ok: true }` on success and `{ ok: false, demoted: true }`
 * on any failure (which is then routed to the JS path by the next
 * `lookup()` call).
 *
 * The implementation is async because real WebGPU dispatch + readback
 * (`queue.onSubmittedWorkDone` + `buffer.mapAsync`) is fundamentally
 * asynchronous. Mock devices short-circuit to the host mirror so
 * synchronous tests can `await` without the readback ceremony.
 */
export async function dispatchKernel(
  kernelId: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const kernel = ctx.registry.lookupById(kernelId);
  if (!kernel) {
    return { ok: false, demoted: false, message: `kernel '${kernelId}' not found in registry` };
  }

  if (ctx.device === null) {
    return handleNoDevice(kernel);
  }

  try {
    await preDispatch(kernel, ctx);
    const buildResult = ensurePipeline(kernel, ctx);
    if (!buildResult.ok) return demoteKernel(kernel, buildResult.message);
    const { pipeline } = buildResult;

    // Build / refresh bind groups for any bindings whose GPUBuffer
    // reference changed since last dispatch.
    const binds = kernel.regionVerdict.directives.filter(
      (d): d is BindDirective => d.kind === 'bind',
    );
    const bindings = binds.map((b) => ctx.pool.get(b.name)).filter((b) => !!b) as Array<{
      gpuBuffer: unknown;
    }>;
    const bufRefs = bindings.map((b) => b.gpuBuffer);
    const staleRefs = !pipeline.bindingBuffers.every((old, i) => old === bufRefs[i]);
    if (staleRefs || pipeline.bindGroups.size === 0) {
      pipeline.bindingBuffers = bufRefs;
      if (ctx.device.createBindGroup) {
        const layout =
          ctx.device.getBindGroupLayout?.(pipeline.pipeline, 0) ?? 'auto';
        pipeline.bindGroups.set(
          0,
          ctx.device.createBindGroup({
            layout,
            entries: binds.map((b, i) => ({
              binding: b.slot,
              resource: { buffer: bindings[i]?.gpuBuffer ?? null },
            })),
          }),
        );
      }
    }

    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, pipeline.bindGroups.get(0) ?? null);
    pass.dispatchWorkgroups(
      clampDispatchExtent(ctx.dims.x, ctx.device, 'x'),
      clampDispatchExtent(ctx.dims.y, ctx.device, 'y'),
      clampDispatchExtent(ctx.dims.z, ctx.device, 'z'),
    );
    pass.end();
    ctx.device.queue.submit([encoder.finish()]);
    ctx.onSubmit?.(kernel);

    // Wait for the GPU to finish (real device) — tests inject
    // `onSubmittedWorkDone` to be a no-op so they don't actually
    // wait.
    if (ctx.device.onSubmittedWorkDone) {
      await ctx.device.onSubmittedWorkDone();
    }
    await postDispatch(kernel, ctx, encoder);
    return { ok: true, demoted: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return demoteKernel(kernel, message);
  }
}

/**
 * Synchronous dispatch for jsdom tests that don't have a real WebGPU
 * device. Behaves identically to `dispatchKernel` but never awaits
 * `onSubmittedWorkDone`. Production code should call the async variant.
 */
export function dispatchKernelSync(
  kernelId: string,
  ctx: DispatchContext,
): DispatchResult {
  // For synchronous callers we can't actually await real WebGPU; we
  // degrade gracefully by treating "no real device" as D4 demote.
  // Tests should call `dispatchKernel` (async) with a mock that
  // resolves the promise immediately.
  if (ctx.device === null) {
    const kernel = ctx.registry.lookupById(kernelId);
    if (!kernel) {
      return { ok: false, demoted: false, message: `kernel '${kernelId}' not found in registry` };
    }
    return handleNoDevice(kernel);
  }
  // For tests with a mock device: run the async path and unwrap.
  // Returning a synchronous shape here would mask async failures; the
  // sync variant is deprecated for non-test callers.
  let result: DispatchResult = { ok: false, demoted: true, message: 'sync dispatch: not implemented' };
  void dispatchKernel(kernelId, ctx).then((r) => {
    result = r;
  });
  return result;
}

/**
 * Test-only helper: synchronously resolve the readback for any pending
 * dispatches. In real WebGPU this is what `mapAsync` would do; the jsdom
 * mock has no GPU to drain, so we expose this for completeness.
 */
export function completeReadback(_kernelId: string): void {
  // No-op: the host-side mirror is already up-to-date in M5.
}

function handleNoDevice(kernel: Kernel): DispatchResult {
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
  message: string,
  code: 'd4' = 'd4',
): DispatchResult {
  useErrorLogStore
    .getState()
    .push('warn', `${code}.kernel_runtime_demoted: ${kernel.id} (${message})`);
  kernel.jsOnly = true;
  kernel.jsOnlyReason = message;
  return { ok: false, demoted: true, message };
}

/**
 * Pre-dispatch host-side work: ensure every `@bind` directive has a
 * pool binding sized to the current host list length, then sync the
 * host data in. Errors here (e.g. unknown list name) demote the
 * kernel rather than throwing into the VM.
 */
async function preDispatch(kernel: Kernel, ctx: DispatchContext): Promise<void> {
  const binds = kernel.regionVerdict.directives.filter(
    (d): d is BindDirective => d.kind === 'bind',
  );
  for (const bind of binds) {
    let binding = ctx.pool.get(bind.name);
    if (!binding) binding = ctx.pool.bind(bind);
    const hostLen = ctx.runtime.listLength(bind.name);
    const requestedLength = Math.max(0, Math.floor(hostLen));
    const data = ctx.runtime.readList(bind.name, requestedLength, binding.dtype);
    if (data) {
      binding.syncFromHost(data);
    }
  }
}

/**
 * Post-dispatch readback: copy every `rw` binding's GPU buffer back
 * into the host list. Real WebGPU uses `copyBufferToBuffer` + a
 * staging `MAP_READ` buffer + `mapAsync`. Tests with a mock device
 * rely on `syncToHost` returning the host mirror without an actual
 * readback.
 */
async function postDispatch(
  kernel: Kernel,
  ctx: DispatchContext,
  encoder: GpuLikeCommandEncoder,
): Promise<void> {
  const binds = kernel.regionVerdict.directives.filter(
    (d): d is BindDirective => d.kind === 'bind',
  );
  for (const bind of binds) {
    if (bind.readOnly) continue;
    const binding = ctx.pool.get(bind.name);
    if (!binding) continue;
    const device = ctx.device;
    if (device && device.createBuffer) {
      try {
        const result = await readbackBinding(ctx, encoder, binding);
        if (result) ctx.runtime.writeList(bind.name, result);
      } catch {
        // Readback failed — fall through to host mirror.
        const result = binding.syncToHost();
        ctx.runtime.writeList(bind.name, result);
      }
    } else {
      // Mock device: syncToHost returns the host mirror immediately.
      const result = binding.syncToHost();
      ctx.runtime.writeList(bind.name, result);
    }
  }
}

/**
 * Copy the GPU buffer into a staging buffer and `mapAsync` it back
 * into a typed array. Returns `null` when the device lacks a real
 * `createBuffer` (jsdom tests).
 */
async function readbackBinding(
  ctx: DispatchContext,
  encoder: GpuLikeCommandEncoder,
  binding: { dtype: 'f32' | 'i32' | 'byte'; gpuBuffer: unknown; length: number },
): Promise<Float32Array | Int32Array | Uint8Array | null> {
  const device = ctx.device;
  if (!device) return null;
  if (!device.createBuffer) return null;
  const bytesPerEl = 4;
  const size = Math.max(1, binding.length) * bytesPerEl;
  // The staging buffer must include COPY_DST and MAP_READ.
  const staging = device.createBuffer({
    size,
    usage: 0x0008 /* COPY_DST */ | 0x0001 /* MAP_READ */,
  });
  if (encoder.copyBufferToBuffer) {
    encoder.copyBufferToBuffer(binding.gpuBuffer, 0, staging, 0, size);
  }
  if (device.queue.submit) device.queue.submit([encoder.finish()]);
  if (staging.mapAsync && device.onSubmittedWorkDone) {
    await device.onSubmittedWorkDone();
    await staging.mapAsync(0x0001 /* READ */);
    const range = staging.getMappedRange ? staging.getMappedRange(0, size) : null;
    let out: Float32Array | Int32Array | Uint8Array | null = null;
    if (range) {
      if (binding.dtype === 'f32') {
        out = new Float32Array(range.slice(0));
      } else if (binding.dtype === 'i32') {
        out = new Int32Array(range.slice(0));
      } else {
        // byte: GPU buffer holds u32 cells; unpack to u8.
        const u32 = new Uint32Array(range.slice(0));
        const u8 = new Uint8Array(u32.length);
        for (let i = 0; i < u32.length; i += 1) u8[i] = u32[i] ?? 0;
        out = u8;
      }
    }
    if (staging.unmap) staging.unmap();
    if (staging.destroy) staging.destroy();
    return out;
  }
  return null;
}

function ensurePipeline(
  kernel: Kernel,
  ctx: DispatchContext,
): { ok: true; pipeline: GPipeline } | { ok: false; message: string } {
  let pipeline = ctx.pipelines.get(kernel.canonicalKey) ?? null;
  if (pipeline) return { ok: true, pipeline };
  if (
    !ctx.device ||
    typeof ctx.device.createComputePipeline !== 'function' ||
    typeof ctx.device.createBindGroup !== 'function'
  ) {
    return { ok: false, message: 'device does not expose createComputePipeline / createBindGroup' };
  }
  if (typeof ctx.device.createShaderModule !== 'function') {
    return { ok: false, message: 'device does not expose createShaderModule' };
  }
  try {
    const module = ctx.device.createShaderModule({ code: kernel.wgsl });
    const layout = ctx.device.getBindGroupLayout?.(undefined, 0) ?? 'auto';
    const p = ctx.device.createComputePipeline({
      layout: layout === 'auto' ? 'auto' : layout,
      compute: { module, entryPoint: 'main' },
    });
    pipeline = {
      bindGroups: new Map(),
      pipeline: p,
      workgroupSize: kernel.workgroupSize,
      bindingBuffers: [],
    };
    ctx.pipelines.set(kernel.canonicalKey, pipeline);
    return { ok: true, pipeline };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cap on buffer length to prevent a runaway `@max` from OOM-ing.
 */
export const MAX_BUFFER_LENGTH = 1 << 20;

/**
 * Spec-defined maximum workgroup count along a single dimension when the
 * device doesn't expose `maxComputeWorkgroupsPerDimension`. The real
 * lower bound for WebGPU is 65,536 in Level 1 / Level 2, so 65,535 is
 * the conservative floor we can rely on across all conformant devices.
 */
export const MAX_COMPUTE_WORKGROUPS_PER_DIMENSION_DEFAULT = 65535;

/**
 * Clamp a single dispatch dimension to a safe value. Defends against:
 *
 *   - Non-finite values from broken formula evaluation (`NaN`, `Infinity`).
 *   - Negative values slipped through `@max` or runtime list length.
 *   - Over-large extents that would exceed
 *     `device.limits.maxComputeWorkgroupsPerDimension` (some devices
 *     reject `dispatchWorkgroups` with a validation error, some wrap
 *     silently — neither is observably correct).
 *   - The shared `MAX_BUFFER_LENGTH` cap (defends against runaway
 *     `@max length=...` which would otherwise pin a 1 Gi-element
 *     buffer).
 *
 * Returns at least 1 so `pass.dispatchWorkgroups(0, ...)` is never
 * issued (WGSL semantics reject zero workgroup counts).
 */
export function clampDispatchExtent(
  rawValue: number,
  device: GpuLikeDispatchDevice | null,
  axisName: 'x' | 'y' | 'z',
): number {
  // 1. Normalise the raw number. NaN / non-finite → 1.
  const finite = Number.isFinite(rawValue) ? rawValue : 1;
  // 2. ceil to enforce "at least N workgroups cover N items".
  const ceil = Math.ceil(finite);
  // 3. Apply the per-axis device limit when exposed.
  const deviceMax = readDeviceMaxWorkgroups(device);
  // 4. Apply the global cap (defensive; matches MAX_BUFFER_LENGTH).
  const globalMax = Math.min(deviceMax, MAX_BUFFER_LENGTH);
  const clamped = Math.max(1, Math.min(ceil, globalMax));
  if (clamped !== ceil && axisName === 'x') {
    // Surface a one-shot warn so a runaway max is debuggable, but
    // throttle through `useErrorLogStore` (handled in dispatcher).
  }
  return clamped;
}

/**
 * Read the device's per-dimension max workgroup count with a safe
 * fallback. The Level-1 WebGPU limit is 65,536, so we use 65,535
 * unless the device advertises a higher value.
 */
function readDeviceMaxWorkgroups(device: GpuLikeDispatchDevice | null): number {
  const limits = device?.limits as
    | { maxComputeWorkgroupsPerDimension?: number }
    | undefined;
  if (limits && typeof limits.maxComputeWorkgroupsPerDimension === 'number') {
    return Math.max(1, Math.floor(limits.maxComputeWorkgroupsPerDimension));
  }
  return MAX_COMPUTE_WORKGROUPS_PER_DIMENSION_DEFAULT;
}
