import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGpuKernels,
  __getGpuKernelForBrowserVerify,
  __installGpuKernelRegistryForTesting,
  __setGpuKernelDispatcher,
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
    kernelContainerBlockId: 'b1',
    nestedRepeatContainerBlockIds: [],
    firstSubstackBlockId: '',
  };
}

afterEach(() => {
  __uninstallGpuKernelRegistryForTesting();
  __setGpuKernelDispatcher(null);
});

describe('applyGpuKernels', () => {
  it('short-circuits with reason "wasm-disabled" when enableWasm is false', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    const result = applyGpuKernels({
      enabled: true,
      enableWasm: false,
      registry,
      pool,
      device: null,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('wasm-disabled');
    expect(window.__turboWasmGpuKernelLookup).toBeUndefined();
    expect(window.__turboWasmGpuKernelDispatch).toBeUndefined();
  });

  it('short-circuits with reason "disabled" when enabled is false', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    const result = applyGpuKernels({
      enabled: false,
      enableWasm: true,
      registry,
      pool,
      device: null,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(window.__turboWasmGpuKernelLookup).toBeUndefined();
    expect(window.__turboWasmGpuKernelDispatch).toBeUndefined();
  });

  it('installs both dispatcher and lookup when enabled and enableWasm are true', () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    registry.register(verdict(), 'wgsl');
    const result = applyGpuKernels({
      enabled: true,
      enableWasm: true,
      registry,
      pool,
      device: null,
    });
    expect(result.installed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(typeof window.__turboWasmGpuKernelLookup).toBe('function');
    expect(typeof window.__turboWasmGpuKernelDispatch).toBe('function');
    const found = window.__turboWasmGpuKernelLookup?.('b1');
    expect(found).toBeDefined();
    expect(found?.id).toBe('region:test:b1');
  });

  it('dispatcher returns falsy when the kernel is not registered', async () => {
    const registry = new KernelRegistry();
    const pool = new ListBufferPool({ device: null });
    applyGpuKernels({ enabled: true, enableWasm: true, registry, pool, device: null });
    const result = await window.__turboWasmGpuKernelDispatch?.('unknown-block');
    expect(result).toBe(false);
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
