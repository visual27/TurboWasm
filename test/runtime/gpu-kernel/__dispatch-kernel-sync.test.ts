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

function makeScalarBind(
  name: string,
  slot: number,
  opts: { dtype?: 'f32' | 'i32' | 'byte' } = {},
): BindDirective {
  return {
    kind: 'bind',
    name,
    slot,
    readOnly: true,
    storageKind: 'scalar',
    dtype: opts.dtype ?? 'f32',
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

describe('§Phase 3 — scalar uniform path', () => {
  /**
   * `scalarBindings` + `dispatchPlan` を渡すと、dispatch 毎に
   * `evaluateDispatchFormula(plan.*, ...)` がホスト側で評価され、
   * その数値が `pass.dispatchWorkgroups(...)` に渡されることを検証。
   *
   * 動的な scalar (例: `aabb_idx0` が outer scratch loop で増加) でも
   * dispatch 直前の `runtime.readScalar` の値が反映される。
   */
  it('resolves dims via dispatchPlan + scalarBindings', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');
    const kernel = registry.lookupById(verdict.regionId)!;
    kernel.dispatchPlan = {
      x: 'ceil(scratch_index_clamp(aabb_idx0, 100) / 64)', // ⇒ 1 (= max(0, min(8, 99)) / 64 ceil)
      y: '8', // literal
      z: '1',
    };
    let scalarValue = 8;
    kernel.scalarBindings = [
      { name: 'aabb_idx0', wgslName: 'aabb_idx0', dtype: 'f32' },
    ];

    const seenDims: Array<{ x: number; y: number; z: number }> = [];
    const seenBindGroups = new Set<number>();
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
        setBindGroup: (i: number, _g: unknown) => {
          seenBindGroups.add(i);
        },
        dispatchWorkgroups: (x, y, z) => {
          seenDims.push({ x, y, z });
        },
        end: () => undefined,
      }),
      finish: () => ({}),
      copyBufferToBuffer: () => undefined,
    });

    const runtime: RuntimeAdapter = {
      readList: (_name, len) => new Float32Array(len),
      writeList: () => undefined,
      readScalar: () => scalarValue,
      writeScalar: () => true,
      listLength: () => 0,
    };

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 }, // scalarBindings 経由なら無視される
      dispatchPlan: kernel.dispatchPlan,
      scalarBindings: kernel.scalarBindings,
      pipelines: new Map(),
      runtime,
    };

    scalarValue = 8;
    const r1 = await dispatchKernel(verdict.regionId, ctx);
    expect(r1.ok).toBe(true);
    // scratch_index_clamp(8, 100) → min(8, max(0, 99)) = 8 → ceil(8 / 64) = 1
    expect(seenDims[0]).toEqual({ x: 1, y: 8, z: 1 });
    // group(1) bind group が binding されている
    expect(seenBindGroups.has(1)).toBe(true);

    // scalar 値を変更しても dispatch 毎の readScalar で読み直される
    scalarValue = 200;
    const r2 = await dispatchKernel(verdict.regionId, ctx);
    expect(r2.ok).toBe(true);
    // scratch_index_clamp(200, 100) → min(200, 99) = 99 → ceil(99 / 64) = 2
    expect(seenDims[1]).toEqual({ x: 2, y: 8, z: 1 });
  });

  it('falls back to ctx.dims when scalarBindings is empty', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const seenDims: Array<{ x: number; y: number; z: number }> = [];
    const seenBindGroups = new Set<number>();
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
        setBindGroup: (i: number, _g: unknown) => {
          seenBindGroups.add(i);
        },
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
      dims: { x: 5, y: 5, z: 5 }, // scalarBindings 空 → これがそのまま使われる
      pipelines: new Map(),
      runtime: makeMockRuntime(),
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(true);
    expect(seenDims).toEqual([{ x: 5, y: 5, z: 5 }]);
    // scalarBindings 空 → group(1) は bind しない
    expect(seenBindGroups.has(1)).toBe(false);
  });

  it('allocates uniformBuffer lazily on first dispatch only', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    // readOnly: true so postDispatch skips the readback staging buffer.
    // We want to verify that subsequent dispatches do NOT allocate a new
    // uniform buffer (the values are written into the same buffer).
    const listBind = makeBind('a', 0, true);
    const verdict = makeVerdict('b1', [listBind]);
    registry.register(verdict, 'wgsl');
    pool.bind(listBind);

    // createBuffer の呼び出し回数を記録
    let createBufferCount = 0;
    const originalCreateBuffer = (
      device as unknown as { createBuffer: (d: { size: number; usage: number }) => unknown }
    ).createBuffer;
    (
      device as unknown as { createBuffer: (d: { size: number; usage: number }) => unknown }
    ).createBuffer = (d) => {
      createBufferCount += 1;
      return originalCreateBuffer(d);
    };

    const runtime: RuntimeAdapter = {
      readList: (_name, len) => new Float32Array(len),
      writeList: () => undefined,
      readScalar: () => 3,
      writeScalar: () => true,
      listLength: () => 0,
    };

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      dispatchPlan: { x: 'a', y: '1', z: '1' },
      scalarBindings: [{ name: 'a', wgslName: 'a', dtype: 'f32' }],
      pipelines: new Map(),
      runtime,
    };

    // 1 回目の dispatch — uniform buffer を含めて何かしら buffer が作られる
    const r1 = await dispatchKernel(verdict.regionId, ctx);
    expect(r1.ok).toBe(true);
    const afterFirst = createBufferCount;
    expect(afterFirst).toBeGreaterThan(0);

    // 2 回目の dispatch — uniform buffer を含む新規 buffer allocation が起きないこと
    // (= pipeline.uniformBuffer を再利用している lazy allocation の検証)
    const r2 = await dispatchKernel(verdict.regionId, ctx);
    expect(r2.ok).toBe(true);
    expect(createBufferCount).toBe(afterFirst);
  });

  it('refreshes scalar values on every dispatch', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    let readScalarCount = 0;
    let nextScalarValue = 10;
    const runtime: RuntimeAdapter = {
      readList: (_name, len) => new Float32Array(len),
      writeList: () => undefined,
      readScalar: (name) => {
        readScalarCount += 1;
        return name === 'idx' ? nextScalarValue : 0;
      },
      writeScalar: () => true,
      listLength: () => 0,
    };

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      dispatchPlan: { x: 'idx', y: '1', z: '1' },
      scalarBindings: [{ name: 'idx', wgslName: 'idx', dtype: 'f32' }],
      pipelines: new Map(),
      runtime,
    };

    // 1 回目の dispatch: readScalar 呼ばれる (値は 10)
    const r1 = await dispatchKernel(verdict.regionId, ctx);
    expect(r1.ok).toBe(true);
    // readScalarValues + clampDispatchExtent 後の評価で少なくとも 1 回ずつ呼ばれる
    // (resolveDispatchDims 内で readScalarValues を呼び、writeScalarUniformBuffer がもう一度呼び、
    //  最終的に dispatchWorkgroups の x が `idx` の値になる)
    const afterFirstDispatch = readScalarCount;
    expect(afterFirstDispatch).toBeGreaterThan(0);

    // scalar 値を変えて 2 回目の dispatch
    nextScalarValue = 99;
    const r2 = await dispatchKernel(verdict.regionId, ctx);
    expect(r2.ok).toBe(true);
    // 2 回目の方が readScalar の呼び出し回数が増えている (= refresh されている)
    expect(readScalarCount).toBeGreaterThan(afterFirstDispatch);
  });
});

