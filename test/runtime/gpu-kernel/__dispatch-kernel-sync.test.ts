import { beforeEach, describe, expect, it } from 'vitest';
import {
  dispatchKernelSync,
  type DispatchContext,
  type GpuLikeDispatchDevice,
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
  };
}

interface MockDevice {
  __pipelines: number;
  __bindGroups: number;
  __submits: number;
  __writes: number;
}

function makeMockDevice(): GpuLikeDevice & GpuLikeDispatchDevice & MockDevice {
  const buffers: Array<{ size: number; usage: number }> = [];
  const writes: Array<{ buffer: unknown; offset: number; bytes: Uint8Array }> = [];
  const device = {
    __pipelines: 0,
    __bindGroups: 0,
    __submits: 0,
    __writes: 0,
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
    }),
    createComputePipeline: () => {
      device.__pipelines += 1;
      return { __fakePipeline: true };
    },
    createBindGroup: () => {
      device.__bindGroups += 1;
      return { __fakeBindGroup: true };
    },
    createBuffer: (desc: { size: number; usage: number }) => {
      buffers.push({ size: desc.size, usage: desc.usage });
      writes.push({
        buffer: null,
        offset: 0,
        bytes: new Uint8Array(desc.size),
      });
      return { size: desc.size, usage: desc.usage, destroy: () => undefined };
    },
  } as unknown as GpuLikeDevice & GpuLikeDispatchDevice & {
    __pipelines: number;
    __bindGroups: number;
    __submits: number;
    __writes: number;
  };
  // Keep `buffers` / `writes` referenced so the closure stays alive
  // for inspection if a test wants to dig deeper.
  void buffers;
  void writes;
  return device as unknown as GpuLikeDevice & GpuLikeDispatchDevice & MockDevice;
}

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
});

describe('dispatchKernelSync', () => {
  it('returns ok=false + D4 demote when device is null', () => {
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
      hostListLengths: {},
      readHostList: (_name, len) => new Array(len).fill(0),
      writeHostList: () => undefined,
    };

    const result = dispatchKernelSync(verdict.regionId, ctx);
    expect(result.ok).toBe(false);
    expect(result.demoted).toBe(true);
    // The kernel is now marked js-only.
    expect(registry.lookup(verdict.blockId)).toBeUndefined();
    // A single adapter_unavailable warn was pushed.
    const warns = useErrorLogStore.getState().entries;
    expect(warns.some((e) => e.message.includes('adapter_unavailable'))).toBe(true);
  });

  it('dispatches and writes the result back when a real (mock) device is present', () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const writes: string[] = [];
    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 4, y: 1, z: 1 },
      pipelines: new Map(),
      hostListLengths: { a: 4 },
      readHostList: (_name, len) => Float32Array.from({ length: len }, (_, i) => i + 1),
      writeHostList: (name, value) => {
        writes.push(`${name}=${Array.from(value as Float32Array).join(',')}`);
      },
    };

    const result = dispatchKernelSync(verdict.regionId, ctx);
    expect(result.ok).toBe(true);
    expect(result.demoted).toBe(false);
    expect(device.__submits).toBe(1);
    // The mock does not actually run the shader — the host mirror is
    // unchanged from what readHostList returned. The dispatcher just
    // proves the bind→dispatch→write path executes end-to-end.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('a=1,2,3,4');
  });

  it('respects dispatch dims (x, y, z) by clamping to at least 1', () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const seenDims: Array<{ x: number; y: number; z: number }> = [];
    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 0, y: 0, z: 0 },
      pipelines: new Map(),
      hostListLengths: { a: 4 },
      readHostList: (_name, len) => new Array(len).fill(0),
      writeHostList: () => undefined,
      onSubmit: () => undefined,
    };

    // Replace the device's encoder with one that records dims.
    (ctx.device as unknown as {
      createCommandEncoder: () => {
        beginComputePass: () => {
          setPipeline: (p: unknown) => void;
          setBindGroup: (i: number, g: unknown) => void;
          dispatchWorkgroups: (x: number, y: number, z: number) => void;
          end: () => void;
        };
        finish: () => unknown;
      };
    }).createCommandEncoder = () => ({
      beginComputePass: () => ({
        setPipeline: () => undefined,
        setBindGroup: () => undefined,
        dispatchWorkgroups: (x, y, z) => {
          seenDims.push({ x, y, z });
        },
        end: () => undefined,
      }),
      finish: () => ({}),
    });

    const result = dispatchKernelSync(verdict.regionId, ctx);
    expect(result.ok).toBe(true);
    expect(seenDims).toEqual([{ x: 1, y: 1, z: 1 }]);
  });

  it('demotes the kernel (D4) when the pipeline throws', () => {
    const registry = new KernelRegistry();
    const device = makeMockDevice();
    const pool = new ListBufferPool({ device });
    const verdict = makeVerdict('b1', [makeBind('a', 0, false)]);
    registry.register(verdict, 'wgsl');

    const ctx: DispatchContext = {
      device,
      registry,
      pool,
      regionVerdict: verdict,
      dims: { x: 1, y: 1, z: 1 },
      pipelines: new Map(),
      hostListLengths: { a: 4 },
      readHostList: (_name, len) => new Array(len).fill(0),
      writeHostList: () => undefined,
    };

    // Force the encoder to throw mid-dispatch.
    (ctx.device as unknown as {
      createCommandEncoder: () => { beginComputePass: () => never; finish: () => unknown };
    }).createCommandEncoder = () => ({
      beginComputePass: () => {
        throw new Error('synthetic dispatch failure');
      },
      finish: () => ({}),
    });

    const result = dispatchKernelSync(verdict.regionId, ctx);
    expect(result.ok).toBe(false);
    expect(result.demoted).toBe(true);
    expect(registry.lookup(verdict.blockId)).toBeUndefined();
    const warns = useErrorLogStore.getState().entries;
    expect(warns.some((e) => e.message.includes('d4.kernel_runtime_demoted'))).toBe(true);
  });

  it('returns ok=false with a clear message when the kernel id is unknown', () => {
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
      hostListLengths: {},
      readHostList: () => [],
      writeHostList: () => undefined,
    };

    const result = dispatchKernelSync('does-not-exist', ctx);
    expect(result.ok).toBe(false);
    expect(result.demoted).toBe(false);
    expect(result.message).toContain('not found');
  });
});