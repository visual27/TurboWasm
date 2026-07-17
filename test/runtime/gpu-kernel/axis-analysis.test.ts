import { describe, expect, it } from 'vitest';
import { analyzeAxes } from '@/runtime/gpu-kernel/axis-analysis';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import type { ExtractedRegion, ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...opts };
}

function parse(text: string) {
  return parseComputeComment({ blockId: 'a', text }, 'r0');
}

describe('axis-analysis (D2)', () => {
  it('keeps the requested axis when @map + formula + body are all clean', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const bodyBlocks: RawBlock[] = [block('a', 'data_itemoflist')];
    const result = analyzeAxes(skeletonRegion(), directives, project(bodyBlocks));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
    expect(result.axes['R0']?.demoteReason).toBeUndefined();
  });

  it('demotes (D2) when @map is missing for the @repeat axis', () => {
    const directives = parse('@repeat R0:global_x = N\n').directives;
    const result = analyzeAxes(skeletonRegion(), directives, project([block('a', 'data_itemoflist')]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
    expect(result.axes['R0']?.demoteReason).toBe('d2');
  });

  it('demotes (D2) when the formula does not reference the index var', () => {
    const directives = parse('@repeat R0:global_x = aabb_width\n@map R0 <- 0\n').directives;
    const result = analyzeAxes(skeletonRegion(), directives, project([block('a', 'data_itemoflist')]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
    expect(result.axes['R0']?.demoteReason).toBe('d2');
  });

  it('demotes (D2) when the body writes to the index var', () => {
    const directives = parse('@repeat R0:global_x = N\n@map R0 <- 0\n').directives;
    const bodyBlocks = [
      block('write', 'data_setvariableto', {
        fields: { VARIABLE: { id: 'R0', name: 'R0' } },
      }),
    ];
    const result = analyzeAxes(skeletonRegion(), directives, project(bodyBlocks));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
  });

  it('always uses sequential axis when declared sequential', () => {
    const directives = parse('@repeat R0:sequential = N\n@map R0 <- 0\n').directives;
    const result = analyzeAxes(skeletonRegion(), directives, project([block('a', 'data_itemoflist')]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
    expect(result.axes['R0']?.demoteReason).toBeUndefined();
  });
});

function skeletonRegion(): ExtractedRegion {
  return {
    regionId: 'r0',
    blockId: 'r0',
    spriteId: 's1',
    commentId: 'c1',
    firstSubstackBlockId: 'a',
    bodyBlockIds: ['a'],
  };
}

function project(blocks: RawBlock[]): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  return {
    targets: [{ id: 's1', isStage: false, blocks: blockMap }],
    comments: {},
  };
}