describe('§Phase 4 (15.6/15.7/15.8) — list/scalar split in bind groups', () => {
  /**
   * §Phase 4 (15.6) — group-0 bind group entries must contain only list
   * bindings. Scalar bindings live on `@group(1) @binding(0)` and must
   * never appear in group-0 entries. We verify by intercepting
   * `createBindGroup` calls and inspecting the `entries` shape.
   */
  it('group-0 bind group does not include scalar bindings (15.6)', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });

    // One list binding + one scalar binding on the same kernel. Without
    // the §Phase 4 split, the scalar binding would slip into group-0.
    const listBind = makeBind('buff_r', 0, false);
    const scalarBind = makeScalarBind('aabb_idx0', 4);
    const verdict = makeVerdict('b1', [listBind, scalarBind]);
    registry.register(verdict, 'wgsl');

    // Capture every `createBindGroup` call's `entries` field, tagged by
    // the bind-group layout (`'auto'` → can't tell, but our mock
    // returns a single `'auto'` layout for both groups).
    const seenEntries: Array<Array<{ binding: number; resource: { buffer: unknown } }>> = [];
    const originalCreateBindGroup = device.createBindGroup;
    (device as unknown as { createBindGroup: typeof device.createBindGroup }).createBindGroup = (
      desc,
    ) => {
      seenEntries.push(desc.entries);
      const result = originalCreateBindGroup?.(desc);
      return result;
    };

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      dispatchPlan: { x: '1', y: '1', z: '1' },
      scalarBindings: [{ name: 'aabb_idx0', wgslName: 'aabb_idx0', dtype: 'i32' }],
      listLengthBindings: [{ name: 'buff_r', wgslName: 'buff_r_length' }],
      pipelines: new Map(),
      runtime: makeMockRuntime(),
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(true);

    // Two bind groups: one for group 0 (storage), one for group 1
    // (uniform). The group-0 entry must reference ONLY the list
    // binding's slot. The group-1 entry must reference slot 0 of the
    // uniform buffer.
    expect(seenEntries).toHaveLength(2);
    expect(seenEntries[0]).toEqual([
      { binding: 0, resource: { buffer: expect.anything() } },
    ]);
    expect(seenEntries[1]).toEqual([
      { binding: 0, resource: { buffer: expect.anything() } },
    ]);
    // The list binding's slot is 0 — group-0 entries[0].binding === 0.
    // If a scalar binding had slipped in, we'd see a second entry with
    // binding: 4 (= scalar's slot).
    expect(seenEntries[0]?.length).toBe(1);
  });

  /**
   * §Phase 4 (15.8) — list-only kernels (= no scalar bindings, but
   * list bindings present) must still bind `@group(1)` so the WGSL
   * body can read `<list>_length`. Without this fix the WGSL struct
   * field would exist but the uniform buffer would be unallocated,
   * reading garbage at runtime.
   */
  it('list-only kernel binds group 1 with list length values (15.8)', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });

    // List-only: scalar bindings absent. Without §Phase 4 (15.8), the
    // dispatcher would skip the uniform buffer allocation AND skip
    // `setBindGroup(1, ...)`, leaving `u_scratch.<list>_length`
    // unreadable in the WGSL body.
    const listBind = makeBind('buff_r', 0, true);
    const verdict = makeVerdict('b1', [listBind]);
    registry.register(verdict, 'wgsl');

    const seenBindGroups = new Set<number>();
    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      // No scalarBindings.
      listLengthBindings: [{ name: 'buff_r', wgslName: 'buff_r_length' }],
      pipelines: new Map(),
      runtime: {
        ...makeMockRuntime(),
        listLength: () => 42,
      },
    };

    // Capture which bind group indices get set on the compute pass.
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
          copyBufferToBuffer: () => void;
        };
      }
    ).createCommandEncoder = () => ({
      beginComputePass: () => ({
        setPipeline: () => undefined,
        setBindGroup: (i: number, _g: unknown) => {
          seenBindGroups.add(i);
        },
        dispatchWorkgroups: () => undefined,
        end: () => undefined,
      }),
      finish: () => ({}),
      copyBufferToBuffer: () => undefined,
    });

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(true);
    // group 1 must be bound even when no scalar bindings exist.
    expect(seenBindGroups.has(1)).toBe(true);
    expect(seenBindGroups.has(0)).toBe(true);
  });

  /**
   * §Phase 4 (15.5) — the WGSL expression dispatch plan must be
   * evaluated even when scalar bindings are absent (= list-only
   * kernel). `ctx.dims` is the fallback only, not the primary
   * dispatch size. Without this fix, a list-only kernel with a
   * non-trivial dispatchPlan would dispatch `(1, 1, 1)` regardless
   * of the runtime list length.
   */
  it('evaluates dispatchPlan even when scalarBindings is empty (15.5)', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });

    const listBind = makeBind('buff_r', 0, true);
    const verdict = makeVerdict('b1', [listBind]);
    registry.register(verdict, 'wgsl');
    const kernel = registry.lookupById(verdict.regionId)!;
    kernel.dispatchPlan = {
      x: 'ceil(len(buff_r) / 64)',
      y: '1',
      z: '1',
    };

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
          copyBufferToBuffer: () => void;
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

    // First dispatch: list length = 100 → ceil(100/64) = 2
    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 }, // fallback — should NOT be used
      dispatchPlan: kernel.dispatchPlan,
      listLengthBindings: [{ name: 'buff_r', wgslName: 'buff_r_length' }],
      pipelines: new Map(),
      runtime: {
        ...makeMockRuntime(),
        listLength: (name) => (name === 'buff_r' ? 100 : 0),
      },
    };

    const r1 = await dispatchKernel(verdict.regionId, ctx);
    expect(r1.ok).toBe(true);
    expect(seenDims[0]).toEqual({ x: 2, y: 1, z: 1 });

    // Second dispatch: list length = 200 → ceil(200/64) = 4
    (
      ctx.runtime as { listLength: (n: string) => number }).listLength = () => 200;
    const r2 = await dispatchKernel(verdict.regionId, ctx);
    expect(r2.ok).toBe(true);
    expect(seenDims[1]).toEqual({ x: 4, y: 1, z: 1 });
  });

  /**
   * §Phase 4 (15.5) — dispatchPlan evaluation failure falls back to
   * `(1, 1, 1)` and emits a `gpu.dispatch_formula_eval_failed` warn.
   * The previous (Phase 3) path required scalar bindings to gate
   * evaluation; with §Phase 4 the gate is removed.
   */
  it('falls back to (1,1,1) when dispatchPlan evaluation fails (15.5)', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });

    const listBind = makeBind('buff_r', 0, true);
    const verdict = makeVerdict('b1', [listBind]);
    registry.register(verdict, 'wgsl');
    const kernel = registry.lookupById(verdict.regionId)!;
    kernel.dispatchPlan = {
      x: '__undeclared_identifier + 1', // ⇒ SyntaxError
      y: '1',
      z: '1',
    };

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
          copyBufferToBuffer: () => void;
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
      dims: { x: 9, y: 9, z: 9 },
      dispatchPlan: kernel.dispatchPlan,
      pipelines: new Map(),
      runtime: makeMockRuntime(),
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(true);
    // 評価失敗 ⇒ 0 (dispatch-formula-evaluator) ⇒ ceil/clamp ⇒ 1
    expect(seenDims[0]).toEqual({ x: 1, y: 1, z: 1 });
    // `gpu.dispatch_formula_eval_failed` warn が push されている
    const warns = useErrorLogStore.getState().entries;
    expect(warns.some((e) => e.message.includes('dispatch_formula_eval_failed'))).toBe(true);
  });

  /**
   * §Phase 4 (15.7) — list length fields pack into the same uniform
   * buffer as scalar fields, with the same 16-byte stride. The
   * runtime adapter's `listLength` is queried per dispatch so a
   * growing list sees the latest length.
   */
  it('packs list length values into the uniform buffer (15.7)', async () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });

    const listBind = makeBind('buff_r', 0, true);
    const scalarBind = makeScalarBind('aabb_idx0', 4, { dtype: 'i32' });
    const verdict = makeVerdict('b1', [listBind, scalarBind]);
    registry.register(verdict, 'wgsl');

    // Capture every writeBuffer call's data payload.
    const writes: Array<{ data: Uint8Array }> = [];
    const originalWriteBuffer = device.queue.writeBuffer;
    device.queue.writeBuffer = (
      _buf: unknown,
      _offset: number,
      data: BufferSource,
    ) => {
      const view = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      writes.push({ data: view });
      // Re-cast the BufferSource to an ArrayBufferView so the underlying
      // `writeBuffer` signature is satisfied. The mock implementation
      // doesn't actually inspect the buffer type.
      const viewData: Uint8Array =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      originalWriteBuffer?.(
        _buf as Parameters<typeof originalWriteBuffer>[0],
        _offset,
        viewData,
      );
    };

    let runtimeListLength = 17;
    const runtimeScalar = 42;
    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      dispatchPlan: { x: '1', y: '1', z: '1' },
      scalarBindings: [{ name: 'aabb_idx0', wgslName: 'aabb_idx0', dtype: 'i32' }],
      listLengthBindings: [{ name: 'buff_r', wgslName: 'buff_r_length' }],
      pipelines: new Map(),
      runtime: {
        readList: (_name, len) => new Float32Array(len),
        writeList: () => undefined,
        readScalar: () => runtimeScalar,
        writeScalar: () => true,
        listLength: () => runtimeListLength,
      },
    };

    const result = await dispatchKernel(verdict.regionId, ctx);
    expect(result.ok).toBe(true);
    // One writeBuffer call for the uniform buffer (= 16-byte header
    // + 16-byte scalar + 16-byte length = 48 bytes).
    const uniformWrites = writes.filter((w) => w.data.byteLength === 48);
    expect(uniformWrites.length).toBeGreaterThanOrEqual(1);
    // Decode the packed buffer: header (16 zero bytes) + scalar value
    // at offset 16 (= 42 as i32 little-endian) + length at offset 32
    // (= 17 as u32 little-endian).
    const buf = uniformWrites[0]!.data;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getInt32(16, true)).toBe(42);
    expect(view.getUint32(32, true)).toBe(17);

    // Changing the runtime list length affects the next dispatch's pack.
    runtimeListLength = 99;
    writes.length = 0;
    const r2 = await dispatchKernel(verdict.regionId, ctx);
    expect(r2.ok).toBe(true);
    const second = writes.filter((w) => w.data.byteLength === 48)[0];
    expect(second).toBeDefined();
    const view2 = new DataView(second!.data.buffer, second!.data.byteOffset, second!.data.byteLength);
    expect(view2.getUint32(32, true)).toBe(99);
  });
});
