/**
 * List ↔ GPU buffer binding pool (M5 — runtime dispatch layer).
 *
 * Per spec §6.3, scratch-vm lists (and scalar values that act as one-cell
 * lists) are mirrored into WebGPU storage buffers. Each `@bind name(slot)`
 * directive in a `@compute` region becomes one `ListBufferBinding` in the
 * pool; the runtime sync layer reads the list out of scratch-vm, uploads
 * it to the GPU, runs the kernel, and writes the result back.
 *
 * The pool is **driver-portable**: the underlying WebGPU device is typed
 * structurally via `GpuLikeDevice`, so a future real `GPUDevice` and a
 * jsdom mock both fit. Tests construct a mock with just `createBuffer` +
 * `queue: { writeBuffer, submit, ... }` and the rest of the pipeline
 * works.
 *
 * # byte dtype ABI
 *
 * `byte` is host-side `Uint8Array` (N bytes). The WGSL emitter emits
 * `array<u32>` storage with N cells, one per byte. Each u32 holds the
 * byte value in its low 8 bits; the high 24 bits are zero. The physical
 * GPU buffer is therefore `N * 4` bytes wide. `syncFromHost` packs the
 * Uint8Array into a Uint32Array before upload; `syncToHost` unpacks on
 * readback. This keeps the host API semantically clean (a list of
 * bytes) while letting WGSL operate on a host-shareable type without
 * requiring the `array<u8>` type, which is not host-shareable in WGSL
 * without `enable chromium_experimental_pixel_local`.
 *
 * # Cache invalidation on size change
 *
 * If a list grew between dispatches, the existing GPU buffer may be
 * too small to hold the new data. `syncFromHost` reallocates the GPU
 * buffer in that case; the dispatcher also re-creates the bind group
 * because the underlying `GPUBuffer` reference changes (see
 * `__dispatch-kernel-sync.ts`).
 *
 * # Aggregate memory budget (§Phase 3)
 *
 * Each `ensureBuffer` call updates `pool.bufferBudgetBytes()` —
 * cumulative bytes for every buffer the pool currently owns. When the
 * budget crosses 80% of `device.limits.maxStorageBufferBindingSize` (or
 * the conservative 256 MiB fallback when no device is present), a
 * `gpu.regional_buffer_memory_pressure` warn is forwarded to
 * `useErrorLogStore`. The pool's `totalBufferBytes` resets whenever
 * the device is replaced or `resetBufferBudget()` is invoked (= the
 * explicit test seam).
 */
import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import type { BindDirective } from './types';
import { useErrorLogStore } from '@/stores/useErrorLogStore';

export type ListBufferDtype = 'f32' | 'i32' | 'byte';

/**
 * Structural shape of a WebGPU `GPUBuffer`. The M5 module never imports
 * `@webgpu/types` at runtime — that package is type-only, and the runtime
 * fields are kept minimal so a test mock can supply them trivially.
 */
export interface GpuLikeBuffer {
  readonly size: number;
  readonly usage: number;
  destroy(): void;
}

/**
 * Structural shape of a WebGPU `GPUQueue`. Only the operations the M5
 * pool actually calls are exposed.
 */
export interface GpuLikeQueue {
  writeBuffer(
    buffer: GpuLikeBuffer,
    bufferOffset: number,
    data: ArrayBufferView,
    dataOffset?: number,
    size?: number,
  ): void;
  submit(commandBuffers?: Iterable<unknown>): void;
}

/**
 * Structural shape of a WebGPU `GPUDevice`. The pool never calls
 * `createComputePipeline` / `createBindGroup` itself — those happen in
 * `applyGpuKernels` / `__dispatch-kernel-sync` — but it does need to
 * create buffers and write to them.
 */
export interface GpuLikeDevice {
  readonly queue: GpuLikeQueue;
  createBuffer(desc: { size: number; usage: number }): GpuLikeBuffer;
  /** Optional `limits` for devices that expose them. */
  readonly limits?: {
    maxStorageBufferBindingSize?: number;
  };
}

