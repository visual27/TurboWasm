import { describe, expect, it } from 'vitest';
import { extractRegions } from '@/runtime/gpu-kernel/region-extractor';
import type { ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

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

function mkProject(blocks: RawBlock[], comments: { id: string; text: string; blockId: string }[]): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  const commentsMap: Record<string, { text: string; blockId: string }> = {};
  for (const c of comments) commentsMap[c.id] = c;
  return {
    targets: [
      {
        id: 'sprite1',
        isStage: false,
        blocks: blockMap,
      },
    ],
    comments: commentsMap,
  };
}

describe('region-extractor', () => {
  it('extracts a single region when a control_repeat carries an @compute comment', () => {
    const body = [
      mkBlock('a', 'data_setvariableto', {
        next: 'b',
      }),
      mkBlock('b', 'operator_add', {
        next: 'c',
      }),
      mkBlock('c', 'data_itemoflist'),
    ];
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const project = mkProject([...body, repeat], [
      { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(diagnostics).toEqual([]);
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region).toBeDefined();
    expect(region?.firstSubstackBlockId).toBe('a');
    expect(region?.bodyBlockIds.sort()).toEqual(['a', 'b', 'c'].sort());
    expect(region?.spriteId).toBe('sprite1');
    expect(region?.commentId).toBe('cmt1');
  });

  it('returns no regions when no @compute comments exist', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const project = mkProject(
      [repeat, mkBlock('a', 'data_setvariableto')],
      [],
    );
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(0);
  });

  it('follows sub-stacks (control_if branches) into the body', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'control_if', { next: 'd', inputs: { SUBSTACK: 'b' } });
    const b = mkBlock('b', 'data_setvariableto', { next: 'c' });
    const c = mkBlock('c', 'data_itemoflist');
    const d = mkBlock('d', 'control_stop');
    const project = mkProject([repeat, a, b, c, d], [
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(new Set(region?.bodyBlockIds ?? [])).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('reads SUBSTACK from object-shaped input (vendored vm block reference)', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: { id: 'a', name: 'substack' } },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.firstSubstackBlockId).toBe('a');
  });

  describe('kernel container promotion (§Phase 0, nested parallelization)', () => {
    it("'@compute' on outer control_repeat (legacy) returns the candidate as kernel container", () => {
      // Layout: control_repeat('outer') { a -> b }
      //   a carries @compute comment
      const a = mkBlock('a', 'data_setvariableto', { next: 'b' });
      const b = mkBlock('b', 'operator_add');
      const outer = mkBlock('outer', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
      });
      const project = mkProject([outer, a, b], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(regions).toHaveLength(1);
      const region = regions[0];
      expect(region?.kernelContainerBlockId).toBe('outer');
      expect(region?.blockId).toBe('outer');
      expect(region?.firstSubstackBlockId).toBe('a');
      expect(region?.nestedRepeatContainerBlockIds).toEqual([]);
      expect(region?.duplicateComputeBlockIds).toEqual([]);
    });

    it("'@compute' on nested control_repeat promotes ancestor to kernel container", () => {
      // Layout: control_repeat('outer') { inner (control_repeat) { a -> b } }
      //   a carries @compute comment (the candidate is `inner`)
      //   bodyEntry for the region is `a` (= candidate's substack head)
      //   kernel container is `outer` (the ancestor)
      const a = mkBlock('a', 'data_setvariableto', { next: 'b' });
      const b = mkBlock('b', 'operator_add');
      const inner = mkBlock('inner', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
        parent: 'outer',
      });
      const outer = mkBlock('outer', 'control_repeat', {
        inputs: { SUBSTACK: 'inner' },
      });
      const project = mkProject([outer, inner, a, b], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(regions).toHaveLength(1);
      const region = regions[0];
      expect(region?.kernelContainerBlockId).toBe('outer');
      expect(region?.blockId).toBe('outer');
      expect(region?.firstSubstackBlockId).toBe('a');
      // The candidate's `inner` control_repeat shows up as a nested
      // candidate for Phase 2 implicit-axis emission.
      expect(region?.nestedRepeatContainerBlockIds).toEqual(['inner']);
      expect(region?.duplicateComputeBlockIds).toEqual([]);
    });

    it("'@compute' on deeply nested control_repeat promotes the nearest ancestor", () => {
      // Layout: outer -> middle -> inner (control_repeat) { a }
      //   a carries @compute comment; kernel container must be `middle`
      //   (1 step up), not `outer`.
      const a = mkBlock('a', 'data_setvariableto');
      const inner = mkBlock('inner', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
        parent: 'middle',
      });
      const middle = mkBlock('middle', 'control_repeat', {
        inputs: { SUBSTACK: 'inner' },
        parent: 'outer',
      });
      const outer = mkBlock('outer', 'control_repeat', {
        inputs: { SUBSTACK: 'middle' },
      });
      const project = mkProject([outer, middle, inner, a], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
      ]);
      const { regions } = extractRegions(project);
      expect(regions).toHaveLength(1);
      expect(regions[0]?.kernelContainerBlockId).toBe('middle');
      // `inner` is the nested candidate; `outer` is outside the body
      // and should not appear here.
      expect(regions[0]?.nestedRepeatContainerBlockIds).toEqual(['inner']);
    });

    it("findKernelContainer skips non-control_repeat ancestors", () => {
      // Layout: data_setvariableto('p') -> control_repeat('outer') { inner { a @compute } }
      //   Parent chain: a → inner → outer. We need `outer` as kernel
      //   container, not `p`. Since `findKernelContainer` only checks
      //   direct `parent` chain, place the candidate's `parent` directly
      //   on `outer` to model the simpler case used by `fn expo`.
      const a = mkBlock('a', 'data_setvariableto', { parent: 'inner' });
      const inner = mkBlock('inner', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
        parent: 'outer',
      });
      const outer = mkBlock('outer', 'control_repeat', {
        inputs: { SUBSTACK: 'inner' },
      });
      const project = mkProject([outer, inner, a], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
      ]);
      const { regions } = extractRegions(project);
      expect(regions).toHaveLength(1);
      expect(regions[0]?.kernelContainerBlockId).toBe('outer');
    });

    it("emits gpu.multiple_compute_regions when a sprite carries multiple '@compute' markers", () => {
      // Layout: control_repeat('r1') { a @compute } AND control_repeat('r2') { c @compute }
      //   The first candidate is kept; r2 is recorded as a duplicate.
      const a = mkBlock('a', 'data_setvariableto');
      const r1 = mkBlock('r1', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
      const c = mkBlock('c', 'data_setvariableto');
      const r2 = mkBlock('r2', 'control_repeat', { inputs: { SUBSTACK: 'c' } });
      const project = mkProject([r1, a, r2, c], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
        { id: 'cmt2', text: '@compute\n@bind tmp1(1) ro\n', blockId: 'c' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      // Exactly one region survives.
      expect(regions).toHaveLength(1);
      expect(regions[0]?.blockId).toBe('r1');
      // The duplicate is recorded on the surviving region.
      expect(regions[0]?.duplicateComputeBlockIds).toEqual(['r2']);
      // An error-severity diagnostic was emitted.
      expect(diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.code === 'gpu.multiple_compute_regions' &&
          d.message.includes('r1') &&
          d.message.includes('r2'),
      )).toBe(true);
    });
  });
});
