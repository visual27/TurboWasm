/**
 * §Phase 3 (gpu-kernel-dsl-phase3-spec §3.5) — aggregate buffer memory
 * detection in `ListBufferPool`.
 *
 * `ensureBuffer` consults `device.limits.maxStorageBufferBindingSize`
 * (= 256 MiB fallback) and pushes a `gpu.regional_buffer_memory_pressure`
 * warn into `useErrorLogStore` when the projected aggregate exceeds
 * 80% of that limit. The test exercises:
 *
 *   - Below the threshold: no warn.
 *   - Above the threshold: warn surfaces in `useErrorLogStore`.
 *   - `destroy()` decrements the aggregate and a fresh sync no longer
 *     fires the warn.
 *   - The budget resets when the device is replaced via `setDevice`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BYTES_PER_ELEMENT,
  ListBufferPool,
} from '@/runtime/gpu-kernel/list-buffer-binding';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { BindDirective } from '@/runtime/gpu-kernel/types';
import type { GpuLikeBuffer, GpuLikeDevice } from '@/runtime/gpu-kernel/list-buffer-binding';

function bindDirective(name: string, slot: number, dtype: 'f32' | 'i32' | 'byte' = 'f32'): BindDirective {
  return {
    kind: 'bind',
    name,
    slot,
    readOnly: false,
    dtype,
    line: 0,
    column: 0,
  };
}

/**
 * Test device whose `limits.maxStorageBufferBindingSize` is small
 * enough to make 80% easily reachable (= 1 KiB). We size the
 * aggregate above 800 B by syncing a single f32 list of length 200.
 */
function smallLimitDevice(): GpuLikeDevice {
  return {
    queue: {
      writeBuffer: () => undefined,
      submit: () => undefined,
    },
    createBuffer: (desc: { size: number; usage: number }): GpuLikeBuffer => ({
      size: desc.size,
      usage: desc.usage,
      destroy: () => undefined,
    }),
    limits: { maxStorageBufferBindingSize: 1024 },
  };
}

function largeLimitDevice(): GpuLikeDevice {
  return {
    queue: {
      writeBuffer: () => undefined,
      submit: () => undefined,
    },
    createBuffer: (desc: { size: number; usage: number }): GpuLikeBuffer => ({
      size: desc.size,
      usage: desc.usage,
      destroy: () => undefined,
    }),
    limits: { maxStorageBufferBindingSize: 256 * 1024 * 1024 },
  };
}

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
});