/** GPU buffer usage flags the pool combines when allocating. */
export const GPU_BUFFER_USAGE_STORAGE = 0x0080;
export const GPU_BUFFER_USAGE_COPY_DST = 0x0004;
export const GPU_BUFFER_USAGE_COPY_SRC = 0x0001;

/** Bytes per element for each supported dtype. */
export const BYTES_PER_ELEMENT: Readonly<Record<ListBufferDtype, number>> = {
  f32: 4,
  i32: 4,
  // `byte` dtype is a 2-stage representation: host-side Uint8Array
  // (1 byte) ↔ WGSL `array<u32>` (4 byte). The physical GPU buffer is
  // one u32 per byte, holding the byte value in the low 8 bits. The
  // packing/unpacking conversion lives in `packBytesToU32` (`:443`)
  // and the inverse in `syncToHost`; logical 1-byte reads/writes are
  // re-established by `scratch_list_read_u32` and
  // `scratch_list_write_u32` in `scratch-compat.ts`. See the module
  // doc comment for the broader design rationale (§19.2 #11
  // resolved).
  byte: 4,
};

/**
 * Conservative fallback when the WebGPU device does not expose
 * `maxStorageBufferBindingSize`. Matches the spec §6.3 default. Tests
 * construct minimal mock devices that omit `limits` entirely; the
 * fallback keeps the 80%-threshold math stable across hosts.
 */
const DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE = 256 * 1024 * 1024;

/**
 * Region metadata attached to each binding. Phase 3 propagates the
 * owning `regionId` and `kernelContainerBlockId` so the
 * `gpu.regional_buffer_memory_pressure` diagnostic can name the source
 * region in its `useErrorLogStore` message.
 */
export interface BindingRegionMetadata {
  regionId: string;
  regionBlockId: string;
}

/**
 * One named binding (a scratch-vm list or scalar) backed by a GPU
 * storage buffer. The pool owns a `Map<listName, ListBufferBinding>` and
 * hands them out to the dispatch layer.
 */
export interface ListBufferBinding {
  /** The `@bind name` from the region. */
  readonly listName: string;
  /** The GPU `@group(0) @binding(N)` slot. */
  readonly slot: number;
  /** Element type. Determines host mirror kind. */
  readonly dtype: ListBufferDtype;
  /** Whether the region declares the binding as `ro`. */
  readonly readOnly: boolean;
  /** Allocated element count. Mirrors the runtime list length at dispatch time. */
  length: number;
  /** Lazily-allocated GPU buffer. `null` until first sync. */
  gpuBuffer: GpuLikeBuffer | null;
  /**
   * §Phase 3 — owning region id (`region:<sprite>:<blockId>:<index>`).
   * `null` for bindings registered without region metadata (legacy
   * callers; rare in practice).
   */
  readonly regionId: string | null;
  /** §Phase 3 — kernel container block id for diagnostic attribution. */
  readonly regionBlockId: string | null;
  /**
   * Push the host list into the GPU buffer. Allocates the buffer lazily
   * if this is the first call. `value` may be a `Float32Array`,
   * `Int32Array`, `Uint8Array`, or plain `number[]` (auto-converted).
   */
  syncFromHost(value: number[] | Float32Array | Int32Array | Uint8Array): void;
  /**
   * Pull the GPU buffer back into the host mirror. In M5 we return the
   * host mirror synchronously (real WebGPU would require `mapAsync`).
   * The returned typed array is a fresh slice — callers can mutate it
   * without affecting future syncs.
   */
  syncToHost(): Float32Array | Int32Array | Uint8Array;
  /** Drop the GPU buffer and the host mirror. Next sync reallocates. */
  destroy(): void;
}

export interface ListBufferPoolOptions {
  /**
   * The WebGPU device. `null` means "no device available" — sync calls
   * become no-ops that just update the host mirror. This is the path
   * jsdom tests and Safari/older browsers fall into.
   */
  device: GpuLikeDevice | null;
}

