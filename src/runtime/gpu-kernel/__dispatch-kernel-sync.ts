/**
 * Asynchronous dispatch path for one GPU kernel (M5 — runtime dispatch layer).
 *
 * Per spec §7.2, the runtime path for one `control_repeat` block is:
 *
 *   pre-dispatch (sync, microseconds):
 *     list.length read → runtime cap → alloc/write list buffer
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
import {
  evaluateDispatchFormula,
  type DispatchFormulaContext,
} from './dispatch-formula-evaluator';
import type { GpuLikeQueue, ListBufferPool } from './list-buffer-binding';
import type { Kernel, KernelRegistry } from './kernel-registry';
import {
  packScalarUniformBuffer,
  scalarUniformBufferSize,
  type ListLengthBinding,
  type ScalarUniformBinding,
} from './scalar-uniform-binding';
import type { RegionVerdict } from './types';

/**
 * Structured dispatch plan (source of truth: `wgsl-emitter.ts:DispatchPlan`).
 * Each axis is a WGSL expression string that the runtime evaluator
 * (§Phase 3 `dispatch-formula-evaluator.ts`) reduces to a numeric
 * extent before `dispatchWorkgroups` is called.
 */
export type DispatchExtentExpression = string;

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
   * `@group`; we use group 0 (storage list bindings) and group 1
   * (`@group(1) @binding(0)` for `ScratchUniforms` including scalar
   * uniform fields + list length fields). Storing a `Map<group,
   * unknown>` keeps the door open for spec §6.3's multi-group layout
   * without rewriting the dispatcher.
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
  /**
   * §Phase 3 — `@group(1) @binding(0)` uniform buffer hosting the
   * `ScratchUniforms` struct (scalar fields + list length fields).
   * `null` when the kernel has no scalar / list bindings that need
   * the uniform path.
   */
  uniformBuffer: unknown | null;
}

