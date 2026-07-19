import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampDispatchExtent,
  dispatchKernel,
  dispatchKernelSync,
  type DispatchContext,
  type GpuLikeDispatchDevice,
  type RuntimeAdapter,
} from '@/runtime/gpu-kernel/__dispatch-kernel-sync';
import { KernelRegistry } from '@/runtime/gpu-kernel/kernel-registry';
import { ListBufferPool, type GpuLikeDevice } from '@/runtime/gpu-kernel/list-buffer-binding';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { BindDirective, RegionVerdict } from '@/runtime/gpu-kernel/types';

function makeBind(name: string, slot: number, readOnly: boolean): BindDirective {
  return {
    kind: 'bind',
    name,
    slot,
    readOnly,
    dtype: 'f32',
    line: 0,
    column: 0,
  };
}

function makeVerdict(blockId: string, binds: BindDirective[]): RegionVerdict {
  return {
    regionId: `region:sprite:${blockId}`,
    blockId,
    spriteId: 'sprite',
    directives: binds,
    blockSubset: { valid: true, diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [],
    parallelAxes: [],
    kernelContainerBlockId: blockId,
    nestedRepeatContainerBlockIds: [],
    firstSubstackBlockId: '',
  };
}

function makeMockRuntime(): RuntimeAdapter {
  return {
    readList: (_name, len) => new Float32Array(len),
    writeList: () => undefined,
    readScalar: () => 0,
    writeScalar: () => true,
    listLength: (_name) => 0,
  };
}

interface MockDevice {
  __pipelines: number;
  __bindGroups: number;
  __submits: number;
  __writes: number;
  __reads: number;
  __shaderModules: number;
  __onSubmittedWorkDone: number;
  onSubmittedWorkDone: () => Promise<void>;
}

function makeMockDevice(): GpuLikeDevice & GpuLikeDispatchDevice & MockDevice {
  const device = {
    __pipelines: 0,
    __bindGroups: 0,
    __submits: 0,
    __writes: 0,
    __reads: 0,
    __shaderModules: 0,
    __onSubmittedWorkDone: 0,
    queue: {
      submit: () => {
        device.__submits += 1;
      },
      writeBuffer: () => {
        device.__writes += 1;
      },
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: () => undefined,
        setBindGroup: () => undefined,
        dispatchWorkgroups: () => undefined,
        end: () => undefined,
      }),
      finish: () => ({}),
      copyBufferToBuffer: () => undefined,
    }),
    createShaderModule: (desc: { code: string }) => {
      device.__shaderModules += 1;
      return { __wgsl: desc.code };
    },
    createComputePipeline: () => {
      device.__pipelines += 1;
      return { __fakePipeline: true };
    },
    createBindGroup: () => {
      device.__bindGroups += 1;
      return { __fakeBindGroup: true };
    },
    getBindGroupLayout: () => 'auto',
    createBuffer: (desc: { size: number; usage: number }) => {
      device.__reads += 1;
      return {
        size: desc.size,
        usage: desc.usage,
        mapAsync: async () => undefined,
        getMappedRange: () => new ArrayBuffer(0),
        unmap: () => undefined,
        destroy: () => undefined,
      };
    },
    onSubmittedWorkDone: async () => {
      device.__onSubmittedWorkDone += 1;
    },
  } as unknown as GpuLikeDevice & GpuLikeDispatchDevice & MockDevice;
  return device as unknown as GpuLikeDevice & GpuLikeDispatchDevice & MockDevice;
}

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
});