/**
 * The pool is the single source of truth for "which bindings exist, and
 * where do they live on the GPU". The dispatch layer asks the pool for
 * a binding by name; the pool creates / recreates / returns it.
 */
export class ListBufferPool {
  private readonly bindings = new Map<string, ListBufferBinding>();
  private device: GpuLikeDevice | null;
  /**
   * §Phase 3 — aggregate bytes the pool currently owns (sum of every
   * `gpuBuffer.size` minus the bytes returned to the host on
   * `destroyBinding`). Updated in `ensureBuffer` /
   * `destroyBinding` / `forDeviceLost` / `clear`.
   */
  private totalBufferBytes = 0;

  constructor(options: ListBufferPoolOptions) {
    this.device = options.device;
  }

  /**
   * §Phase 3 — internal counter used by `attachBudgetWriters`. Kept
   * package-private via the leading underscore prefix so the budget
   * reader/writer closures installed in `bind()` can update the
   * aggregate without taking a public API dependency on the field.
   */
  _bumpBudget(delta: number): void {
    this.totalBufferBytes = Math.max(0, this.totalBufferBytes + delta);
  }

  /**
   * Set / replace the device. Existing bindings have their GPU buffers
   * destroyed (they belonged to the old device) and the host mirror is
   * preserved so the next `syncFromHost` knows the desired shape. The
   * byte budget resets to zero because the new device has its own
   * limits (we have no way to predict whether buffers of the same
   * shape will fit).
   */
  setDevice(device: GpuLikeDevice | null): void {
    if (this.device === device) return;
    this.device = device;
    for (const binding of this.bindings.values()) {
      const internal = internalStateOf(binding);
      if (internal.gpuBuffer) {
        try {
          internal.gpuBuffer.destroy();
        } catch {
          /* swallow — buffer may already be lost */
        }
        internal.gpuBuffer = null;
      }
      rebindMethods(binding, this.device);
    }
    this.totalBufferBytes = 0;
  }

  /** The current device, or `null` if WebGPU is unavailable. */
  getDevice(): GpuLikeDevice | null {
    return this.device;
  }

  /**
   * Register / overwrite a binding. The binding's metadata (`name`,
   * `slot`, `dtype`, `readOnly`) is taken from the bind directive. If a
   * binding with the same name already exists, the existing GPU buffer
   * is destroyed (it may have been sized differently) and the metadata
   * is updated in place — the public `ListBufferBinding` instance stays
   * the same so callers can hold a reference across rebinds.
   *
   * §Phase 3 — `regionMetadata` is optional. When provided, the new
   * binding carries the owning region's id / kernel-container id so
   * any `gpu.regional_buffer_memory_pressure` diagnostic surfaces the
   * source region.
   */
  bind(directive: BindDirective, regionMetadata?: BindingRegionMetadata): ListBufferBinding {
    const existing = this.bindings.get(directive.name);
    if (existing) {
      // `existing` is the public-facing wrapper; the underlying
      // MutableBinding is held via `internalStateOf(existing)`.
      const internal = internalStateOf(existing);
      if (internal.gpuBuffer) {
        try {
          internal.gpuBuffer.destroy();
        } catch {
          /* device may already be lost — swallow */
        }
        this.totalBufferBytes = Math.max(0, this.totalBufferBytes - internal.gpuBuffer.size);
        internal.gpuBuffer = null;
      }
      internal.slot = directive.slot;
      internal.dtype = directive.dtype;
      internal.readOnly = directive.readOnly;
      internal.length = 0;
      internal.regionId = regionMetadata?.regionId ?? null;
      internal.regionBlockId = regionMetadata?.regionBlockId ?? null;
      setHostMirror(internal, emptyTypedArray(directive.dtype));
      // Update the device pointer on the sync functions (the wrapper
      // closes over `this.device`, so we need to rebind them).
      rebindMethods(existing, this.device);
      // §Phase 3 — re-attach the budget reader/writer in case the pool
      // instance was swapped (e.g. `setDevice` cloned the binding).
      attachBudgetWriters(internal, this);
      return existing;
    }
    const binding = createBinding(directive, this.device, regionMetadata);
    const internal = internalStateOf(binding);
    attachBudgetWriters(internal, this);
    this.bindings.set(directive.name, binding);
    return binding;
  }

