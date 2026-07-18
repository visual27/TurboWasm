import { describe, expect, it } from 'vitest';
import { collectIndirectAccessPatterns } from '@/runtime/gpu-kernel/indirect-access-pattern';
import type {
  BindDirective,
  MapDirective,
  ParsedDirective,
  RawBlock,
} from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...opts };
}

function rwBind(name: string, slot = 0): BindDirective {
  return { kind: 'bind', name, slot, readOnly: false, dtype: 'f32', line: 0, column: 0 };
}

function mapDirective(varName: string, boundBlockId?: string): MapDirective {
  return {
    kind: 'map',
    var: varName,
    formula: 'R0',
    blockId: 'r0',
    ...(boundBlockId ? { boundBlockId } : {}),
    line: 0,
    column: 0,
  };
}

function itemOfList(id: string, listName: string, indexVar: string): RawBlock {
  return block(id, 'data_itemoflist', {
    inputs: { INDEX: ['INDEX', indexVar] },
    fields: { LIST: ['LIST', listName] },
  });
}

function replaceItemOfList(id: string, listName: string, indexVar: string): RawBlock {
  return block(id, 'data_replaceitemoflist', {
    inputs: {
      INDEX: ['INDEX', indexVar],
      ITEM: [10, ['math_number', '0']],
    },
    fields: { LIST: ['LIST', listName] },
  });
}

describe('collectIndirectAccessPatterns', () => {
  it('auto-detects data_itemoflist for bound list (read)', () => {
    const blocks: Record<string, RawBlock> = {
      b1: itemOfList('b1', 'buff_r', 'idx1'),
    };
    const directives: ParsedDirective[] = [rwBind('buff_r')];
    const result = collectIndirectAccessPatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]).toMatchObject({
      kind: 'indirect-access',
      scratchListName: 'buff_r',
      indexExpr: 'idx1',
      opcode: 'data_itemoflist',
      blockId: 'b1',
      access: 'read',
      source: 'auto-detected',
    });
  });

  it('does NOT auto-detect data_replaceitemoflist (write) — actual parallel work', () => {
    const blocks: Record<string, RawBlock> = {
      b1: replaceItemOfList('b1', 'buff_r', 'idx1'),
    };
    const directives: ParsedDirective[] = [rwBind('buff_r')];
    const result = collectIndirectAccessPatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(0);
  });

  it('invariant: all returned patterns have access="read"', () => {
    const blocks: Record<string, RawBlock> = {
      b1: itemOfList('b1', 'buff_r', 'idx1'),
      b2: itemOfList('b2', 'buff_g', 'idx1'),
      b3: replaceItemOfList('b3', 'buff_b', 'idx1'),
    };
    const directives: ParsedDirective[] = [rwBind('buff_r', 0), rwBind('buff_g', 1), rwBind('buff_b', 2)];
    const result = collectIndirectAccessPatterns(blocks, ['b1', 'b2', 'b3'], directives);
    expect(result.patterns.every((p) => p.access === 'read')).toBe(true);
    expect(result.patterns.every((p) => p.opcode === 'data_itemoflist')).toBe(true);
  });

  it('ignores unbound list', () => {
    const blocks: Record<string, RawBlock> = {
      b1: itemOfList('b1', 'unbound', 'idx1'),
    };
    const directives: ParsedDirective[] = [rwBind('buff_r')];
    const result = collectIndirectAccessPatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(0);
  });

  it('ignores complex index expression', () => {
    const blocks: Record<string, RawBlock> = {
      b1: block('b1', 'data_itemoflist', {
        inputs: { INDEX: [10, ['operator_add', '5', '7']] },
        fields: { LIST: ['LIST', 'buff_r'] },
      }),
    };
    const directives: ParsedDirective[] = [rwBind('buff_r')];
    const result = collectIndirectAccessPatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(0);
  });

  it('marks explicit when boundBlockId matches (read)', () => {
    const blocks: Record<string, RawBlock> = {
      b1: itemOfList('b1', 'buff_r', 'idx1'),
    };
    const directives: ParsedDirective[] = [rwBind('buff_r'), mapDirective('idx1', 'b1')];
    const result = collectIndirectAccessPatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]?.source).toBe('explicit');
    expect(result.patterns[0]?.directive).toMatchObject({ kind: 'map', name: 'idx1' });
  });

  it('explicit boundBlockId on data_replaceitemoflist is ignored', () => {
    const blocks: Record<string, RawBlock> = {
      b1: replaceItemOfList('b1', 'buff_r', 'idx1'),
    };
    const directives: ParsedDirective[] = [rwBind('buff_r'), mapDirective('idx1', 'b1')];
    const result = collectIndirectAccessPatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(0);
  });

  it('returns no patterns when body is empty', () => {
    const directives: ParsedDirective[] = [rwBind('buff_r')];
    const result = collectIndirectAccessPatterns({}, [], directives);
    expect(result.patterns).toHaveLength(0);
  });

  it('handles { name: "x" } field shape for both LIST and INDEX', () => {
    const blocks: Record<string, RawBlock> = {
      b1: block('b1', 'data_itemoflist', {
        inputs: { INDEX: { name: 'idx1' } },
        fields: { LIST: { name: 'buff_r' } },
      }),
    };
    const directives: ParsedDirective[] = [rwBind('buff_r')];
    const result = collectIndirectAccessPatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]?.scratchListName).toBe('buff_r');
    expect(result.patterns[0]?.indexExpr).toBe('idx1');
  });
});
