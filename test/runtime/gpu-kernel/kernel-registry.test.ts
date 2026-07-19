import { beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeBufferAccesses,
  analyzeRegionDependencies,
  canonicalKeyOf,
  KernelRegistry,
} from '@/runtime/gpu-kernel/kernel-registry';
import type {
  BindDirective,
  MapDirective,
  RegionVerdict,
  RepeatDirective,
} from '@/runtime/gpu-kernel/types';

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
    kernelContainerBlockId: blockId,
    nestedRepeatContainerBlockIds: [],
    firstSubstackBlockId: '',
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

function repeatWithBound(name: string, boundBlockId: string): RepeatDirective {
  return {
    kind: 'repeat',
    name,
    axis: 'global_x',
    formula: 'N',
    blockId: 'r0',
    boundBlockId,
    line: 0,
    column: 0,
  };
}

function repeatWithoutBound(name: string): RepeatDirective {
  return {
    kind: 'repeat',
    name,
    axis: 'global_x',
    formula: 'N',
    blockId: 'r0',
    line: 0,
    column: 0,
  };
}

function mapWithBound(varName: string, boundBlockId: string): MapDirective {
  return {
    kind: 'map',
    var: varName,
    formula: 'R0',
    blockId: 'r0',
    boundBlockId,
    line: 0,
    column: 0,
  };
}

function mapWithoutBound(varName: string): MapDirective {
  return {
    kind: 'map',
    var: varName,
    formula: 'R0',
    blockId: 'r0',
    line: 0,
    column: 0,
  };
}

