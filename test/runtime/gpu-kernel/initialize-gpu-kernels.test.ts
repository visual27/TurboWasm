import { beforeEach, describe, expect, it } from 'vitest';
import {
  initializeGpuKernels,
  __resetAdapterUnavailableWarningForTesting,
} from '@/runtime/gpu-kernel/initialize-gpu-kernels';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { GpuLikeDevice } from '@/runtime/gpu-kernel/list-buffer-binding';
import type { ParsedProject, RegionVerdict } from '@/runtime/gpu-kernel/types';

function makeVerdict(blockId: string, valid = true): RegionVerdict {
  return {
    regionId: `region:sprite:${blockId}`,
    blockId,
    spriteId: 'sprite',
    directives: [],
    blockSubset: { valid, diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [],
    parallelAxes: [],
  };
}

const EMPTY_PROJECT: ParsedProject = {
  targets: [
    {
      id: 'sprite',
      isStage: false,
      blocks: {
        b1: { id: 'b1', opcode: 'data_setvariableto', next: null, parent: null, inputs: {}, fields: {} },
      },
    },
  ],
  comments: {},
};

function noopAdapter(): Promise<GpuLikeDevice | null> {
  return Promise.resolve(null);
}

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
  __resetAdapterUnavailableWarningForTesting();
});

describe('initializeGpuKernels', () => {
  it('returns null device + empty objects when navigator.gpu is missing', async () => {
    const result = await initializeGpuKernels(
      {
        regions: [makeVerdict('b1')],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        performanceMode: 'auto',
        enabled: true,
      },
      noopAdapter,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
    expect(result.pool.size()).toBe(0);
    // Single warn emitted — spec §7.1 "no spam".
    const entries = useErrorLogStore.getState().entries;
    expect(entries.some((e) => e.message === 'gpu.adapter_unavailable')).toBe(true);
  });

  it('does not emit duplicate adapter_unavailable warnings across calls', async () => {
    await initializeGpuKernels(
      {
        regions: [],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        performanceMode: 'auto',
        enabled: true,
      },
      noopAdapter,
    );
    await initializeGpuKernels(
      {
        regions: [],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        performanceMode: 'auto',
        enabled: true,
      },
      noopAdapter,
    );
    const warnings = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message === 'gpu.adapter_unavailable');
    expect(warnings).toHaveLength(1);
  });

  it('returns an empty registry without warnings when performanceMode is legacy-only', async () => {
    const result = await initializeGpuKernels(
      {
        regions: [makeVerdict('b1')],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        performanceMode: 'legacy-only',
        enabled: true,
      },
      noopAdapter,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
    expect(useErrorLogStore.getState().entries).toHaveLength(0);
  });

  it('returns an empty registry without warnings when enabled is false', async () => {
    const result = await initializeGpuKernels(
      {
        regions: [makeVerdict('b1')],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        performanceMode: 'auto',
        enabled: false,
      },
      noopAdapter,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
    expect(useErrorLogStore.getState().entries).toHaveLength(0);
  });

  it('skips regions that failed D1 or D3', async () => {
    const result = await initializeGpuKernels(
      {
        regions: [makeVerdict('b1', false)],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        performanceMode: 'auto',
        enabled: true,
      },
      noopAdapter,
    );
    expect(result.registry.size()).toBe(0);
    // D1/D3 demoted regions are not even attempted when the adapter is
    // missing, so no warn is required.
    expect(useErrorLogStore.getState().entries.some((e) => e.severity === 'error')).toBe(false);
  });
});