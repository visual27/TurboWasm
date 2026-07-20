import { describe, expect, it } from 'vitest';
import {
  buildBlockSubsetVerdict,
  classifyBlockSubset,
} from '@/runtime/gpu-kernel/block-subset';
import type {
  BindDirective,
  ExtractedRegion,
  ParsedComment,
  ParsedDirective,
  ParsedProject,
  RawBlock,
} from '@/runtime/gpu-kernel/types';

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
    kernelContainerBlockId: 'r0',
    nestedRepeatContainerBlockIds: [],
    duplicateComputeBlockIds: [],
    regionIndex: 0,
    inlinedPrototypeBlockIds: [],
    commentAnchorBlockId: body[0]?.id ?? '',
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

function changeVarBy(id: string, varName: string, delta: number): RawBlock {
  return block(id, 'data_changevariableby', {
    inputs: { VALUE: [10, ['math_number', String(delta)]] },
    fields: { VARIABLE: ['VARIABLE', varName] },
  });
}

function rwBind(name: string, slot = 0): BindDirective {
  return { kind: 'bind', name, slot, readOnly: false, dtype: 'f32', line: 0, column: 0 };
}

function itemOfList(id: string, listName: string, indexVar: string): RawBlock {
  return block(id, 'data_itemoflist', {
    inputs: { INDEX: ['INDEX', indexVar] },
    fields: { LIST: ['LIST', listName] },
  });
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

  it('classifyBlockSubset (legacy API) returns effectivePatterns: []', () => {
    const body = [block('a', 'data_setvariableto')];
    const verdict = subset(region(body), project(body, []));
    expect(verdict.effectivePatterns).toEqual([]);
  });
});

describe('buildBlockSubsetVerdict (Phase 1)', () => {
  it('effectivePatterns populated for valid region with iteration advance', () => {
    const body = [
      block('a', 'data_setvariableto', {
        inputs: { VALUE: [10, ['math_number', '0']] },
        fields: { VARIABLE: ['VARIABLE', 'idx1'] },
      }),
      changeVarBy('b', 'idx1', 1),
    ];
    const directives: ParsedDirective[] = [rwBind('idx1', 0)];
    const r = region(body);
    const p = project(body, []);
    const verdict = buildBlockSubsetVerdict({
      region: r,
      project: p,
      comments: p.comments,
      parsedDirectives: directives,
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.effectivePatterns).toHaveLength(1);
    expect(verdict.effectivePatterns?.[0]).toMatchObject({
      kind: 'iteration-advance',
      pattern: { varName: 'idx1', delta: 1, source: 'auto-detected' },
    });
  });

  it('effectivePatterns populated for valid region with indirect access (read)', () => {
    const body = [itemOfList('b1', 'buff_r', 'idx1')];
    const directives: ParsedDirective[] = [rwBind('buff_r', 0)];
    const r = region(body);
    const p = project(body, []);
    const verdict = buildBlockSubsetVerdict({
      region: r,
      project: p,
      comments: p.comments,
      parsedDirectives: directives,
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.effectivePatterns).toHaveLength(1);
    expect(verdict.effectivePatterns?.[0]).toMatchObject({
      kind: 'indirect-access',
      pattern: { scratchListName: 'buff_r', access: 'read', source: 'auto-detected' },
    });
  });

  it('effectivePatterns empty for D1-demoted region', () => {
    const body = [block('a', 'operator_random')];
    const directives: ParsedDirective[] = [rwBind('idx1', 0)];
    const r = region(body);
    const p = project(body, []);
    const verdict = buildBlockSubsetVerdict({
      region: r,
      project: p,
      comments: p.comments,
      parsedDirectives: directives,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.effectivePatterns).toEqual([]);
  });

  it('emits gpu.bound_block_not_found when boundBlockId is missing from body', () => {
    const body = [block('a', 'data_setvariableto')];
    const directives: ParsedDirective[] = [
      {
        kind: 'repeat',
        name: 'Rx',
        axis: 'global_x',
        formula: 'formula',
        blockId: 'r0',
        boundBlockId: 'nonexistent',
        line: 0,
        column: 0,
      },
    ];
    const r = region(body);
    const p = project(body, []);
    const verdict = buildBlockSubsetVerdict({
      region: r,
      project: p,
      comments: p.comments,
      parsedDirectives: directives,
    });
    const diag = verdict.diagnostics.find((d) => d.code === 'gpu.bound_block_not_found');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warn');
  });
});