describe('KernelRegistry', () => {
  let registry: KernelRegistry;

  beforeEach(() => {
    registry = new KernelRegistry();
  });

  it('canonicalises equivalent RegionVerdicts to the same key', () => {
    const v1 = makeVerdict('region:1:blk', 'blk', [bind('list_a', 0, false)]);
    const v2 = makeVerdict('region:1:blk', 'blk', [bind('list_a', 0, false)]);
    expect(canonicalKeyOf(v1)).toBe(canonicalKeyOf(v2));
  });

  it('reuses a cached entry on re-register and returns the canonicalKey unchanged', () => {
    const v = makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)]);
    const k1 = registry.register(v, 'wgsl-v1');
    const k2 = registry.register(v, 'wgsl-v2');
    expect(k2).toBe(k1);
    expect(k1.canonicalKey).toBe(canonicalKeyOf(v));
    // The first WGSL wins (cache hit ignores the new source).
    expect(k1.wgsl).toBe('wgsl-v1');
    expect(registry.size()).toBe(1);
  });

  it('lookup returns the kernel by blockId until markJsOnly demotes it', () => {
    const v = makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)]);
    registry.register(v, 'wgsl');
    expect(registry.lookup('b1')).toBeDefined();
    registry.markJsOnly('region:r1:b1', 'adapter_unavailable');
    expect(registry.lookup('b1')).toBeUndefined();
    // lookupById respects the same demote.
    expect(registry.lookupById('region:r1:b1')).toBeUndefined();
  });

  it('clearForProjectReload empties the registry', () => {
    registry.register(makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)]), 'wgsl');
    registry.register(makeVerdict('region:r1:b2', 'b2', [bind('list_b', 1, false)]), 'wgsl');
    expect(registry.size()).toBe(2);
    registry.clearForProjectReload();
    expect(registry.size()).toBe(0);
    expect(registry.lookup('b1')).toBeUndefined();
  });

  it('analyzeBufferAccesses flags rw+rw and rw+ro as conflicts; ro+ro is OK', () => {
    const k1 = registry.register(
      makeVerdict('region:r1:b1', 'b1', [bind('shared', 0, false)]),
      'wgsl',
    );
    const k2 = registry.register(
      makeVerdict('region:r1:b2', 'b2', [bind('shared', 0, false)]),
      'wgsl',
    );
    const k3 = registry.register(
      makeVerdict('region:r1:b3', 'b3', [bind('shared', 0, true)]),
      'wgsl',
    );
    const k4 = registry.register(
      makeVerdict('region:r1:b4', 'b4', [bind('shared', 0, true)]),
      'wgsl',
    );
    const map = analyzeBufferAccesses([k1, k2, k3, k4]);
    const shared = map.get('shared');
    expect(shared).toBeDefined();
    expect(shared).toHaveLength(4);
    const accessByKernel = new Map(shared!.map((entry) => [entry.kernelId, entry.access]));
    expect(accessByKernel.get(k1.id)).toBe('rw');
    expect(accessByKernel.get(k2.id)).toBe('rw');
    expect(accessByKernel.get(k3.id)).toBe('ro');
    expect(accessByKernel.get(k4.id)).toBe('ro');

    // The two ro+ro accesses are concurrent-dispatch-OK; the rw ones need
    // a sync barrier.
    const roRoConflict = shared!.filter(
      (e) => accessByKernel.get(e.kernelId) === 'ro',
    );
    expect(roRoConflict).toHaveLength(2);
  });

  it('analyzeBufferAccesses drops bindings with only one accessor', () => {
    const k1 = registry.register(
      makeVerdict('region:r1:b1', 'b1', [bind('only_one', 0, false)]),
      'wgsl',
    );
    const map = analyzeBufferAccesses([k1]);
    expect(map.has('only_one')).toBe(false);
  });

  it('analyzeRegionDependencies returns writer→reader pairs for shared rw bindings', () => {
    // k1 writes "shared"; k2 reads "shared" → k2 depends on k1.
    const k1 = registry.register(
      makeVerdict('region:r1:b1', 'b1', [bind('shared', 0, false)]),
      'wgsl',
    );
    const k2 = registry.register(
      makeVerdict('region:r1:b2', 'b2', [bind('shared', 1, true)]),
      'wgsl',
    );
    const deps = analyzeRegionDependencies([k1, k2]);
    expect(deps.get(k2.id)).toEqual([k1.id]);
    expect(deps.get(k1.id)).toBeUndefined();
  });

  it('analyzeRegionDependencies ignores independent kernels', () => {
    const k1 = registry.register(
      makeVerdict('region:r1:b1', 'b1', [bind('a', 0, false)]),
      'wgsl',
    );
    const k2 = registry.register(
      makeVerdict('region:r1:b2', 'b2', [bind('b', 1, false)]),
      'wgsl',
    );
    const deps = analyzeRegionDependencies([k1, k2]);
    expect(deps.size).toBe(0);
  });

  it('canonical key ignores boundBlockId on @repeat (Phase 1)', () => {
    const vWith = makeVerdict('region:r1:b1', 'b1', [repeatWithBound('Rx', 'scratch_block_A')]);
    const vWithout = makeVerdict('region:r1:b1', 'b1', [repeatWithoutBound('Rx')]);
    expect(canonicalKeyOf(vWith)).toBe(canonicalKeyOf(vWithout));

    const vDifferentId = makeVerdict('region:r1:b1', 'b1', [repeatWithBound('Rx', 'scratch_block_B')]);
    expect(canonicalKeyOf(vWith)).toBe(canonicalKeyOf(vDifferentId));
  });

  it('canonical key ignores boundBlockId on @map (Phase 1)', () => {
    const vWith = makeVerdict('region:r1:b1', 'b1', [mapWithBound('idx1', 'scratch_block_A')]);
    const vWithout = makeVerdict('region:r1:b1', 'b1', [mapWithoutBound('idx1')]);
    expect(canonicalKeyOf(vWith)).toBe(canonicalKeyOf(vWithout));

    const vDifferentId = makeVerdict('region:r1:b1', 'b1', [mapWithBound('idx1', 'scratch_block_B')]);
    expect(canonicalKeyOf(vWith)).toBe(canonicalKeyOf(vDifferentId));
  });

  describe('canonical key storageKind (§Phase 3, scalar uniform binding)', () => {
    function bindList(name: string, slot: number): BindDirective {
      return { kind: 'bind', name, slot, readOnly: true, dtype: 'f32', storageKind: 'list', line: 0, column: 0 };
    }
    function bindScalar(name: string, slot: number): BindDirective {
      return { kind: 'bind', name, slot, readOnly: true, dtype: 'f32', storageKind: 'scalar', line: 0, column: 0 };
    }
    function bindLegacy(name: string, slot: number): BindDirective {
      // No storageKind field — represents a fixture authored before §Phase 3.
      return { kind: 'bind', name, slot, readOnly: true, dtype: 'f32', line: 0, column: 0 };
    }

    it("treats omitted storageKind as 'list' for canonicalisation", () => {
      // Legacy fixture (no storageKind) and explicit 'list' must share
      // the same canonical key — both produce the storage-buffer path.
      const vLegacy = makeVerdict('region:r1:b1', 'b1', [bindLegacy('buff_r', 0)]);
      const vList = makeVerdict('region:r1:b1', 'b1', [bindList('buff_r', 0)]);
      expect(canonicalKeyOf(vLegacy)).toBe(canonicalKeyOf(vList));
    });

    it("explicit ', list' suffix produces the same canonical key as omitted", () => {
      const vList = makeVerdict('region:r1:b1', 'b1', [bindList('buff_r', 0)]);
      const vLegacy = makeVerdict('region:r1:b1', 'b1', [bindLegacy('buff_r', 0)]);
      expect(canonicalKeyOf(vList)).toBe(canonicalKeyOf(vLegacy));
    });

    it("scalar storageKind produces a different canonical key from list", () => {
      // WGSL output differs: scalar takes the uniform-buffer path while
      // list takes the storage-buffer path. The canonical key MUST
      // distinguish them so a kernel isn't reused across the two paths.
      const vList = makeVerdict('region:r1:b1', 'b1', [bindList('aabb_idx0', 4)]);
      const vScalar = makeVerdict('region:r1:b1', 'b1', [bindScalar('aabb_idx0', 4)]);
      expect(canonicalKeyOf(vList)).not.toBe(canonicalKeyOf(vScalar));
    });

    it("scalar storageKind is canonicalised consistently across fixture reloads", () => {
      // Two separately authored fixtures with the same scalar binding
      // (identical name/slot/dtype/storageKind) must share a canonical
      // key.
      const v1 = makeVerdict('region:r1:b1', 'b1', [bindScalar('screen_w', 8)]);
      const v2 = makeVerdict('region:r1:b1', 'b1', [bindScalar('screen_w', 8)]);
      expect(canonicalKeyOf(v1)).toBe(canonicalKeyOf(v2));
    });
  });
});