  /** Get a binding by name. Returns `undefined` if not registered. */
  get(listName: string): ListBufferBinding | undefined {
    return this.bindings.get(listName);
  }

  /** Number of registered bindings. */
  size(): number {
    return this.bindings.size;
  }

  /**
   * §Phase 3 — aggregate bytes the pool currently owns (= sum of every
   * binding's `gpuBuffer.size`). Returns `0` when the device is
   * unavailable (sync calls never allocate buffers in that path).
   */
  bufferBudgetBytes(): number {
    return this.totalBufferBytes;
  }

  /**
   * §Phase 3 — test seam for the budget counter. Production code does
   * not call this; tests reset between scenarios so the
   * `gpu.regional_buffer_memory_pressure` threshold logic is exercised
   * deterministically.
   */
  resetBufferBudget(): void {
    this.totalBufferBytes = 0;
  }

  /**
   * Drop every GPU buffer (spec §6.3: device-lost path). The host-side
   * mirrors survive so the next `syncFromHost` knows the desired shape;
   * the GPU buffer is reallocated lazily.
   */
  forDeviceLost(): void {
    for (const binding of this.bindings.values()) {
      const internal = internalStateOf(binding);
      if (internal.gpuBuffer) {
        try {
          internal.gpuBuffer.destroy();
        } catch {
          /* swallow — buffer may already be lost */
        }
        internal.gpuBuffer = null;
      }
    }
    this.totalBufferBytes = 0;
  }

  /** Drop every binding (project reload). */
  clear(): void {
    for (const binding of this.bindings.values()) {
      destroyBinding(internalStateOf(binding));
    }
    this.bindings.clear();
    this.totalBufferBytes = 0;
  }

