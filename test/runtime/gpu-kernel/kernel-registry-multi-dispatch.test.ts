/**
 * §Phase 5 (gpu-kernel-dsl-phase5-spec §5.7) — `KernelRegistry`
 * 1-entry-×-N-dispatch-context tests.
 *
 * Three regions sharing identical directives (= identical canonical
 * key) must yield:
 *   - 1 entry in `byCanonicalKey` (one compiled WGSL pipeline)
 *   - 3 entries in `byBlockId` (each procedure_call site resolves to
 *     the same kernel id)
 *   - 3 entries in `dispatchSites` (independent scalar bindings per
 *     call)
 *
 * The test exercises both registration paths — `register()` (driven by
 * `RegionVerdict`) and `registerDispatchSite()` (driven by the runtime
 * adapter's per-call state).
 */
import { describe, expect, it } from 'vitest';
import { canonicalKeyOf, KernelRegistry } from '@/runtime/gpu-kernel/kernel-registry';
import type { BindDirective, RegionVerdict, WorkgroupSizeDirective } from '@/runtime/gpu-kernel/types';

function mkVerdict(blockId: string, regionId: string, spriteId: string): RegionVerdict {
  const bind: BindDirective = {
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
    directives: [bind, workgroup],
    blockSubset: { valid: true, diagnostics: [], effectivePatterns: [] },
    autoTmpVerdict: { valid: true, bindings: [], diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [],
    parallelAxes: [],
    kernelContainerBlockId: blockId,
    firstSubstackBlockId: 'subHead',
  };
}

describe('KernelRegistry: §Phase 5 1-entry × N-dispatch-context', () => {
  it('3 regions sharing canonical key → 1 entry in byCanonicalKey', () => {
    const registry = new KernelRegistry();
    const verdicts = [
      mkVerdict('blockA', 'region:0:A', 'sprite1'),
      mkVerdict('blockB', 'region:0:B', 'sprite1'),
      mkVerdict('blockC', 'region:0:C', 'sprite1'),
    ];
    const wgsl = '@compute @workgroup_size(64) fn main() {}';

    for (const verdict of verdicts) {
      registry.register(verdict, wgsl);
    }

    // Three regions with identical directives share one compiled
    // pipeline. Canonical keys must match exactly.
    expect(verdicts.map((v) => canonicalKeyOf(v)).every((k, _i, arr) => k === arr[0])).toBe(true);
    // byCanonicalKey has exactly one entry.
    expect(registry.size()).toBe(1);
    // byBlockId has three entries — each procedure_call site gets its
    // own lookup row pointing at the same kernel.
    expect(registry.list()).toHaveLength(1);
    for (const blockId of ['blockA', 'blockB', 'blockC']) {
      expect(registry.lookup(blockId)?.canonicalKey).toBe(canonicalKeyOf(verdicts[0]!));
    }
  });

  it('3 regions → 3 independent dispatch sites with separate scalarBindings', () => {
    const registry = new KernelRegistry();
    const verdicts = [
      mkVerdict('blockA', 'region:0:A', 'sprite1'),
      mkVerdict('blockB', 'region:0:B', 'sprite1'),
      mkVerdict('blockC', 'region:0:C', 'sprite1'),
    ];
    for (const verdict of verdicts) {
      registry.register(verdict, '@compute @workgroup_size(64) fn main() {}');
    }
    const sharedCanonicalKey = canonicalKeyOf(verdicts[0]!);

    // Register three independent dispatch sites — each with its own
    // scalarBindings snapshot (representing the per-call-site value
    // read from the runtime adapter at registration time).
    registry.registerDispatchSite('blockA', {
      kernelRef: sharedCanonicalKey,
      scalarBindings: new Map([['tmp0', 1], ['idx0', 0]]),
      spriteContextRef: 'sprite:sprite1',
    });
    registry.registerDispatchSite('blockB', {
      kernelRef: sharedCanonicalKey,
      scalarBindings: new Map([['tmp0', 2], ['idx0', 1]]),
      spriteContextRef: 'sprite:sprite1',
    });
    registry.registerDispatchSite('blockC', {
      kernelRef: sharedCanonicalKey,
      scalarBindings: new Map([['tmp0', 3], ['idx0', 2]]),
      spriteContextRef: 'sprite:sprite1',
    });

    const siteA = registry.lookupDispatchSite('blockA');
    const siteB = registry.lookupDispatchSite('blockB');
    const siteC = registry.lookupDispatchSite('blockC');

    expect(siteA?.kernelRef).toBe(sharedCanonicalKey);
    expect(siteB?.kernelRef).toBe(sharedCanonicalKey);
    expect(siteC?.kernelRef).toBe(sharedCanonicalKey);

    // Each dispatch site carries independent scalarBindings.
    expect(siteA?.scalarBindings.get('tmp0')).toBe(1);
    expect(siteB?.scalarBindings.get('tmp0')).toBe(2);
    expect(siteC?.scalarBindings.get('tmp0')).toBe(3);
    expect(siteA?.scalarBindings.get('idx0')).toBe(0);
    expect(siteB?.scalarBindings.get('idx0')).toBe(1);
    expect(siteC?.scalarBindings.get('idx0')).toBe(2);
  });

  it('clearForProjectReload drops dispatch sites along with kernels', () => {
    const registry = new KernelRegistry();
    const verdict = mkVerdict('blockA', 'region:0:A', 'sprite1');
    registry.register(verdict, '@compute @workgroup_size(64) fn main() {}');
    registry.registerDispatchSite('blockA', {
      kernelRef: canonicalKeyOf(verdict),
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
    const verdict = mkVerdict('blockA', 'region:0:A', 'sprite1');
    registry.register(verdict, '@compute @workgroup_size(64) fn main() {}');
    const key = canonicalKeyOf(verdict);

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
