import { describe, expect, it } from 'vitest';
import { classifyBlockSubset } from '@/runtime/gpu-kernel/block-subset';
import type { ExtractedRegion, ParsedComment, ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...opts };
}

function region(body: RawBlock[]): ExtractedRegion {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of body) blockMap[b.id] = b;
  return {
    regionId: 'region:sprite1:r0',
    blockId: 'r0',
    spriteId: 'sprite1',
    commentId: 'cmt1',
    firstSubstackBlockId: body[0]?.id ?? '',
    bodyBlockIds: body.map((b) => b.id),
  };
}

function project(blocks: RawBlock[], comments: { id: string; text: string; blockId: string }[]): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  const commentsMap: Record<string, ParsedComment> = {};
  for (const c of comments) commentsMap[c.id] = { text: c.text, blockId: c.blockId };
  return {
    targets: [{ id: 'sprite1', isStage: false, blocks: blockMap }],
    comments: commentsMap,
  };
}

function subset(r: ExtractedRegion, p: ParsedProject) {
  return classifyBlockSubset({ region: r, project: p, comments: p.comments });
}

describe('block-subset (D1)', () => {
  it('passes when body uses only safe opcodes', () => {
    const body = [
      block('a', 'data_setvariableto'),
      block('b', 'operator_add'),
      block('c', 'data_itemoflist'),
    ];
    const verdict = subset(region(body), project(body, []));
    expect(verdict.valid).toBe(true);
    expect(verdict.demoteReason).toBeUndefined();
  });

  it('demotes (D1) when control_repeat_until appears in the body', () => {
    const body = [
      block('a', 'data_setvariableto', { inputs: { SUBSTACK: 'b' } }),
      block('b', 'control_repeat_until'),
    ];
    const verdict = subset(region(body), project(body, []));
    expect(verdict.valid).toBe(false);
    expect(verdict.demoteReason).toBe('d1');
    expect(verdict.diagnostics[0]?.code).toBe('d1.region_demoted');
  });

  it('demotes (D1) when a nested @compute is reachable inside the body', () => {
    const a = block('a', 'control_repeat', { inputs: { SUBSTACK: 'b' } });
    const b = block('b', 'operator_add');
    const verdict = subset(
      region([a, b]),
      project([a, b], [{ id: 'inner', text: '@compute\n', blockId: 'b' }]),
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.demoteReason).toBe('d1');
  });

  it('demotes (D1) when operator_random is in the body', () => {
    const a = block('a', 'operator_random');
    const verdict = subset(region([a]), project([a], []));
    expect(verdict.valid).toBe(false);
    expect(verdict.demoteReason).toBe('d1');
  });

  it('demotes (D1) when data_addtolist is in the body', () => {
    const a = block('a', 'data_addtolist');
    const verdict = subset(region([a]), project([a], []));
    expect(verdict.valid).toBe(false);
    expect(verdict.demoteReason).toBe('d1');
  });
});
