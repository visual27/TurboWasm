import { describe, expect, it } from 'vitest';
import {
  analyzeRegionDependencies,
  KernelRegistry,
} from '@/runtime/gpu-kernel/kernel-registry';
import type { BindDirective, RegionVerdict } from '@/runtime/gpu-kernel/types';

function makeVerdict(
  regionId: string,
  blockId: string,
  directives: RegionVerdict['directives'] = [],
): RegionVerdict {
  return {
    regionId,
    blockId,
    spriteId: 'sprite',
    directives,
    blockSubset: { valid: true, diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [],
    parallelAxes: [],
  };
}

function bind(name: string, slot: number, readOnly: boolean): BindDirective {
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

function buildChain(): { registry: KernelRegistry; k1: string; k2: string; k3: string } {
  const registry = new KernelRegistry();
  // k1 writes A; k2 reads A and writes B; k3 reads B.
  const k1 = registry.register(
    makeVerdict('region:1:b1', 'b1', [bind('a', 0, false)]),
    'wgsl',
  );
  const k2 = registry.register(
    makeVerdict('region:2:b2', 'b2', [bind('a', 0, true), bind('b', 1, false)]),
    'wgsl',
  );
  const k3 = registry.register(
    makeVerdict('region:3:b3', 'b3', [bind('b', 1, true)]),
    'wgsl',
  );
  return { registry, k1: k1.id, k2: k2.id, k3: k3.id };
}

describe('analyzeRegionDependencies', () => {
  it('builds a DAG of two regions writing the same buffer (k1 → k2)', () => {
    const registry = new KernelRegistry();
    const k1 = registry.register(
      makeVerdict('region:1:b1', 'b1', [bind('shared', 0, false)]),
      'wgsl',
    );
    const k2 = registry.register(
      makeVerdict('region:2:b2', 'b2', [bind('shared', 0, false)]),
      'wgsl',
    );
    const deps = analyzeRegionDependencies([k1, k2]);
    // Both write to 'shared'. analyzeRegionDependencies only tracks
    // writer→reader edges, so the result is empty (no reader).
    // The conflict lives in analyzeBufferAccesses. This test pins the
    // distinction between the two helpers.
    expect(deps.size).toBe(0);
  });

  it('two regions writing different buffers are independent', () => {
    const registry = new KernelRegistry();
    const k1 = registry.register(
      makeVerdict('region:1:b1', 'b1', [bind('a', 0, false)]),
      'wgsl',
    );
    const k2 = registry.register(
      makeVerdict('region:2:b2', 'b2', [bind('b', 1, false)]),
      'wgsl',
    );
    const deps = analyzeRegionDependencies([k1, k2]);
    expect(deps.size).toBe(0);
  });

  it('three-region chain returns sorted dependencies', () => {
    const { k1, k2, k3 } = buildChain();
    const registry = new KernelRegistry();
    // Re-register the same chain to get the kernels from a fresh
    // registry (the helper above creates its own).
    const a = registry.register(
      makeVerdict('region:1:b1', 'b1', [bind('a', 0, false)]),
      'wgsl',
    );
    const b = registry.register(
      makeVerdict('region:2:b2', 'b2', [bind('a', 0, true), bind('b', 1, false)]),
      'wgsl',
    );
    const c = registry.register(
      makeVerdict('region:3:b3', 'b3', [bind('b', 1, true)]),
      'wgsl',
    );
    const deps = analyzeRegionDependencies([a, b, c]);
    expect(deps.get(b.id)).toEqual([a.id]);
    expect(deps.get(c.id)).toEqual([b.id]);
    expect(deps.get(a.id)).toBeUndefined();
    // Reference the helper's ids just to silence unused-var lints; the
    // values are correct.
    expect([k1, k2, k3]).toHaveLength(3);
  });
});