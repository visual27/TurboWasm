import { beforeEach, describe, expect, it } from 'vitest';
import {
  initializeGpuKernels,
  __resetAdapterUnavailableWarningForTesting,
} from '@/runtime/gpu-kernel/initialize-gpu-kernels';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { GpuLikeDevice } from '@/runtime/gpu-kernel/list-buffer-binding';
import type { ParsedProject, RegionVerdict } from '@/runtime/gpu-kernel/types';
import { collectRegionVerdictsFromArrayBuffer } from '@/runtime/gpu-kernel/region-verdict-pipeline';
import { forwardGpuDiagnostics } from '@/runtime/gpu-kernel/diagnostic-forwarding';

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
    kernelContainerBlockId: blockId,
    nestedRepeatContainerBlockIds: [],
    firstSubstackBlockId: '',
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

/**
 * Minimal WebGPU device mock used to exercise the `initializeGpuKernels`
 * branch that needs `device !== null` so the emitter actually runs and
 * populates `result.emitDiagnostics`. Mirrors the `createBuffer` /
 * `queue.{writeBuffer, submit}` surface used by `ListBufferPool`.
 */
function makeFakeDevice(): GpuLikeDevice {
  return {
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
    createBuffer: (desc) => ({
      size: desc.size,
      usage: desc.usage,
      destroy: () => undefined,
    }),
  };
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
        enableWasm: true,
        enabled: true,
      },
      noopAdapter,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
    expect(result.pool.size()).toBe(0);
    // emitDiagnostics is undefined on the early-return path (no
    // emitter ran). §Phase 5 §15.14 — caller must treat `undefined`
    // the same as `[]`.
    expect(result.emitDiagnostics).toBeUndefined();
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
        enableWasm: true,
        enabled: true,
      },
      noopAdapter,
    );
    await initializeGpuKernels(
      {
        regions: [],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        enableWasm: true,
        enabled: true,
      },
      noopAdapter,
    );
    const warnings = useErrorLogStore
      .getState()
      .entries.filter((e) => e.message === 'gpu.adapter_unavailable');
    expect(warnings).toHaveLength(1);
  });

  it('returns an empty registry without warnings when enableWasm is false', async () => {
    const result = await initializeGpuKernels(
      {
        regions: [makeVerdict('b1')],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        enableWasm: false,
        enabled: true,
      },
      noopAdapter,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
    expect(result.emitDiagnostics).toBeUndefined();
    expect(useErrorLogStore.getState().entries).toHaveLength(0);
  });

  it('returns an empty registry without warnings when enabled is false', async () => {
    const result = await initializeGpuKernels(
      {
        regions: [makeVerdict('b1')],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        enableWasm: true,
        enabled: false,
      },
      noopAdapter,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
    expect(result.emitDiagnostics).toBeUndefined();
    expect(useErrorLogStore.getState().entries).toHaveLength(0);
  });

  it('skips regions that failed D1 or D3', async () => {
    const result = await initializeGpuKernels(
      {
        regions: [makeVerdict('b1', false)],
        parsedProject: EMPTY_PROJECT,
        runtimeState: { listLengths: {} },
        enableWasm: true,
        enabled: true,
      },
      noopAdapter,
    );
    expect(result.registry.size()).toBe(0);
    // D1/D3 demoted regions are not even attempted when the adapter is
    // missing, so no warn is required.
    expect(useErrorLogStore.getState().entries.some((e) => e.severity === 'error')).toBe(false);
  });

  it('§Phase 5 §15.14 — collects emitter warnings into emitDiagnostics when a device is present', async () => {
    // Build a project whose @compute region declares `@bind let(0) ro f32`
    // — a WGSL reserved keyword. The emitter renames it and emits a
    // `gpu.identifier_collision` warn. We drive the M3 pipeline
    // directly so the synthesized block tree matches the format
    // `region-extractor` expects.
    const repeat = {
      id: 'repeat0',
      opcode: 'control_repeat',
      next: null,
      parent: null,
      inputs: { SUBSTACK: { id: 'body', name: 'SUBSTACK' } },
      fields: {},
    } as const;
    const body = {
      id: 'body',
      opcode: 'data_setvariableto',
      next: null,
      parent: 'repeat0',
      inputs: {},
      fields: { VARIABLE: ['result', null] },
    } as const;
    const project: ParsedProject = {
      targets: [
        {
          id: 'sprite',
          isStage: false,
          blocks: {
            repeat0: { ...repeat, inputs: { SUBSTACK: { id: 'body', name: 'SUBSTACK' } } },
            body: { ...body, inputs: {} },
          },
        },
      ],
      comments: {
        cmt_compute: {
          blockId: 'body',
          text: [
            '@compute',
            // Reserved keyword — triggers `gpu.identifier_collision` (warn).
            '@bind let(0) ro f32',
            '@workgroup_size(64)',
            // The dispatch formula references the renamed `__tw_<hash>` to
            // satisfy D2's formula-reference check; we use a constant for
            // simplicity because the exact name only matters for the
            // bind-time name collision, not the dispatch evaluation.
            '@repeat R0:global_x = 1',
            '@map R0 <- 0',
          ].join('\n'),
        },
      },
    };
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(project);
    expect(verdicts).toHaveLength(1);

    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject: project,
        runtimeState: { listLengths: { result: 0 } },
        enableWasm: true,
        enabled: true,
      },
      async () => makeFakeDevice(),
    );
    expect(result.device).not.toBeNull();
    // The identifier-collision warning is collected even though the
    // kernel still registers (the rename is the resolution path).
    const collisionDiag = (result.emitDiagnostics ?? []).find(
      (d) => d.code === 'gpu.identifier_collision',
    );
    expect(collisionDiag).toBeDefined();
    expect(collisionDiag?.severity).toBe('warn');

    // Forwarding through the shared helper pushes the warn into the
    // store with the canonical `[code region=...] message` format.
    forwardGpuDiagnostics(result.emitDiagnostics ?? []);
    const stored = useErrorLogStore
      .getState()
      .entries.find((e) => e.message.includes('gpu.identifier_collision'));
    expect(stored).toBeDefined();
  });

  it('§Phase 5 §15.14 — returns an empty emitDiagnostics array when the emitter runs cleanly', async () => {
    const project: ParsedProject = {
      targets: [
        {
          id: 'sprite',
          isStage: false,
          blocks: {
            repeat0: {
              id: 'repeat0',
              opcode: 'control_repeat',
              next: null,
              parent: null,
              inputs: { SUBSTACK: { id: 'body', name: 'SUBSTACK' } },
              fields: {},
            },
            body: {
              id: 'body',
              opcode: 'data_setvariableto',
              next: null,
              parent: 'repeat0',
              inputs: {},
              fields: { VARIABLE: ['result', null] },
            },
          },
        },
      ],
      comments: {
        cmt_compute: {
          blockId: 'body',
          text: [
            '@compute',
            '@bind safe_name(0) ro f32',
            '@workgroup_size(64)',
            '@repeat R0:global_x = 1',
            '@map R0 <- 0',
          ].join('\n'),
        },
      },
    };
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(project);
    expect(verdicts).toHaveLength(1);

    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject: project,
        runtimeState: { listLengths: {} },
        enableWasm: true,
        enabled: true,
      },
      async () => makeFakeDevice(),
    );
    expect(result.emitDiagnostics ?? []).toEqual([]);
  });
});