describe('dispatchKernel', () => {
  it('returns ok=false + D4 demote when device is null', async () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const ctx: DispatchContext = {
      device: null,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      pipelines: new Map(),
      runtime: makeMockRuntime(),
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(false);
    expect(result.demoted).toBe(true);
    // The kernel is now marked js-only.
    expect(registry.lookup(verdict.blockId)).toBeUndefined();
    // A single adapter_unavailable warn was pushed.
    const warns = useErrorLogStore.getState().entries;
    expect(warns.some((e) => e.message.includes('adapter_unavailable'))).toBe(true);
  });

  it('dispatches and writes the result back when a real (mock) device is present', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');
    const kernel = registry.lookupById(verdict.regionId)!;
    kernel.workgroupSize = { x: 4, y: 1, z: 1 };

    const writes: string[] = [];
    const runtime: RuntimeAdapter = {
      readList: (_name, len) => Float32Array.from({ length: len }, (_, i) => i + 1),
      writeList: (name, value) => {
        writes.push(`${name}=${Array.from(value as Float32Array).join(',')}`);
      },
      readScalar: () => 0,
      writeScalar: () => true,
      listLength: () => 4,
    };

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 4, y: 1, z: 1 },
      pipelines: new Map(),
      runtime,
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(true);
    expect(result.demoted).toBe(false);
    expect(device.__submits).toBeGreaterThanOrEqual(1);
    expect(device.__shaderModules).toBe(1);
    expect(device.__pipelines).toBe(1);
    expect(device.__bindGroups).toBe(1);
    // onSubmittedWorkDone fires twice: once for the main dispatch, once
    // for the readback staging copy. Both are awaited by the dispatcher.
    expect(device.__onSubmittedWorkDone).toBeGreaterThanOrEqual(2);
    expect(writes).toHaveLength(1);
  });

  it('respects dispatch dims (x, y, z) by clamping to at least 1', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const seenDims: Array<{ x: number; y: number; z: number }> = [];
    (
      device as unknown as {
        createCommandEncoder: () => {
          beginComputePass: () => {
            setPipeline: (p: unknown) => void;
            setBindGroup: (i: number, g: unknown) => void;
            dispatchWorkgroups: (x: number, y: number, z: number) => void;
            end: () => void;
          };
          finish: () => unknown;
          copyBufferToBuffer: (
            src: unknown,
            srcOffset: number,
            dst: unknown,
            dstOffset: number,
            size: number,
          ) => void;
        };
      }
    ).createCommandEncoder = () => ({
      beginComputePass: () => ({
        setPipeline: () => undefined,
        setBindGroup: () => undefined,
        dispatchWorkgroups: (x, y, z) => {
          seenDims.push({ x, y, z });
        },
        end: () => undefined,
      }),
      finish: () => ({}),
      copyBufferToBuffer: () => undefined,
    });

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 0, y: 0, z: 0 },
      pipelines: new Map(),
      runtime: makeMockRuntime(),
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(true);
    expect(seenDims).toEqual([{ x: 1, y: 1, z: 1 }]);
  });

  it('demotes the kernel (D4) when the pipeline throws', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    (
      device as unknown as {
        createCommandEncoder: () => {
          beginComputePass: () => never;
          finish: () => unknown;
          copyBufferToBuffer: (
            src: unknown,
            srcOffset: number,
            dst: unknown,
            dstOffset: number,
            size: number,
          ) => void;
        };
      }
    ).createCommandEncoder = () => ({
      beginComputePass: () => {
        throw new Error('synthetic dispatch failure');
      },
      finish: () => ({}),
      copyBufferToBuffer: () => undefined,
    });

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      pipelines: new Map(),
      runtime: makeMockRuntime(),
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(false);
    expect(result.demoted).toBe(true);
    expect(registry.lookup(verdict.blockId)).toBeUndefined();
    const warns = useErrorLogStore.getState().entries;
    expect(warns.some((e) => e.message.includes('d4.kernel_runtime_demoted'))).toBe(true);
  });

  it('returns ok=false with a clear message when the kernel id is unknown', async () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    const ctx: DispatchContext = {
      device: null,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      pipelines: new Map(),
      runtime: makeMockRuntime(),
    };

    const result = await dispatchKernel('does-not-exist', ctx);
    expect(result.ok).toBe(false);
    expect(result.demoted).toBe(false);
    expect(result.message).toContain('not found');
  });
});

describe('dispatchKernelSync', () => {
  it('short-circuits with adapter_unavailable when device is null', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const ctx: DispatchContext = {
      device: null,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      pipelines: new Map(),
      runtime: makeMockRuntime(),
    };

    const result = dispatchKernelSync(verdict.regionId, ctx);
    expect(result.demoted).toBe(true);
    expect(result.message).toBe('adapter_unavailable');
  });
});

