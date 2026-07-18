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
 */
import type { BindDirective } from './types';

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
  // `byte` is host-side Uint8Array but storage is array<u32>; one u32
  // per byte. See the module doc comment.
  byte: 4,
};

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
  /** Allocated element count. Mirrors `@max length=` or runtime list length. */
  length: number;
  /** Lazily-allocated GPU buffer. `null` until first sync. */
  gpuBuffer: GpuLikeBuffer | null;
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

  constructor(options: ListBufferPoolOptions) {
    this.device = options.device;
  }

  /**
   * Set / replace the device. Existing bindings have their GPU buffers
   * destroyed (they belonged to the old device) and the host mirror is
   * preserved so the next `syncFromHost` knows the desired shape.
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
   */
  bind(directive: BindDirective): ListBufferBinding {
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
        internal.gpuBuffer = null;
      }
      internal.slot = directive.slot;
      internal.dtype = directive.dtype;
      internal.readOnly = directive.readOnly;
      internal.length = 0;
      setHostMirror(internal, emptyTypedArray(directive.dtype));
      // Update the device pointer on the sync functions (the wrapper
      // closes over `this.device`, so we need to rebind them).
      rebindMethods(existing, this.device);
      return existing;
    }
    const binding = createBinding(directive, this.device);
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
  }

  /** Drop every binding (project reload). */
  clear(): void {
    for (const binding of this.bindings.values()) {
      destroyBinding(internalStateOf(binding));
    }
    this.bindings.clear();
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
}

function createBinding(
  directive: BindDirective,
  device: GpuLikeDevice | null,
): ListBufferBinding {
  const internal: MutableBinding = {
    listName: directive.name,
    slot: directive.slot,
    dtype: directive.dtype,
    readOnly: directive.readOnly,
    length: 0,
    gpuBuffer: null,
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
 * `@max length=` values.
 */
export const DEFAULT_MAX_BUFFER_ELEMENTS = 1 << 20;

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
  const physicalBytes = data.length * BYTES_PER_ELEMENT[binding.dtype];
  if (binding.gpuBuffer && binding.gpuBuffer.size < physicalBytes) {
    try {
      binding.gpuBuffer.destroy();
    } catch {
      /* swallow */
    }
    binding.gpuBuffer = null;
  }
  if (!binding.gpuBuffer) {
    binding.gpuBuffer = device.createBuffer({
      size: Math.max(physicalBytes, BYTES_PER_ELEMENT[binding.dtype]),
      usage:
        GPU_BUFFER_USAGE_STORAGE |
        GPU_BUFFER_USAGE_COPY_DST |
        GPU_BUFFER_USAGE_COPY_SRC,
    });
  }
  // For `byte` we need to upload a Uint32 view, not the raw Uint8Array
  // (otherwise WebGPU sees 1 byte per element instead of 4). We pack
  // into a fresh Uint32Array so the source buffer is not constrained
  // to a multiple of 4.
  const uploadView: ArrayBufferView =
    binding.dtype === 'byte' ? packBytesToU32(data as Uint8Array) : data;
  device.queue.writeBuffer(binding.gpuBuffer, 0, uploadView);
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
    binding.gpuBuffer = null;
  }
  binding.length = 0;
  // Drop the mirror too.
  setHostMirror(binding, emptyTypedArray(binding.dtype));
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