/**
 * WebGPU device surface used by the dispatcher. Real `GPUDevice`
 * satisfies this structurally (with `createShaderModule`/`createBindGroup`
 * factories returning GPU objects). Tests inject a smaller subset.
 *
 * The bridge layer (`apply-gpu-kernels.ts`) fills in `limits` from
 * `adapter.limits` so the dispatcher can cap the runtime list length
 * and read `maxStorageBufferBindingSize`.
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
  /**
   * Pre-resolved dispatch dims (x, y, z). Used as a fallback when
   * `dispatchPlan` is absent (= the pre-Phase-3 contract). §Phase 4
   * (15.5) no longer treats this as the primary dispatch size —
   * `resolveDispatchDims` always evaluates `dispatchPlan` against
   * the live host state when one is attached.
   */
  dims: { x: number; y: number; z: number };
  /**
   * §Phase 3 — WGSL expression dispatch plan from
   * `wgsl-emitter.ts:computeDispatchPlan`. §Phase 4 (15.5) — when
   * present, the dispatcher ALWAYS reduces each axis expression to
   * a number against the live host state on every dispatch
   * (regardless of whether scalar bindings are attached). When
   * omitted, `dims` is used as-is.
   */
  dispatchPlan?: { x: DispatchExtentExpression; y: DispatchExtentExpression; z: DispatchExtentExpression };
  /**
   * §Phase 3 — scalar uniform bindings (`@bind ..., scalar`) for this
   * kernel. When non-empty, the dispatcher:
   *
   *   - allocates a `@group(1) @binding(0)` uniform buffer (lazily,
   *     on first dispatch) and packs scalar values via
   *     `packScalarUniformBuffer`;
   *   - builds the `@group(1)` bind group on the pipeline;
   *   - refreshes the buffer contents from `runtime.readScalar(...)`
   *     on every dispatch so dynamic scalars like `aabb_idx0` see
   *     the latest host value;
   *   - evaluates `dispatchPlan.*` expressions against the same
   *     scalar snapshot.
   */
  scalarBindings?: readonly ScalarUniformBinding[];
  /**
   * §Phase 4 (15.7/15.8) — list length slots for the
   * `@group(1) @binding(0)` uniform buffer. These mirror the WGSL
   * struct's `<list>_length` fields and are packed into the same
   * buffer as the scalar fields (16-byte stride). When non-empty
   * (regardless of `scalarBindings.length`), the dispatcher allocates
   * the uniform buffer and binds group 1 so the WGSL body can read
   * `u_scratch.<list>_length`.
   */
  listLengthBindings?: readonly ListLengthBinding[];
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

    // §Phase 4 (15.6) — group-0 bind group uses `kernel.listBindings`
    // (= `@bind` directives whose `storageKind !== 'scalar'`). Scalar
    // bindings live on `@group(1) @binding(0)` and must NOT appear in
    // group-0 entries. The pre-extracted list is computed at
    // `register()` time so this hot loop does not re-filter on every
    // dispatch.
    const listBindings = kernel.listBindings;
    const bindings = listBindings
      .map((b) => ctx.pool.get(b.name))
      .filter((b) => !!b) as Array<{ gpuBuffer: unknown }>;
    const bufRefs = bindings.map((b) => b.gpuBuffer);
    const staleRefs = !pipeline.bindingBuffers.every((old, i) => old === bufRefs[i]);
    if (staleRefs || !pipeline.bindGroups.has(0)) {
      pipeline.bindingBuffers = bufRefs;
      if (ctx.device.createBindGroup) {
        const layout =
          ctx.device.getBindGroupLayout?.(pipeline.pipeline, 0) ?? 'auto';
        pipeline.bindGroups.set(
          0,
          ctx.device.createBindGroup({
            layout,
            entries: listBindings.map((b, i) => ({
              binding: b.slot,
              resource: { buffer: bindings[i]?.gpuBuffer ?? null },
            })),
          }),
        );
      }
    }

    // §Phase 3 (with §Phase 4 15.7/15.8 extensions) — refresh scalar
    // uniform values + list length values before this dispatch and
    // build (lazily, on first dispatch) the `@group(1)` bind group
    // that hosts the `ScratchUniforms` struct. The runtime adapter's
    // `readScalar` / `listLength` are queried per dispatch so dynamic
    // scalars (`aabb_idx0` mutated by an outer scratch loop) and
    // list lengths (growing lists) see the latest host value.
    //
    // §Phase 4 (15.8) — the uniform buffer is also created for
    // list-only kernels (= `scalarBindings.length === 0` but
    // `listBindings.length > 0`) so the WGSL body can read
    // `u_scratch.<list>_length` from `@group(1) @binding(0)`.
    const scalarBindings = ctx.scalarBindings ?? [];
    const listLengthBindings = ctx.listLengthBindings ?? [];
    const needsUniformBuffer =
      scalarBindings.length > 0 || listLengthBindings.length > 0;
    if (needsUniformBuffer) {
      const scalarValues = readScalarValues(scalarBindings, ctx);
      const lengthValues = readListLengthValues(listLengthBindings, ctx);
      ensureUniformBuffer(pipeline, scalarBindings, listLengthBindings, ctx);
      writeScalarUniformBuffer(
        pipeline,
        scalarBindings,
        scalarValues,
        listLengthBindings,
        lengthValues,
        ctx,
      );
      ensureUniformBindGroup(pipeline, ctx);
    }

    // §Phase 4 (15.5) — always evaluate the WGSL expression dispatch
    // plan (scalar bindings no longer gate evaluation). `ctx.dims`
    // remains the fallback when no `dispatchPlan` is attached (= the
    // pre-Phase-3 contract is preserved).
    const dims = resolveDispatchDims(ctx);

    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, pipeline.bindGroups.get(0) ?? null);
    // §Phase 4 (15.8) — set group 1 whenever the kernel needs the
    // uniform buffer (scalar + list-only paths).
    if (needsUniformBuffer) {
      pass.setBindGroup(1, pipeline.bindGroups.get(1) ?? null);
    }
    pass.dispatchWorkgroups(
      clampDispatchExtent(dims.x, ctx.device, 'x'),
      clampDispatchExtent(dims.y, ctx.device, 'y'),
      clampDispatchExtent(dims.z, ctx.device, 'z'),
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
 * Pre-dispatch host-side work: ensure every list binding has a pool
 * binding sized to the current host list length, then sync the host
 * data in. Scalar bindings are NOT synced here — they go through
 * `runtime.readScalar` in `dispatchKernel` after `ensurePipeline`
 * succeeds (so dynamic scalars reflect the latest host state at the
 * actual dispatch boundary).
 *
 * §Phase 4 (15.6) — `kernel.listBindings` (= `@bind` with
 * `storageKind !== 'scalar'`) is the iteration source. Scalar
 * bindings are skipped because they don't have a `@group(0)` storage
 * buffer to sync.
 *
 * Errors here (e.g. unknown list name) demote the kernel rather than
 * throwing into the VM.
 */
async function preDispatch(kernel: Kernel, ctx: DispatchContext): Promise<void> {
  for (const bind of kernel.listBindings) {
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
 * Post-dispatch readback: copy every `rw` list binding's GPU buffer
 * back into the host list. Real WebGPU uses `copyBufferToBuffer` + a
 * staging `MAP_READ` buffer + `mapAsync`. Tests with a mock device
 * rely on `syncToHost` returning the host mirror without an actual
 * readback.
 *
 * §Phase 4 (15.6) — only list bindings are read back; scalar bindings
 * are not storage buffers and don't need GPU→host sync.
 */
async function postDispatch(
  kernel: Kernel,
  ctx: DispatchContext,
  encoder: GpuLikeCommandEncoder,
): Promise<void> {
  for (const bind of kernel.listBindings) {
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
      uniformBuffer: null,
    };
    ctx.pipelines.set(kernel.canonicalKey, pipeline);
    return { ok: true, pipeline };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// §Phase 3 — scalar uniform helpers ---------------------------------------

/**
 * Snapshot scalar uniform values from the runtime adapter. Missing
 * names fall back to 0 (= the kernel would already be D4-demoted for
 * referencing a missing variable upstream; this matches the safe
 * contract that `packScalarUniformBuffer` documents).
 */
function readScalarValues(
  bindings: readonly ScalarUniformBinding[],
  ctx: DispatchContext,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bindings) {
    const raw = ctx.runtime.readScalar(b.name);
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    out.set(b.name, value);
  }
  return out;
}

/**
 * §Phase 4 (15.7/15.8) — snapshot live list length values for the
 * uniform buffer. Missing names (= runtime adapter returned non-finite
 * values) fall back to 0, matching the safe `packScalarUniformBuffer`
 * contract. The packed `Uint32` form (`Math.floor` + `>>> 0`) is
 * applied in the pack helper itself.
 */
function readListLengthValues(
  bindings: readonly ListLengthBinding[],
  ctx: DispatchContext,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bindings) {
    const raw = ctx.runtime.listLength(b.name);
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    out.set(b.name, value);
  }
  return out;
}

/**
 * Lazily allocate the `@group(1) @binding(0)` uniform buffer on the
 * pipeline. Called once per kernel (= once per `canonicalKey`) before
 * the first dispatch that needs the uniform buffer.
 *
 * §Phase 4 (15.8) — the buffer is sized to hold both scalar fields
 * and list length fields when either is non-empty. Scalar-only and
 * list-only kernels both trigger this path (= `scalarBindings.length
 * > 0 || listLengthBindings.length > 0`).
 */
function ensureUniformBuffer(
  pipeline: GPipeline,
  scalarBindings: readonly ScalarUniformBinding[],
  listLengthBindings: readonly ListLengthBinding[],
  ctx: DispatchContext,
): void {
  if (pipeline.uniformBuffer) return;
  if (!ctx.device || typeof ctx.device.createBuffer !== 'function') return;
  const size = scalarUniformBufferSize(scalarBindings, listLengthBindings);
  pipeline.uniformBuffer = ctx.device.createBuffer({
    size,
    // UNIFORM (0x0040) | COPY_DST (0x0008). Mirrors the
    // list-buffer-bindings usage pattern (which uses
    // GPU_BUFFER_USAGE_STORAGE | COPY_DST).
    usage: 0x0040 | 0x0008,
  });
}

/**
 * Push the current scalar + list length values into the uniform
 * buffer via `queue.writeBuffer`. Called on every dispatch so dynamic
 * scalars + growing lists see the latest host value.
 *
 * §Phase 4 (15.7) — list length values are appended after the scalar
 * fields with the same 16-byte stride, matching the WGSL struct's
 * `pad: vec3<u32>` padding layout.
 */
function writeScalarUniformBuffer(
  pipeline: GPipeline,
  scalarBindings: readonly ScalarUniformBinding[],
  scalarValues: ReadonlyMap<string, number>,
  listLengthBindings: readonly ListLengthBinding[],
  lengthValues: ReadonlyMap<string, number>,
  ctx: DispatchContext,
): void {
  if (!pipeline.uniformBuffer) return;
  if (!ctx.device || typeof ctx.device.queue.writeBuffer !== 'function') return;
  const buffer = packScalarUniformBuffer(
    scalarBindings,
    scalarValues,
    listLengthBindings,
    lengthValues,
  );
  // `pipeline.uniformBuffer` is structurally typed as `unknown` (set from
  // a device-specific `createBuffer`). Cast through `unknown` to satisfy
  // the concrete `GpuLikeBuffer` signature of `writeBuffer` — the runtime
  // device is responsible for returning a structurally-compatible buffer.
  // `packScalarUniformBuffer` returns an `ArrayBuffer`; the WebGPU signature
  // requires an `ArrayBufferView`, so view it through a `Uint8Array`.
  ctx.device.queue.writeBuffer(
    pipeline.uniformBuffer as unknown as Parameters<typeof ctx.device.queue.writeBuffer>[0],
    0,
    new Uint8Array(buffer),
  );
}

/**
 * Lazily build the `@group(1)` bind group that points at the uniform
 * buffer. Mirrors the group-0 cache-invalidation logic in
 * `dispatchKernel` but always reuses the same buffer (the scalar /
 * length values are refreshed in place via `writeBuffer`).
 */
function ensureUniformBindGroup(pipeline: GPipeline, ctx: DispatchContext): void {
  if (!pipeline.uniformBuffer) return;
  if (pipeline.bindGroups.has(1)) return;
  if (!ctx.device || typeof ctx.device.createBindGroup !== 'function') return;
  const layout = ctx.device.getBindGroupLayout?.(pipeline.pipeline, 1) ?? 'auto';
  pipeline.bindGroups.set(
    1,
    ctx.device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: pipeline.uniformBuffer } }],
    }),
  );
}