  /**
   * List all registered bindings, sorted by name. Returned array is a
   * snapshot — callers may iterate without worrying about mutation.
   */
  list(): readonly ListBufferBinding[] {
    const out: ListBufferBinding[] = [];
    for (const binding of this.bindings.values()) out.push(binding);
    out.sort((a, b) => a.listName.localeCompare(b.listName));
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Implementation details                                              *
 * ------------------------------------------------------------------ */

const INTERNAL_STATE_KEY = Symbol.for('turbowasm.listBufferBinding.internalState');

interface MutableBinding extends BindingWithMirror {
  listName: string;
  slot: number;
  dtype: ListBufferDtype;
  readOnly: boolean;
  length: number;
  gpuBuffer: GpuLikeBuffer | null;
  /** §Phase 3 — region metadata propagated for diagnostic attribution. */
  regionId: string | null;
  regionBlockId: string | null;
}

function createBinding(
  directive: BindDirective,
  device: GpuLikeDevice | null,
  regionMetadata?: BindingRegionMetadata,
): ListBufferBinding {
  const internal: MutableBinding = {
    listName: directive.name,
    slot: directive.slot,
    dtype: directive.dtype,
    readOnly: directive.readOnly,
    length: 0,
    gpuBuffer: null,
    regionId: regionMetadata?.regionId ?? null,
    regionBlockId: regionMetadata?.regionBlockId ?? null,
  };
  const wrapper: ListBufferBinding = {
    get listName() {
      return internal.listName;
    },
    get slot() {
      return internal.slot;
    },
    get dtype() {
      return internal.dtype;
    },
    get readOnly() {
      return internal.readOnly;
    },
    get length() {
      return internal.length;
    },
    set length(v: number) {
      internal.length = v;
    },
    get gpuBuffer() {
      return internal.gpuBuffer;
    },
    set gpuBuffer(v: GpuLikeBuffer | null) {
      internal.gpuBuffer = v;
    },
    get regionId() {
      return internal.regionId;
    },
    get regionBlockId() {
      return internal.regionBlockId;
    },
    syncFromHost: (value) => syncFromHostImpl(internal, device, value),
    syncToHost: () => syncToHostImpl(internal),
    destroy: () => destroyBinding(internal),
  };
  // Stash the internal state on the wrapper so `bind()` / `setDevice()`
  // can reach it. We keep this off the public type.
  (wrapper as unknown as { [INTERNAL_STATE_KEY]?: MutableBinding })[INTERNAL_STATE_KEY] = internal;
  // Also stash the device pointer on the wrapper so `rebindMethods`
  // can update the sync closures without replacing the wrapper.
  (wrapper as unknown as { __twDevice?: GpuLikeDevice | null }).__twDevice = device;
  return wrapper;
}

function internalStateOf(binding: ListBufferBinding): MutableBinding {
  const internal = (binding as unknown as { [INTERNAL_STATE_KEY]?: MutableBinding })[
    INTERNAL_STATE_KEY
  ];
  if (!internal) {
    throw new Error('list-buffer-binding: binding missing internal state');
  }
  return internal;
}

function rebindMethods(binding: ListBufferBinding, device: GpuLikeDevice | null): void {
  const internal = internalStateOf(binding);
  (binding as unknown as { __twDevice?: GpuLikeDevice | null }).__twDevice = device;
  binding.syncFromHost = (value) => syncFromHostImpl(internal, device, value);
  binding.syncToHost = () => syncToHostImpl(internal);
  binding.destroy = () => destroyBinding(internal);
}

/**
 * Maximum buffer length we will allocate. The default of 1 Mi elements
 * is large enough for almost any project; callers may override via
 * `device.limits.maxStorageBufferBindingSize` when available. The runtime
 * dispatcher (`__dispatch-kernel-sync.ts`) consults this ceiling to cap
 * the runtime list length.
 *
 * §Phase 2 (15.3): previously this constant also capped `@max length=`
 * values. The `@max` directive was removed in v9; the cap now applies
 * only to the runtime list length read at dispatch time.
 */
export const DEFAULT_MAX_BUFFER_ELEMENTS = 1 << 20;

/**
 * §Phase 3 (gpu-kernel-dsl-phase3-spec §3.5) — lazily allocate (or
 * reallocate) the GPU buffer for a binding of `capacity` elements of
 * `dtype`. Returns the resulting buffer (or `null` when the device is
 * unavailable — the no-GPU path keeps the host mirror updated and
 * returns a `null` buffer).
 *
 * Side effects:
 *
 *   - updates `binding.length` to `capacity`
 *   - updates `binding.gpuBuffer` to the new (or recycled) buffer
 *   - updates the pool's `totalBufferBytes` aggregate
 *   - forwards `gpu.regional_buffer_memory_pressure` to
 *     `useErrorLogStore` when the projected aggregate exceeds 80% of
 *     `device.limits.maxStorageBufferBindingSize` (or the 256 MiB
 *     fallback)
 *
 * The function is pure of `useErrorLogStore` side effects when the
 * device is `null` (= no allocation happens, no budget check fires).
 */
export function ensureBuffer(
  binding: MutableBinding,
  capacity: number,
  device: GpuLikeDevice | null,
): GpuLikeBuffer | null {
  if (device === null) return null;
  const physicalBytes = capacity * BYTES_PER_ELEMENT[binding.dtype];
  if (binding.gpuBuffer && binding.gpuBuffer.size < physicalBytes) {
    binding.gpuBuffer.destroy();
    binding.gpuBuffer = null;
  }
  if (!binding.gpuBuffer) {
    const limit =
      device.limits?.maxStorageBufferBindingSize ?? DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE;
    const projected = bufferBudgetSnapshot(binding) + physicalBytes;
    if (projected > limit * 0.8) {
      useErrorLogStore.getState().push(
        'warn',
        `${GPU_DIAGNOSTIC_CODES.REGIONAL_BUFFER_MEMORY_PRESSURE}: aggregate buffer memory (${projected} B) exceeds 80% of GPU limit (${limit} B) for region ${binding.regionId ?? '<unknown>'} block ${binding.regionBlockId ?? '<unknown>'}; expect out-of-memory on lower-end GPUs`,
      );
    }
    binding.gpuBuffer = device.createBuffer({
      size: Math.max(physicalBytes, BYTES_PER_ELEMENT[binding.dtype]),
      usage:
        GPU_BUFFER_USAGE_STORAGE |
        GPU_BUFFER_USAGE_COPY_DST |
        GPU_BUFFER_USAGE_COPY_SRC,
    });
    // §Phase 3 — increment the pool's aggregate counter through the
    // budget writer installed in `attachBudgetWriters`.
    const writer = (binding as MutableBinding & {
      __twBudgetWriter?: (bytes: number) => void;
    }).__twBudgetWriter;
    writer?.(binding.gpuBuffer.size);
  }
  return binding.gpuBuffer;
}

/**
 * §Phase 3 — read the pool's current aggregate byte count from
 * whatever singleton binds the binding. Implemented via the
 * `INTERNAL_STATE_KEY` Symbol + `WeakMap`-style stash on the wrapper;
 * we fall back to `0` when the binding was not registered through a
 * `ListBufferPool` (e.g. the test-suite helper that synthesises a
 * `MutableBinding` directly).
 */
function bufferBudgetSnapshot(binding: MutableBinding): number {
  // The pool's aggregate counter is private; we expose it via a
  // closure handle stashed on the binding at creation time so
  // `ensureBuffer` can read it without reaching for the pool instance.
  // (`bind()` writes this closure in `createBinding`.)
  const reader = (binding as MutableBinding & {
    __twBudgetReader?: () => number;
  }).__twBudgetReader;
  return reader ? reader() : 0;
}

/**
 * §Phase 3 — pool-facing helper that registers a budget reader on a
 * binding so `ensureBuffer` can read the aggregate without holding a
 * back-reference to the pool. Called from `ListBufferPool.bind` /
 * `setDevice`.
 */
export function attachBudgetReader(
  binding: MutableBinding,
  reader: () => number,
): void {
  (binding as MutableBinding & { __twBudgetReader?: () => number }).__twBudgetReader = reader;
}

function syncFromHostImpl(
  binding: MutableBinding,
  device: GpuLikeDevice | null,
  value: number[] | Float32Array | Int32Array | Uint8Array,
): void {
  const data = coerceToTypedArray(value, binding.dtype);
  binding.length = data.length;
  if (device === null) {
    // No GPU available. Keep the host mirror updated so syncToHost() is
    // a no-op-flavoured call and downstream JS can still see the data.
    setHostMirror(binding, data);
    return;
  }
  // §Phase 3 — `ensureBuffer` is the single allocation point. The
  // budget check + buffer creation + aggregate update all happen
  // inside it.
  ensureBuffer(binding, data.length, device);
  // For `byte` we need to upload a Uint32 view, not the raw Uint8Array
  // (otherwise WebGPU sees 1 byte per element instead of 4). We pack
  // into a fresh Uint32Array so the source buffer is not constrained
  // to a multiple of 4.
  const uploadView: ArrayBufferView =
    binding.dtype === 'byte' ? packBytesToU32(data as Uint8Array) : data;
  if (binding.gpuBuffer) {
    device.queue.writeBuffer(binding.gpuBuffer, 0, uploadView);
  }
  setHostMirror(binding, data);
}

function syncToHostImpl(binding: MutableBinding): Float32Array | Int32Array | Uint8Array {
  // The host mirror is the source of truth in M5. Real WebGPU would
  // `mapAsync` here and copy the result into a typed array; we keep
  // the mirror in step on every syncFromHost instead.
  return cloneHostMirror(binding);
}

function destroyBinding(binding: MutableBinding): void {
  if (binding.gpuBuffer) {
    try {
      binding.gpuBuffer.destroy();
    } catch {
      /* swallow */
    }
    const reader = (binding as MutableBinding & {
      __twBudgetReader?: () => number;
    }).__twBudgetReader;
    if (reader) {
      // We can't write to the pool's aggregate from here — instead the
      // pool registers a writer closure when it creates the binding.
      const writer = (binding as MutableBinding & {
        __twBudgetWriter?: (bytes: number) => void;
      }).__twBudgetWriter;
      writer?.(-binding.gpuBuffer.size);
    }
    binding.gpuBuffer = null;
  }
  binding.length = 0;
  // Drop the mirror too.
  setHostMirror(binding, emptyTypedArray(binding.dtype));
}

/**
 * §Phase 3 — wire a binding to the owning pool so its buffer budget
 * (de)allocations update `pool.totalBufferBytes`. Called from
 * `ListBufferPool.bind` after `createBinding` returns the wrapper.
 */
export function attachBudgetWriters(
  binding: MutableBinding,
  pool: ListBufferPool,
): void {
  const mutable = binding as MutableBinding & {
    __twBudgetWriter?: (bytes: number) => void;
  };
  mutable.__twBudgetWriter = (delta: number) => {
    pool._bumpBudget(delta);
  };
  attachBudgetReader(binding, () => pool.bufferBudgetBytes());
}

function coerceToTypedArray(
  value: number[] | Float32Array | Int32Array | Uint8Array,
  dtype: ListBufferDtype,
): Float32Array | Int32Array | Uint8Array {
  if (dtype === 'f32') {
    return value instanceof Float32Array ? value : Float32Array.from(value as ArrayLike<number>);
  }
  if (dtype === 'i32') {
    return value instanceof Int32Array ? value : Int32Array.from(value as ArrayLike<number>);
  }
  if (value instanceof Uint8Array) return value;
  const arr = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const v = value[i] ?? 0;
    arr[i] = v & 0xff;
  }
  return arr;
}

/**
 * Pack a Uint8Array into a Uint32Array view, one byte per cell. The
 * resulting array's `byteLength` is `data.length * 4`, matching the
 * physical buffer width and the WGSL `array<u32>` storage layout.
 */
function packBytesToU32(data: Uint8Array): Uint32Array {
  const out = new Uint32Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = data[i] ?? 0;
  }
  return out;
}

