import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGpuKernels,
  __getGpuKernelForBrowserVerify,
  __installGpuKernelRegistryForTesting,
  __uninstallGpuKernelRegistryForTesting,
} from '@/runtime/gpu-kernel/apply-gpu-kernels';
import { KernelRegistry } from '@/runtime/gpu-kernel/kernel-registry';
import { ListBufferPool } from '@/runtime/gpu-kernel/list-buffer-binding';
import type { RegionVerdict } from '@/runtime/gpu-kernel/types';

function verdict(): RegionVerdict {
  return {
    regionId: 'region:test:b1',
    blockId: 'b1',
    spriteId: 'sprite',
    directives: [
      {
        kind: 'bind',
        name: 'a',
        slot: 0,
        readOnly: false,
        dtype: 'f32',
        line: 0,
        column: 0,
      },
    ],
    blockSubset: { valid: true, diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [],
    parallelAxes: [],
  };
}

afterEach(() => {
  __uninstallGpuKernelRegistryForTesting();
});

describe('applyGpuKernels', () => {
  it('short-circuits with reason "legacy-only" when performanceMode pins it', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    const result = applyGpuKernels({
      enabled: true,
      performanceMode: 'legacy-only',
      registry,
      pool,
      device: null,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('legacy-only');
    expect(window.__turboWasmGpuKernelLookup).toBeUndefined();
  });

  it('short-circuits with reason "disabled" when enabled is false', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    const result = applyGpuKernels({
      enabled: false,
      performanceMode: 'auto',
      registry,
      pool,
      device: null,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(window.__turboWasmGpuKernelLookup).toBeUndefined();
  });

  it('installs the lookup hook when enabled and performanceMode allows it', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    registry.register(verdict(), 'wgsl');
    const result = applyGpuKernels({
      enabled: true,
      performanceMode: 'auto',
      registry,
      pool,
      device: null,
    });
    expect(result.installed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(typeof window.__turboWasmGpuKernelLookup).toBe('function');
    const found = window.__turboWasmGpuKernelLookup?.('b1');
    expect(found).toBeDefined();
    expect(found?.id).toBe('region:test:b1');
  });

  it('__installGpuKernelRegistryForTesting round-trips with __uninstall', () => {
    const registry = new KernelRegistry();
    registry.register(verdict(), 'wgsl');
    __installGpuKernelRegistryForTesting(registry);
    expect(window.__turboWasmGpuKernelLookup).toBeDefined();
    __uninstallGpuKernelRegistryForTesting();
    expect(window.__turboWasmGpuKernelLookup).toBeUndefined();
  });

  it('__getGpuKernelForBrowserVerify returns a snapshot of size + jsOnly + canonicalKeys', () => {
    const registry = new KernelRegistry();
    registry.register(verdict(), 'wgsl');
    const snapshot = __getGpuKernelForBrowserVerify(registry);
    expect(snapshot.size).toBe(1);
    expect(snapshot.jsOnly).toBe(0);
    expect(snapshot.canonicalKeys).toHaveLength(1);
  });
});