describe('ListBufferPool: aggregate buffer memory budget (§Phase 3 §3.5)', () => {
  it('starts at zero bytes when no binding has been allocated', () => {
    const pool = new ListBufferPool({ device: largeLimitDevice() });
    expect(pool.bufferBudgetBytes()).toBe(0);
  });

  it('does not warn when the aggregate is below 80% of the GPU limit', () => {
    const pool = new ListBufferPool({ device: largeLimitDevice() });
    pool.bind(bindDirective('small', 0));
    // Allocate well below 80% of 256 MiB (≈205 MiB) — a single 1024-element
    // f32 buffer is 4 KiB.
    const data = new Float32Array(1024);
    pool.get('small')!.syncFromHost(data);
    expect(pool.bufferBudgetBytes()).toBe(1024 * BYTES_PER_ELEMENT.f32);
    const warns = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message.includes('gpu.regional_buffer_memory_pressure'));
    expect(warns).toEqual([]);
  });

  it('surfaces gpu.regional_buffer_memory_pressure when the aggregate crosses 80% of a small GPU limit', () => {
    const pool = new ListBufferPool({ device: smallLimitDevice() });
    pool.bind(bindDirective('big', 0));
    // 1024-element f32 = 4096 B; 200-element f32 = 800 B. Threshold =
    // 1024 * 0.8 = 819.2 B. 800 < 819.2 → no warn yet. Then 1024 → 4096
    // B ≫ 819.2 → warn fires.
    pool.get('big')!.syncFromHost(new Float32Array(200));
    const warnsAfterFirst = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message.includes('gpu.regional_buffer_memory_pressure'));
    expect(warnsAfterFirst).toEqual([]);
    pool.get('big')!.syncFromHost(new Float32Array(1024));
    const warnsAfterSecond = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message.includes('gpu.regional_buffer_memory_pressure'));
    expect(warnsAfterSecond.length).toBeGreaterThanOrEqual(1);
    expect(warnsAfterSecond[0]?.message).toContain('region');
  });

  it('decrements the budget on destroy() and stops warning after rollback', () => {
    const pool = new ListBufferPool({ device: smallLimitDevice() });
    pool.bind(bindDirective('big', 0));
    pool.get('big')!.syncFromHost(new Float32Array(1024));
    expect(pool.bufferBudgetBytes()).toBe(4096);
    // Crosses 80% — warn recorded.
    const beforeDestroy = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message.includes('gpu.regional_buffer_memory_pressure')).length;
    expect(beforeDestroy).toBeGreaterThanOrEqual(1);
    // Drop the buffer; the aggregate resets to 0.
    pool.get('big')!.destroy();
    expect(pool.bufferBudgetBytes()).toBe(0);
    // Re-sync under the threshold — no NEW warn.
    pool.get('big')!.syncFromHost(new Float32Array(10));
    const afterResync = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message.includes('gpu.regional_buffer_memory_pressure')).length;
    expect(afterResync).toBe(beforeDestroy);
  });

  it('resets the budget when the device is replaced', () => {
    const pool = new ListBufferPool({ device: smallLimitDevice() });
    pool.bind(bindDirective('big', 0));
    pool.get('big')!.syncFromHost(new Float32Array(1024));
    expect(pool.bufferBudgetBytes()).toBe(4096);
    pool.setDevice(largeLimitDevice());
    expect(pool.bufferBudgetBytes()).toBe(0);
  });

  it('does not warn when the device is null (jsdom / Safari fallback path)', () => {
    const pool = new ListBufferPool({ device: null });
    pool.bind(bindDirective('big', 0));
    // syncFromHost with device=null must NOT allocate a buffer and
    // must NOT touch the budget counter.
    pool.get('big')!.syncFromHost(new Float32Array(1_000_000));
    expect(pool.bufferBudgetBytes()).toBe(0);
    const warns = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message.includes('gpu.regional_buffer_memory_pressure'));
    expect(warns).toEqual([]);
  });

  it('resetBufferBudget() zeros the counter (test seam)', () => {
    const pool = new ListBufferPool({ device: largeLimitDevice() });
    pool.bind(bindDirective('mid', 0));
    pool.get('mid')!.syncFromHost(new Float32Array(64));
    expect(pool.bufferBudgetBytes()).toBeGreaterThan(0);
    pool.resetBufferBudget();
    expect(pool.bufferBudgetBytes()).toBe(0);
  });
});

// §Phase 3 — `bind()` accepts region metadata for diagnostic attribution.
describe('ListBufferPool.bind: region metadata propagation (§Phase 3)', () => {
  it('attaches regionId / regionBlockId to the binding when provided', () => {
    const pool = new ListBufferPool({ device: largeLimitDevice() });
    const binding = pool.bind(bindDirective('x', 0), {
      regionId: 'region:sprite1:r0:0',
      regionBlockId: 'r0',
    });
    expect(binding.regionId).toBe('region:sprite1:r0:0');
    expect(binding.regionBlockId).toBe('r0');
  });

  it('omits region metadata when not provided', () => {
    const pool = new ListBufferPool({ device: largeLimitDevice() });
    const binding = pool.bind(bindDirective('x', 0));
    expect(binding.regionId).toBeNull();
    expect(binding.regionBlockId).toBeNull();
  });
});

describe('ListBufferPool.setDevice: error log isolation', () => {
  it('does not push gpu.regional_buffer_memory_pressure when the new device has a large limit', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pool = new ListBufferPool({ device: smallLimitDevice() });
    pool.bind(bindDirective('big', 0));
    pool.get('big')!.syncFromHost(new Float32Array(1024));
    // smallLimit → warn fired already.
    const warnsBeforeSwap = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message.includes('gpu.regional_buffer_memory_pressure')).length;
    expect(warnsBeforeSwap).toBeGreaterThanOrEqual(1);
    // Swap to a larger limit; budget resets.
    pool.setDevice(largeLimitDevice());
    pool.bind(bindDirective('big', 0));
    pool.get('big')!.syncFromHost(new Float32Array(1024));
    const warnsAfterSwap = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message.includes('gpu.regional_buffer_memory_pressure')).length;
    // No new warn from the second device.
    expect(warnsAfterSwap).toBe(warnsBeforeSwap);
    spy.mockRestore();
  });
});