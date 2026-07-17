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
});