describe('clampDispatchExtent (A-3 hardening)', () => {
  /**
   * The dispatcher used to call `Math.max(1, Math.floor(dims.x))` which
   * accepted NaN (NaN→NaN→NaN floor→1 via Math.max? actually NaN→1
   * because `Math.max(1, NaN)` is NaN, which is then dispatched as
   * `dispatchWorkgroups(NaN, ...)` — a WebGPU validation error on
   * real devices). It also capped arbitrarily large values to the
   * device's `maxComputeWorkgroupsPerDimension` (some devices reject
   * the dispatch, some silently wrap).
   *
   * `clampDispatchExtent` is the hardened replacement: ceil + finite
   * + device limit + global cap. Pin the contract here.
   */
  it('returns 1 for non-finite inputs (NaN, Infinity, -Infinity)', () => {
    expect(clampDispatchExtent(NaN, null, 'x')).toBe(1);
    expect(clampDispatchExtent(Number.POSITIVE_INFINITY, null, 'x')).toBe(1);
    expect(clampDispatchExtent(Number.NEGATIVE_INFINITY, null, 'y')).toBe(1);
  });

  it('clamps sub-1 values up to 1 (WebGPU rejects zero)', () => {
    expect(clampDispatchExtent(0, null, 'x')).toBe(1);
    expect(clampDispatchExtent(-100, null, 'z')).toBe(1);
    expect(clampDispatchExtent(0.4, null, 'y')).toBe(1);
  });

  it('ceils fractional values (dispatchWorkgroups is integer-only)', () => {
    expect(clampDispatchExtent(3.1, null, 'x')).toBe(4);
    expect(clampDispatchExtent(7.9, null, 'y')).toBe(8);
  });

  it('honours device.limits.maxComputeWorkgroupsPerDimension when present', () => {
    const limitedDevice = {
      limits: { maxComputeWorkgroupsPerDimension: 1000 },
    } as unknown as GpuLikeDispatchDevice;
    expect(clampDispatchExtent(2048, limitedDevice, 'x')).toBe(1000);
    expect(clampDispatchExtent(500, limitedDevice, 'x')).toBe(500);
    // Falls below the device limit ⇒ no clamp.
    expect(clampDispatchExtent(1, limitedDevice, 'z')).toBe(1);
  });

  it('falls back to MAX_COMPUTE_WORKGROUPS_PER_DIMENSION_DEFAULT when no limit', () => {
    // Anything below the default (65535) passes through; above clamps.
    expect(clampDispatchExtent(10_000, null, 'x')).toBe(10_000);
    expect(clampDispatchExtent(100_000, null, 'x')).toBe(65_535);
  });
});

describe('bind group cache invalidation on list growth (D-2)', () => {
  /**
   * §19.3 #24 — when a Scratch list grows between dispatches, the
   * existing GPU buffer is too small to hold the new data. The pool
   * reallocates the GPU buffer, and the dispatcher must rebuild the
   * bind group because the underlying `GPUBuffer` reference changed.
   *
   * The current detection in `dispatchKernel` is reference-equality on
   * `pipeline.bindingBuffers`; if a binding's `gpuBuffer` was swapped
   * to a fresh handle, the next dispatch observes the mismatch and
   * re-issues `createBindGroup`. This test guards the full
   * reallocation → bind-group refresh path against future refactors.
   */
  it('rebuilds the bind group when a binding\'s gpuBuffer is reallocated', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    // First dispatch — pool allocates a small gpuBuffer.
    let runtimeLength = 4;
    const runtime: RuntimeAdapter = {
      readList: (_name, len) => Float32Array.from({ length: len }, () => 1),
      writeList: () => undefined,
      readScalar: () => 0,
      writeScalar: () => true,
      listLength: () => runtimeLength,
    };

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      pipelines: new Map(),
      runtime,
    };

    const r1 = await dispatchKernel(verdict.regionId, ctx);
    expect(r1.ok).toBe(true);
    const firstBindGroups = (device as unknown as MockDevice).__bindGroups;
    expect(firstBindGroups).toBe(1);

    // Capture the original gpuBuffer handle and synthetic "destroyed" flag.
    const binding = pool.get('a');
    expect(binding).toBeDefined();
    const originalGpuBuffer = binding?.gpuBuffer;
    expect(originalGpuBuffer).toBeDefined();

    // Grow the list 256× — pool must reallocate.
    runtimeLength = 1024;
    const r2 = await dispatchKernel(verdict.regionId, ctx);
    expect(r2.ok).toBe(true);

    // The pool grew → new gpuBuffer handle.
    const newGpuBuffer = pool.get('a')?.gpuBuffer;
    expect(newGpuBuffer).toBeDefined();
    expect(newGpuBuffer).not.toBe(originalGpuBuffer);

    // ...and the bind group was rebuilt (count incremented).
    const afterGrowBindGroups = (device as unknown as MockDevice).__bindGroups;
    expect(afterGrowBindGroups).toBeGreaterThan(firstBindGroups);
  });
});
