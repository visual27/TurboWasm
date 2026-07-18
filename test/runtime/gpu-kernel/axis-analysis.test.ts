import { describe, expect, it } from 'vitest';
import { analyzeAxes } from '@/runtime/gpu-kernel/axis-analysis';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import type { ExtractedRegion, ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  // Allow `inputs` opts whose value is a BlockShadowArray (e.g.
  // `[1, [10, '0']]`); the analyzer recurses into array-valued inputs.
  const sanitized: Partial<RawBlock> = { ...opts };
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...sanitized };
}

function parse(text: string) {
  return parseComputeComment({ blockId: 'a', text }, 'r0');
}

function region(bodyIds: string[]): ExtractedRegion {
  return {
    regionId: 'r0',
    blockId: 'r0',
    spriteId: 's1',
    commentId: 'c1',
    firstSubstackBlockId: bodyIds[0] ?? 'a',
    bodyBlockIds: bodyIds,
    kernelContainerBlockId: 'r0',
    nestedRepeatContainerBlockIds: [],
    duplicateComputeBlockIds: [],
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

describe('axis-analysis (D2)', () => {
  it('keeps the requested axis when @map + formula + body are all clean', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const bodyBlocks: RawBlock[] = [block('a', 'data_itemoflist')];
    const result = analyzeAxes(region(['a']), directives, project(bodyBlocks));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
    expect(result.axes['R0']?.demoteReason).toBeUndefined();
    expect(result.axes['R0']?.diagnostics).toEqual([]);
  });

  it('demotes (D2) when @map is missing for the @repeat axis', () => {
    const directives = parse('@repeat R0:global_x = N\n').directives;
    const result = analyzeAxes(region(['a']), directives, project([block('a', 'data_itemoflist')]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
    expect(result.axes['R0']?.demoteReason).toBe('d2');
    expect(result.axes['R0']?.diagnostics[0]?.code).toBe('d2.axis_demoted');
  });

  it('demotes (D2) when the formula does not reference the index var', () => {
    const directives = parse('@repeat R0:global_x = aabb_width\n@map R0 <- 0\n').directives;
    const result = analyzeAxes(region(['a']), directives, project([block('a', 'data_itemoflist')]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
    expect(result.axes['R0']?.demoteReason).toBe('d2');
    expect(result.axes['R0']?.diagnostics.some((d) => d.code === 'd2.axis_demoted')).toBe(true);
  });

  it('demotes (D2) when the body writes to the index var', () => {
    const directives = parse('@repeat R0:global_x = N\n@map R0 <- 0\n').directives;
    const write = block('a', 'data_setvariableto', {
      fields: { VARIABLE: { id: 'R0', name: 'R0' } },
    });
    const result = analyzeAxes(region(['a']), directives, project([write]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
  });

  it('demotes (D2) when data_changevariableby writes to the index var', () => {
    const directives = parse('@repeat R0:global_x = N\n@map R0 <- 0\n').directives;
    const write = block('a', 'data_changevariableby', {
      fields: { VARIABLE: { id: 'R0', name: 'R0' } },
    });
    const result = analyzeAxes(region(['a']), directives, project([write]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
    expect(result.axes['R0']?.demoteReason).toBe('d2');
  });

  it('keeps the axis when the body writes to a different variable than Ri', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const write = block('a', 'data_setvariableto', {
      fields: { VARIABLE: { id: 'tmp0', name: 'tmp0' } },
    });
    const result = analyzeAxes(region(['a']), directives, project([write]));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
  });

  it('always uses sequential axis when declared sequential', () => {
    const directives = parse('@repeat R0:sequential = N\n@map R0 <- 0\n').directives;
    const result = analyzeAxes(region(['a']), directives, project([block('a', 'data_itemoflist')]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
    expect(result.axes['R0']?.demoteReason).toBeUndefined();
    expect(result.axes['R0']?.diagnostics).toEqual([]);
  });

  // #1: safe cross-iteration
  it('keeps the axis for `Ri + 0` (zero literal partner)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0 = block('r0', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const op = block('a', 'operator_add', {
      inputs: {
        NUM1: r0,
        NUM2: [1, [10, '0']] as unknown as RawBlock,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0]));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
  });

  it('keeps the axis for `Ri - 0` (zero literal partner)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0 = block('r0', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const op = block('a', 'operator_subtract', {
      inputs: {
        NUM1: [1, [10, '0']] as unknown as RawBlock,
        NUM2: r0,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0]));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
  });

  it('demotes (D2) for `Ri + 1` (non-zero literal partner)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0 = block('r0', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const op = block('a', 'operator_add', {
      inputs: {
        NUM1: r0,
        NUM2: [1, [10, '1']] as unknown as RawBlock,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
  });

  it('demotes (D2) for `Ri + RiOther` (dynamic partner)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0 = block('r0', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const r1 = block('r1', 'data_variable', { fields: { VARIABLE: { id: 'R1', name: 'R1' } } });
    const op = block('a', 'operator_add', {
      inputs: {
        NUM1: r0,
        NUM2: r1,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0, r1]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
  });

  // B-1: safe `Ri + Ri` (both slots reference the same index var).
  it('keeps the axis for `Ri + Ri` (same-index partner, no cross-iteration)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0a = block('r0a', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const r0b = block('r0b', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const op = block('a', 'operator_add', {
      inputs: {
        NUM1: r0a,
        NUM2: r0b,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0a, r0b]));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
  });

  it('keeps the axis for `Ri - Ri` (same-index partner, subtract)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0a = block('r0a', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const r0b = block('r0b', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const op = block('a', 'operator_subtract', {
      inputs: {
        NUM1: r0a,
        NUM2: r0b,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0a, r0b]));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
  });

  it('keeps the axis for `0 + Ri` (zero literal in NUM1, partner is Ri)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0 = block('r0', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const op = block('a', 'operator_add', {
      inputs: {
        NUM1: [1, [10, '0']] as unknown as RawBlock,
        NUM2: r0,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0]));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
  });

  it('keeps the axis for `Ri + 0.0` (zero literal as a float shadow)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0 = block('r0', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const op = block('a', 'operator_add', {
      inputs: {
        NUM1: r0,
        // shadow-encoded `[2, [10, "0.0"]]` style is also a math_number zero.
        NUM2: [2, [10, '0.0']] as unknown as RawBlock,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0]));
    expect(result.axes['R0']?.finalAxis).toBe('global_x');
  });

  it('demotes (D2) for `Ri + [1, "abc"]` (string literal shadow — not zero)', () => {
    const directives = parse('@repeat R0:global_x = R0 + 1\n@map R0 <- 0\n').directives;
    const r0 = block('r0', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } });
    const op = block('a', 'operator_add', {
      inputs: {
        NUM1: r0,
        // `[1, "abc"]` — not a math_number shadow. Conservatively reject.
        NUM2: [1, 'abc'] as unknown as RawBlock,
      },
    });
    const result = analyzeAxes(region(['a']), directives, project([op, r0]));
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
  });

  // #4: CONDITION walk
  it('collects CONDITION blocks of control_if for D2 analysis', () => {
    const directives = parse('@repeat R0:global_x = N\n@map R0 <- 0\n').directives;
    const condOp = block('condOp', 'operator_add', {
      inputs: {
        NUM1: block('r0', 'data_variable', { fields: { VARIABLE: { id: 'R0', name: 'R0' } } }),
        NUM2: [1, [10, '5']],
      },
    });
    const ifBlock = block('if', 'control_if', {
      inputs: {
        CONDITION: { id: 'condOp' },
        SUBSTACK: 'body',
      },
    });
    const body = block('body', 'data_itemoflist');
    const proj: ParsedProject = {
      targets: [
        {
          id: 's1',
          isStage: false,
          blocks: {
            if: ifBlock,
            condOp,
            r0: condOp.inputs['NUM1'] as RawBlock,
            body,
          },
        },
      ],
      comments: {},
    };
    const regionWithCondition: ExtractedRegion = {
      regionId: 'r0',
      blockId: 'if',
      spriteId: 's1',
      commentId: 'c1',
      firstSubstackBlockId: 'if',
      bodyBlockIds: ['if'],
      kernelContainerBlockId: 'if',
      nestedRepeatContainerBlockIds: [],
      duplicateComputeBlockIds: [],
    };
    const result = analyzeAxes(regionWithCondition, directives, proj);
    expect(result.axes['R0']?.finalAxis).toBe('sequential');
  });
});