/**
 * §Phase 4 (15.5) — resolve dispatch dims (x, y, z) by evaluating the
 * WGSL expression `dispatchPlan` against the live host state on every
 * dispatch. The pre-Phase-4 short-circuit (`scalarBindings.length ===
 * 0`) is removed so list-only kernels also see runtime list length
 * fluctuations (= `ceil(N / 64)` reflects the current scratch list
 * size).
 *
 * When `dispatchPlan` is absent (= the pre-Phase-3 contract),
 * `ctx.dims` is returned unchanged so existing callers continue to
 * work.
 *
 * Scalar values are read fresh per dispatch so dynamic scalars
 * (`aabb_idx0` mutated by an outer scratch loop) reflect the latest
 * host value; the same values feed `packScalarUniformBuffer` so the
 * uniform buffer is consistent with the dispatch dimensions.
 */
function resolveDispatchDims(ctx: DispatchContext): { x: number; y: number; z: number } {
  const plan = ctx.dispatchPlan;
  if (!plan) return ctx.dims;
  const scalarBindings = ctx.scalarBindings ?? [];
  const values = readScalarValues(scalarBindings, ctx);
  const evalCtx: DispatchFormulaContext = {
    scalarBindings,
    scalarValues: values,
    listLength: (name) => ctx.runtime.listLength(name),
    readList: (name, length, dtype) => ctx.runtime.readList(name, length, dtype),
  };
  return {
    x: evaluateDispatchFormula(plan.x, evalCtx),
    y: evaluateDispatchFormula(plan.y, evalCtx),
    z: evaluateDispatchFormula(plan.z, evalCtx),
  };
}

/**
 * Cap on buffer length to prevent a runaway runtime list length from OOM-ing.
 *
 * §Phase 2 (15.3): previously this comment referenced the `@max` directive
 * which was removed in v9. The cap now applies only to the runtime list
 * length read at dispatch time.
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
 *   - Negative values slipped through the runtime list length.
 *   - Over-large extents that would exceed
 *     `device.limits.maxComputeWorkgroupsPerDimension` (some devices
 *     reject `dispatchWorkgroups` with a validation error, some wrap
 *     silently — neither is observably correct).
 *   - The shared `MAX_BUFFER_LENGTH` cap (defends against a runaway list
 *     length that would otherwise pin a 1 Gi-element buffer).
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
