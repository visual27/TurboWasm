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

function mkProject(
  blocks: RawBlock[],
  comments: { id: string; text: string; blockId: string }[],
): ParsedProject {
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

describe('region-extractor (§Phase 4 — Form A only)', () => {
  it("adopts a region when the @compute marker sits on a control_repeat", () => {
    const a = mkBlock('a', 'data_setvariableto');
    const r = mkBlock('r', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const project = mkProject([r, a], [
      { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'r' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region?.blockId).toBe('r');
    expect(region?.kernelContainerBlockId).toBe('r');
    expect(region?.commentAnchorBlockId).toBe('r');
    expect(region?.firstSubstackBlockId).toBe('a');
    expect(region?.bodyBlockIds).toEqual(['a']);
    expect(region?.repeatPathTable['self']).toBe('r');
  });

  it('legacy first-substack comment is skipped with gpu.legacy_compute_comment_position', () => {
    const a = mkBlock('a', 'data_setvariableto');
    const r = mkBlock('r', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const project = mkProject([r, a], [
      { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(0);
    const warn = diagnostics.find(
      (d) => d.code === 'gpu.legacy_compute_comment_position',
    );
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warn');
  });

  it('non-control_repeat anchor is skipped with the same warning', () => {
    const a = mkBlock('a', 'data_setvariableto', { next: 'b' });
    const b = mkBlock('b', 'operator_add');
    const project = mkProject([a, b], [
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(0);
    const warn = diagnostics.find(
      (d) => d.code === 'gpu.legacy_compute_comment_position',
    );
    expect(warn).toBeDefined();
  });

  it('repeatUntil / repeatWhile / forever anchors are skipped with the same warning', () => {
    const project = mkProject(
      [mkBlock('a', 'control_repeat_until', { inputs: { SUBSTACK: 'a' } })],
      [{ id: 'cmt1', text: '@compute\n', blockId: 'a' }],
    );
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(0);
    expect(
      diagnostics.some((d) => d.code === 'gpu.legacy_compute_comment_position'),
    ).toBe(true);
  });

  it('warns once per anchor when the same block carries duplicate markers', () => {
    const r = mkBlock('r', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([r, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'r' },
      { id: 'cmt2', text: '@compute\n', blockId: 'r' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(1);
    const legacy = diagnostics.filter(
      (d) => d.code === 'gpu.legacy_compute_comment_position',
    );
    expect(legacy).toHaveLength(0);
    const dup = diagnostics.filter(
      (d) => d.code === 'gpu.multiple_compute_regions',
    );
    expect(dup).toHaveLength(1);
  });

  it('two sibling Form A markers become two independent regions', () => {
    const a = mkBlock('a', 'data_setvariableto');
    const b = mkBlock('b', 'data_setvariableto');
    const r1 = mkBlock('r1', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const r2 = mkBlock('r2', 'control_repeat', { inputs: { SUBSTACK: 'b' } });
    const project = mkProject([r1, r2, a, b], [
      { id: 'cmt1', text: '@compute\n', blockId: 'r1' },
      { id: 'cmt2', text: '@compute\n', blockId: 'r2' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(regions).toHaveLength(2);
    expect(regions[0]?.kernelContainerBlockId).toBe('r1');
    expect(regions[1]?.kernelContainerBlockId).toBe('r2');
  });

  describe('repeatPathTable', () => {
    it('builds sibling + descendant paths from SUBSTACK next chains', () => {
      // Layout inside `r`'s body:
      //   r (SUBSTACK → inner)  ← @compute marker
      //     inner (SUBSTACK → a, next → sibling)  ← inner.next points at sibling
      //       a (data_setvariableto)
      //     sibling (SUBSTACK → b)  ← direct sibling of inner inside r
      //       b (data_setvariableto)
      const a = mkBlock('a', 'data_setvariableto');
      const inner = mkBlock('inner', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
        parent: 'r',
        next: 'sibling',
      });
      const sibling = mkBlock('sibling', 'control_repeat', {
        inputs: { SUBSTACK: 'b' },
        parent: 'r',
      });
      const b = mkBlock('b', 'data_setvariableto', { parent: 'sibling' });
      const r = mkBlock('r', 'control_repeat', {
        inputs: { SUBSTACK: 'inner' },
      });
      const project = mkProject([r, inner, a, sibling, b], [
        { id: 'cmt1', text: '@compute\n', blockId: 'r' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const table = regions[0]?.repeatPathTable ?? {};
      expect(table['self']).toBe('r');
      expect(table['0']).toBe('inner');
      // sibling is a direct child of `r` (= sibling of `inner` inside
      // r's substack). The non-repeat block `a` does not shift the
      // index.
      expect(table['1']).toBe('sibling');
      expect(table['2']).toBeUndefined();
    });

    it('non-repeat sibling insertions do not shift the path table', () => {
      const a = mkBlock('a', 'data_setvariableto');
      const b = mkBlock('b', 'data_setvariableto');
      const inner = mkBlock('inner', 'control_repeat', {
        inputs: { SUBSTACK: 'b' },
        parent: 'r',
      });
      const r = mkBlock('r', 'control_repeat', {
        inputs: { SUBSTACK: 'inner' },
      });
      const project = mkProject([r, inner, a, b], [
        { id: 'cmt1', text: '@compute\n', blockId: 'r' },
      ]);
      const { regions } = extractRegions(project);
      expect(regions[0]?.repeatPathTable['0']).toBe('inner');
      expect(regions[0]?.repeatPathTable['1']).toBeUndefined();
    });
  });
});
