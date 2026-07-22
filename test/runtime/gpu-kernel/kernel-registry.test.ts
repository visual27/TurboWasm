/**
 * Consolidated KernelRegistry tests.
 *
 * Replaces four previous files that all targeted the same registry
 * surface:
 *   - kernel-registry.test.ts (canonical key + register/lookup + storageKind + region aliases)
 *   - kernel-registry-multi-dispatch.test.ts (§Phase 5 1-entry × N dispatch contexts)
 *   - kernel-registry-slot-conflict.test.ts (per-region + cross-region slot overlap diagnostics)
 *   - analyze-region-dependencies.test.ts (writer→reader DAG)
 *
 * The consolidated file is organized by behaviour, not by file origin:
 *   - canonicalKey semantics
 *   - register / lookup / markJsOnly / clearForProjectReload
 *   - multi-dispatch contexts (§Phase 5)
 *   - analyzeBufferAccesses + analyzeRegionDependencies
 *   - per-region / cross-region @bind slot collisions (§Phase 3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectRegionVerdictsFromArrayBuffer } from '@/runtime/gpu-kernel/region-verdict-pipeline';
import {
  analyzeBufferAccesses,
  analyzeRegionDependencies,
  canonicalKeyOf,
  KernelRegistry,
} from '@/runtime/gpu-kernel/kernel-registry';
import type {
  BindDirective,
  MapDirective,
  ParsedProject,
  RawBlock,
  RegionVerdict,
  ResolvedRepeatDirective,
  WorkgroupSizeDirective,
} from '@/runtime/gpu-kernel/types';

function makeVerdict(
  regionId: string,
  blockId: string,
  directives: RegionVerdict['directives'] = [],
  spriteId: string = 'sprite',
): RegionVerdict {
  return {
    regionId,
    blockId,
    spriteId,
    directives,
    blockSubset: { valid: true, diagnostics: [] },
    autoTmpVerdict: { valid: true, bindings: [], reads: new Map(), mutables: [], diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [],
    parallelAxes: [],
    kernelContainerBlockId: blockId,
    firstSubstackBlockId: '',
  };
}

function bind(name: string, slot: number, readOnly: boolean, storageKind?: 'list' | 'scalar'): BindDirective {
  return {
    kind: 'bind',
    name,
    slot,
    readOnly,
    dtype: 'f32',
    ...(storageKind ? { storageKind } : {}),
    line: 0,
    column: 0,
  };
}

function repeatWithBound(name: string, boundBlockId: string): ResolvedRepeatDirective {
  return {
    kind: 'repeat',
    name,
    axis: 'global_x',
    formula: 'N',
    blockId: 'r0',
    repeatPath: 'self',
    boundBlockId,
    resolvedRepeatBlockId: boundBlockId,
    line: 0,
    column: 0,
  };
}

function repeatWithoutBound(name: string): ResolvedRepeatDirective {
  return {
    kind: 'repeat',
    name,
    axis: 'global_x',
    formula: 'N',
    blockId: 'r0',
    repeatPath: 'self',
    resolvedRepeatBlockId: 'r0',
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

function mkVerdictWithDispatch(
  blockId: string,
  regionId: string,
  spriteId: string,
): RegionVerdict {
  const bindDirective: BindDirective = {
    kind: 'bind',
    name: 'buff_r',
    slot: 1,
    readOnly: false,
    dtype: 'f32',
    storageKind: 'list',
    line: 0,
    column: 0,
  };
  const workgroup: WorkgroupSizeDirective = {
    kind: 'workgroup_size',
    x: 64,
    y: 1,
    z: 1,
    line: 0,
    column: 0,
  };
  return {
    regionId,
    blockId,
    spriteId,
    directives: [bindDirective, workgroup],
    blockSubset: { valid: true, diagnostics: [], effectivePatterns: [] },
    autoTmpVerdict: { valid: true, bindings: [], reads: new Map(), mutables: [], diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [],
    parallelAxes: [],
    kernelContainerBlockId: blockId,
    firstSubstackBlockId: 'subHead',
  };
}

function mkBlock(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return {
    id,
    opcode,
    next: null,
    parent: null,
    inputs: {},
    fields: {},
    ...opts,
  };
}

function mkProject(
  blocks: RawBlock[],
  comments: Record<string, { text: string; blockId: string }>,
): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  return {
    targets: [{ id: 'sprite1', isStage: false, blocks: blockMap }],
    comments,
  };
}

describe('canonicalKeyOf: volatility rules', () => {
  it('two verdicts with identical directives share the same key', () => {
    const v1 = makeVerdict('region:1:blk', 'blk', [bind('list_a', 0, false)]);
    const v2 = makeVerdict('region:1:blk', 'blk', [bind('list_a', 0, false)]);
    expect(canonicalKeyOf(v1)).toBe(canonicalKeyOf(v2));
  });

  it('ignores boundBlockId on @repeat (Phase 1)', () => {
    const vWith = makeVerdict('region:r1:b1', 'b1', [repeatWithBound('Rx', 'scratch_block_A')]);
    const vWithout = makeVerdict('region:r1:b1', 'b1', [repeatWithoutBound('Rx')]);
    const vDifferentId = makeVerdict('region:r1:b1', 'b1', [
      repeatWithBound('Rx', 'scratch_block_B'),
    ]);
    expect(canonicalKeyOf(vWith)).toBe(canonicalKeyOf(vWithout));
    expect(canonicalKeyOf(vWith)).toBe(canonicalKeyOf(vDifferentId));
  });

  it('ignores boundBlockId on @map (Phase 1)', () => {
    const vWith = makeVerdict('region:r1:b1', 'b1', [mapWithBound('idx1', 'scratch_block_A')]);
    const vWithout = makeVerdict('region:r1:b1', 'b1', [mapWithoutBound('idx1')]);
    const vDifferentId = makeVerdict('region:r1:b1', 'b1', [
      mapWithBound('idx1', 'scratch_block_B'),
    ]);
    expect(canonicalKeyOf(vWith)).toBe(canonicalKeyOf(vWithout));
    expect(canonicalKeyOf(vWith)).toBe(canonicalKeyOf(vDifferentId));
  });

  it('ignores blockId / regionId but keeps spriteId distinct (§Phase 3 §15.10)', () => {
    const v1 = makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)], 'spriteA');
    const v2 = makeVerdict('region:r1:b2', 'b2', [bind('list_a', 0, false)], 'spriteA');
    const vRenumbered = makeVerdict('region:r1:b1-renumbered', 'b1-renumbered', [
      bind('list_a', 0, false),
    ], 'spriteA');
    const vOtherSprite = makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)], 'spriteB');
    expect(canonicalKeyOf(v1)).toBe(canonicalKeyOf(v2));
    expect(canonicalKeyOf(v1)).toBe(canonicalKeyOf(vRenumbered));
    expect(canonicalKeyOf(v1)).not.toBe(canonicalKeyOf(vOtherSprite));
  });

  it("treats omitted storageKind as 'list' for canonicalisation (Phase 3)", () => {
    const bindLegacy = (name: string, slot: number): BindDirective => ({
      kind: 'bind',
      name,
      slot,
      readOnly: true,
      dtype: 'f32',
      line: 0,
      column: 0,
    });
    const vLegacy = makeVerdict('region:r1:b1', 'b1', [bindLegacy('buff_r', 0)]);
    const vList = makeVerdict('region:r1:b1', 'b1', [bind('buff_r', 0, true, 'list')]);
    expect(canonicalKeyOf(vLegacy)).toBe(canonicalKeyOf(vList));
  });

  it("scalar storageKind produces a distinct key from list (§Phase 3)", () => {
    const vList = makeVerdict('region:r1:b1', 'b1', [bind('aabb_idx0', 4, true, 'list')]);
    const vScalar = makeVerdict('region:r1:b1', 'b1', [bind('aabb_idx0', 4, true, 'scalar')]);
    expect(canonicalKeyOf(vList)).not.toBe(canonicalKeyOf(vScalar));
  });

  it('scalar storageKind canonicalises consistently across fixture reloads', () => {
    const v1 = makeVerdict('region:r1:b1', 'b1', [bind('screen_w', 8, true, 'scalar')]);
    const v2 = makeVerdict('region:r1:b1', 'b1', [bind('screen_w', 8, true, 'scalar')]);
    expect(canonicalKeyOf(v1)).toBe(canonicalKeyOf(v2));
  });
});

describe('KernelRegistry: register / lookup / markJsOnly / clear', () => {
  let registry: KernelRegistry;

  beforeEach(() => {
    registry = new KernelRegistry();
  });

  it('reuses a cached entry on re-register (first WGSL wins)', () => {
    const v = makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)]);
    const k1 = registry.register(v, 'wgsl-v1');
    const k2 = registry.register(v, 'wgsl-v2');
    expect(k2).toBe(k1);
    expect(k1.canonicalKey).toBe(canonicalKeyOf(v));
    expect(k1.wgsl).toBe('wgsl-v1');
    expect(registry.size()).toBe(1);
  });

  it('lookup returns the kernel by blockId until markJsOnly demotes it', () => {
    registry.register(makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)]), 'wgsl');
    expect(registry.lookup('b1')).toBeDefined();
    registry.markJsOnly('region:r1:b1', 'adapter_unavailable');
    expect(registry.lookup('b1')).toBeUndefined();
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

  it('reuses the cached kernel for renumbered block ids (§Phase 3 §15.10)', () => {
    const v1 = makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)]);
    const k1 = registry.register(v1, 'wgsl-v1');
    const v2 = makeVerdict('region:r1:b2', 'b2', [bind('list_a', 0, false)]);
    const k2 = registry.register(v2, 'wgsl-v2');
    expect(k2).toBe(k1);
    expect(k1.wgsl).toBe('wgsl-v1');
    expect(registry.lookup('b1')).toBe(k1);
    expect(registry.lookup('b2')).toBe(k1);
    expect(registry.size()).toBe(1);
  });

  it('markJsOnly on a merged kernel demotes every blockId alias', () => {
    registry.register(makeVerdict('region:r1:b1', 'b1', [bind('list_a', 0, false)]), 'wgsl');
    registry.register(makeVerdict('region:r1:b2', 'b2', [bind('list_a', 0, false)]), 'wgsl');
    expect(registry.lookup('b1')).toBeDefined();
    expect(registry.lookup('b2')).toBeDefined();
    const merged = registry.lookup('b1')!;
    registry.markJsOnly(merged.id, 'adapter_unavailable');
    expect(registry.lookup('b1')).toBeUndefined();
    expect(registry.lookup('b2')).toBeUndefined();
  });
});

describe('KernelRegistry: §Phase 5 1-entry × N dispatch contexts', () => {
  it('3 regions sharing canonical key → 1 entry in byCanonicalKey, 3 lookups by blockId', () => {
    const registry = new KernelRegistry();
    const verdicts = [
      mkVerdictWithDispatch('blockA', 'region:0:A', 'sprite1'),
      mkVerdictWithDispatch('blockB', 'region:0:B', 'sprite1'),
      mkVerdictWithDispatch('blockC', 'region:0:C', 'sprite1'),
    ];
    const wgsl = '@compute @workgroup_size(64) fn main() {}';
    for (const v of verdicts) registry.register(v, wgsl);
    expect(verdicts.map((v) => canonicalKeyOf(v)).every((k, _i, arr) => k === arr[0])).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.list()).toHaveLength(1);
    for (const blockId of ['blockA', 'blockB', 'blockC']) {
      expect(registry.lookup(blockId)?.canonicalKey).toBe(canonicalKeyOf(verdicts[0]!));
    }
  });

  it('3 regions → 3 independent dispatch sites with separate scalarBindings', () => {
    const registry = new KernelRegistry();
    const verdicts = [
      mkVerdictWithDispatch('blockA', 'region:0:A', 'sprite1'),
      mkVerdictWithDispatch('blockB', 'region:0:B', 'sprite1'),
      mkVerdictWithDispatch('blockC', 'region:0:C', 'sprite1'),
    ];
    for (const v of verdicts) registry.register(v, '@compute @workgroup_size(64) fn main() {}');
    const key = canonicalKeyOf(verdicts[0]!);
    registry.registerDispatchSite('blockA', {
      kernelRef: key,
      scalarBindings: new Map([
        ['tmp0', 1],
        ['idx0', 0],
      ]),
      spriteContextRef: 'sprite:sprite1',
    });
    registry.registerDispatchSite('blockB', {
      kernelRef: key,
      scalarBindings: new Map([
        ['tmp0', 2],
        ['idx0', 1],
      ]),
      spriteContextRef: 'sprite:sprite1',
    });
    registry.registerDispatchSite('blockC', {
      kernelRef: key,
      scalarBindings: new Map([
        ['tmp0', 3],
        ['idx0', 2],
      ]),
      spriteContextRef: 'sprite:sprite1',
    });
    expect(registry.lookupDispatchSite('blockA')?.scalarBindings.get('tmp0')).toBe(1);
    expect(registry.lookupDispatchSite('blockB')?.scalarBindings.get('tmp0')).toBe(2);
    expect(registry.lookupDispatchSite('blockC')?.scalarBindings.get('tmp0')).toBe(3);
    expect(registry.lookupDispatchSite('blockA')?.scalarBindings.get('idx0')).toBe(0);
    expect(registry.lookupDispatchSite('blockC')?.scalarBindings.get('idx0')).toBe(2);
  });

  it('clearForProjectReload drops dispatch sites along with kernels', () => {
    const registry = new KernelRegistry();
    const v = mkVerdictWithDispatch('blockA', 'region:0:A', 'sprite1');
    registry.register(v, '@compute @workgroup_size(64) fn main() {}');
    registry.registerDispatchSite('blockA', {
      kernelRef: canonicalKeyOf(v),
      scalarBindings: new Map(),
      spriteContextRef: 'sprite:sprite1',
    });
    expect(registry.lookupDispatchSite('blockA')).toBeDefined();
    registry.clearForProjectReload();
    expect(registry.lookup('blockA')).toBeUndefined();
    expect(registry.lookupDispatchSite('blockA')).toBeUndefined();
  });

  it('registerDispatchSite overwrites a previous context for the same blockId', () => {
    const registry = new KernelRegistry();
    const v = mkVerdictWithDispatch('blockA', 'region:0:A', 'sprite1');
    registry.register(v, '@compute @workgroup_size(64) fn main() {}');
    const key = canonicalKeyOf(v);
    registry.registerDispatchSite('blockA', {
      kernelRef: key,
      scalarBindings: new Map([['a', 1]]),
      spriteContextRef: 'sprite:sprite1',
    });
    registry.registerDispatchSite('blockA', {
      kernelRef: key,
      scalarBindings: new Map([['a', 2]]),
      spriteContextRef: 'sprite:sprite1',
    });
    expect(registry.lookupDispatchSite('blockA')?.scalarBindings.get('a')).toBe(2);
  });
});

describe('analyzeBufferAccesses + analyzeRegionDependencies', () => {
  it('flags rw+rw / rw+ro accesses per binding; ro+ro accesses are concurrent-dispatch-OK', () => {
    const registry = new KernelRegistry();
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
    expect(shared).toHaveLength(4);
    const accessByKernel = new Map(shared!.map((e) => [e.kernelId, e.access]));
    expect(accessByKernel.get(k1.id)).toBe('rw');
    expect(accessByKernel.get(k2.id)).toBe('rw');
    expect(accessByKernel.get(k3.id)).toBe('ro');
    expect(accessByKernel.get(k4.id)).toBe('ro');
    expect(shared!.filter((e) => accessByKernel.get(e.kernelId) === 'ro')).toHaveLength(2);
  });

  it('drops bindings with only one accessor', () => {
    const registry = new KernelRegistry();
    const k1 = registry.register(
      makeVerdict('region:r1:b1', 'b1', [bind('only_one', 0, false)]),
      'wgsl',
    );
    expect(analyzeBufferAccesses([k1]).has('only_one')).toBe(false);
  });

  it('analyzeRegionDependencies: writer→reader pairs for shared rw bindings', () => {
    const registry = new KernelRegistry();
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

  it('analyzeRegionDependencies: independent kernels produce no edges', () => {
    const registry = new KernelRegistry();
    const k1 = registry.register(
      makeVerdict('region:r1:b1', 'b1', [bind('a', 0, false)]),
      'wgsl',
    );
    const k2 = registry.register(
      makeVerdict('region:r1:b2', 'b2', [bind('b', 1, false)]),
      'wgsl',
    );
    expect(analyzeRegionDependencies([k1, k2]).size).toBe(0);
  });

  it('analyzeRegionDependencies: rw+rw writes do not surface as a reader edge', () => {
    // The conflict lives in analyzeBufferAccesses; analyzeRegionDependencies
    // only tracks writer→reader pairs. This pins the distinction.
    const registry = new KernelRegistry();
    const k1 = registry.register(
      makeVerdict('region:r1:b1', 'b1', [bind('shared', 0, false)]),
      'wgsl',
    );
    const k2 = registry.register(
      makeVerdict('region:r1:b2', 'b2', [bind('shared', 0, false)]),
      'wgsl',
    );
    expect(analyzeRegionDependencies([k1, k2]).size).toBe(0);
  });

  it('analyzeRegionDependencies: three-region chain returns sorted edges', () => {
    const registry = new KernelRegistry();
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
  });
});

describe('region-verdict-pipeline: per-region @bind slot uniqueness (§Phase 3 §3.2)', () => {
  it('emits gpu.bind_slot_collision when two @bind share slot 0 in one region', () => {
    const project = mkProject([mkBlock('repeat0', 'control_repeat', { inputs: { SUBSTACK: 'a' } }), mkBlock('a', 'data_setvariableto')], {
      cmt1: {
        text:
          '@compute\n@bind foo(0) ro f32\n@bind bar(0) rw f32\n@workgroup_size(64)\n@repeat R0:global_x = 4\n@map R0 <- 0\n',
        blockId: 'repeat0',
      },
    });
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(project);
    expect(verdicts).toHaveLength(1);
    const slotDiag = verdicts[0]!.diagnostics.find(
      (d) => d.code === 'gpu.bind_slot_collision' && d.severity === 'error',
    );
    expect(slotDiag).toBeDefined();
    expect(slotDiag?.message).toMatch(/foo/);
    expect(slotDiag?.message).toMatch(/bar/);
    expect(slotDiag?.message).toContain('slot 0');
    expect(verdicts[0]!.blockSubset.diagnostics).toContainEqual(slotDiag);
    expect(verdicts[0]!.blockSubset.valid).toBe(false);
    expect(verdicts[0]!.blockSubset.demoteReason).toBe('d1');
  });

  it('allows @bind at distinct slots within the same region', () => {
    const project = mkProject([mkBlock('repeat0', 'control_repeat', { inputs: { SUBSTACK: 'a' } }), mkBlock('a', 'data_setvariableto')], {
      cmt1: {
        text:
          '@compute\n@bind foo(0) ro f32\n@bind bar(1) rw f32\n@bind baz(2) ro f32\n@workgroup_size(64)\n@repeat R0:global_x = 4\n@map R0 <- 0\n',
        blockId: 'repeat0',
      },
    });
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(project);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.diagnostics.find((d) => d.code === 'gpu.bind_slot_collision')).toBeUndefined();
    expect(verdicts[0]!.blockSubset.valid).toBe(true);
  });
});

describe('region-verdict-pipeline: cross-region @bind slot overlap (§Phase 3 §3.2)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it('logs a single console.debug line when two regions share a slot', () => {
    const repeatA = mkBlock('repeatA', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const a = mkBlock('a', 'data_setvariableto');
    const repeatB = mkBlock('repeatB', 'control_repeat', { inputs: { SUBSTACK: 'b' } });
    const b = mkBlock('b', 'data_setvariableto');
    const project = mkProject([repeatA, a, repeatB, b], {
      cmtA: {
        text:
          '@compute\n@bind tmp0(0) ro f32\n@bind shared(2) rw f32\n@workgroup_size(64)\n@repeat R0:global_x = 4\n@map R0 <- 0\n',
        blockId: 'repeatA',
      },
      cmtB: {
        text:
          '@compute\n@bind tmp1(1) ro f32\n@bind shared(2) ro f32\n@workgroup_size(32)\n@repeat R1:global_x = 4\n@map R1 <- 0\n',
        blockId: 'repeatB',
      },
    });
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(project);
    expect(verdicts).toHaveLength(2);
    for (const v of verdicts) {
      expect(v.diagnostics.find((d) => d.code === 'gpu.cross_region_slot_overlap')).toBeUndefined();
    }
    const overlapLines = debugSpy.mock.calls.filter((call: unknown[]) => {
      const msg = call[0];
      return typeof msg === 'string' && msg.includes('cross-region slot overlap');
    });
    expect(overlapLines).toHaveLength(1);
    expect(String(overlapLines[0]?.[0])).toContain('slot 2');
    expect(String(overlapLines[0]?.[0])).toContain('shared');
  });

  it('stays silent when the two regions have no overlapping slots', () => {
    const repeatA = mkBlock('repeatA', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const a = mkBlock('a', 'data_setvariableto');
    const repeatB = mkBlock('repeatB', 'control_repeat', { inputs: { SUBSTACK: 'b' } });
    const b = mkBlock('b', 'data_setvariableto');
    const project = mkProject([repeatA, a, repeatB, b], {
      cmtA: {
        text:
          '@compute\n@bind tmp0(0) ro f32\n@bind onlyA(2) rw f32\n@workgroup_size(64)\n@repeat R0:global_x = 4\n@map R0 <- 0\n',
        blockId: 'a',
      },
      cmtB: {
        text:
          '@compute\n@bind tmp1(1) ro f32\n@bind onlyB(3) ro f32\n@workgroup_size(32)\n@repeat R1:global_x = 4\n@map R1 <- 0\n',
        blockId: 'b',
      },
    });
    collectRegionVerdictsFromArrayBuffer(project);
    const overlapLines = debugSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0] ?? '').includes('cross-region slot overlap'),
    );
    expect(overlapLines).toHaveLength(0);
  });
});