function emptyTypedArray(dtype: ListBufferDtype): Float32Array | Int32Array | Uint8Array {
  if (dtype === 'f32') return new Float32Array(0);
  if (dtype === 'i32') return new Int32Array(0);
  return new Uint8Array(0);
}

const HOST_MIRROR_KEY = Symbol.for('turbowasm.listBufferBinding.hostMirror');

interface BindingWithMirror {
  [HOST_MIRROR_KEY]?: Float32Array | Int32Array | Uint8Array;
}

function setHostMirror(binding: BindingWithMirror, data: Float32Array | Int32Array | Uint8Array): void {
  if (data instanceof Float32Array) {
    binding[HOST_MIRROR_KEY] = new Float32Array(data);
  } else if (data instanceof Int32Array) {
    binding[HOST_MIRROR_KEY] = new Int32Array(data);
  } else {
    binding[HOST_MIRROR_KEY] = new Uint8Array(data);
  }
}

function cloneHostMirror(binding: BindingWithMirror): Float32Array | Int32Array | Uint8Array {
  const mirror = binding[HOST_MIRROR_KEY];
  if (!mirror) return emptyTypedArray((binding as unknown as { dtype: ListBufferDtype }).dtype);
  if (mirror instanceof Float32Array) return new Float32Array(mirror);
  if (mirror instanceof Int32Array) return new Int32Array(mirror);
  return new Uint8Array(mirror);
}