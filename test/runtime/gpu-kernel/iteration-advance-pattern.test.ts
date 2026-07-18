import { describe, expect, it } from 'vitest';
import {
  collectIterationAdvancePatterns,
  extractNumericLiteral,
  extractVariableName,
} from '@/runtime/gpu-kernel/iteration-advance-pattern';
import type {
  BindDirective,
  ParsedDirective,
  RawBlock,
  RepeatDirective,
} from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...opts };
}

function bind(name: string): BindDirective {
  return { kind: 'bind', name, slot: 0, readOnly: true, dtype: 'f32', line: 0, column: 0 };
}

function repeat(name: string, formula: string, blockId = 'r0'): RepeatDirective {
  return { kind: 'repeat', name, axis: 'sequential', formula, blockId, line: 0, column: 0 };
}

function changeVarBy(id: string, varName: string, delta: number): RawBlock {
  return block(id, 'data_changevariableby', {
    inputs: { VALUE: [10, ['math_number', String(delta)]] },
    fields: { VARIABLE: ['VARIABLE', varName] },
  });
}

describe('collectIterationAdvancePatterns', () => {
  it('auto-detects data_changevariableby for bound var', () => {
    const blocks: Record<string, RawBlock> = {
      b1: changeVarBy('b1', 'idx1', 1),
    };
    const directives: ParsedDirective[] = [bind('idx1')];
    const result = collectIterationAdvancePatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]).toMatchObject({
      kind: 'iteration-advance',
      varName: 'idx1',
      delta: 1,
      blockId: 'b1',
      source: 'auto-detected',
    });
  });

  it('auto-detects with negative delta', () => {
    const blocks: Record<string, RawBlock> = {
      b1: changeVarBy('b1', 'idx1', -1),
    };
    const directives: ParsedDirective[] = [bind('idx1')];
    const result = collectIterationAdvancePatterns(blocks, ['b1'], directives);
    expect(result.patterns[0]?.delta).toBe(-1);
  });

  it('auto-detects with delta from math_integer opcode', () => {
    const blocks: Record<string, RawBlock> = {
      b1: block('b1', 'data_changevariableby', {
        inputs: { VALUE: [10, ['math_integer', '7']] },
        fields: { VARIABLE: ['VARIABLE', 'idx1'] },
      }),
    };
    const directives: ParsedDirective[] = [bind('idx1')];
    const result = collectIterationAdvancePatterns(blocks, ['b1'], directives);
    expect(result.patterns[0]?.delta).toBe(7);
  });

  it('ignores non-bound var', () => {
    const blocks: Record<string, RawBlock> = {
      b1: changeVarBy('b1', 'unbound_var', 1),
    };
    const directives: ParsedDirective[] = [bind('idx1')];
    const result = collectIterationAdvancePatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(0);
  });

  it('ignores non-data_changevariableby blocks', () => {
    const blocks: Record<string, RawBlock> = {
      b1: block('b1', 'data_setvariableto', {
        inputs: { VALUE: [10, ['math_number', '0']] },
        fields: { VARIABLE: ['VARIABLE', 'idx1'] },
      }),
    };
    const directives: ParsedDirective[] = [bind('idx1')];
    const result = collectIterationAdvancePatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(0);
  });

  it('marks explicit when boundBlockId matches', () => {
    const blocks: Record<string, RawBlock> = {
      b1: changeVarBy('b1', 'Rx', 1),
    };
    const directives: ParsedDirective[] = [
      repeat('Rx', 'formula', 'r0'),
      { kind: 'repeat', name: 'Rx', axis: 'global_x', formula: 'formula', blockId: 'r0', boundBlockId: 'b1', line: 0, column: 0 },
    ];
    const result = collectIterationAdvancePatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]?.source).toBe('explicit');
    expect(result.patterns[0]?.directive).toMatchObject({
      kind: 'repeat',
      name: 'Rx',
    });
  });

  it('extractNumericLiteral handles non-numeric shadow', () => {
    expect(extractNumericLiteral(['VAR', 'x'])).toBeNull();
    expect(extractNumericLiteral(null)).toBeNull();
    expect(extractNumericLiteral([10, ['operator_add', '5']])).toBeNull();
    expect(extractNumericLiteral([10, ['math_number', 'NaN']])).toBeNull();
  });

  it('extractVariableName handles {name: "x"} shape', () => {
    expect(extractVariableName({ name: 'x' })).toBe('x');
    expect(extractVariableName(['VARIABLE', 'y'])).toBe('y');
    expect(extractVariableName({})).toBeNull();
    expect(extractVariableName(null)).toBeNull();
    expect(extractVariableName(42)).toBeNull();
  });

  it('binds via @repeat directive (axis var) too', () => {
    const blocks: Record<string, RawBlock> = {
      b1: changeVarBy('b1', 'Rx', 1),
    };
    const directives: ParsedDirective[] = [repeat('Rx', 'formula', 'r0')];
    const result = collectIterationAdvancePatterns(blocks, ['b1'], directives);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]?.varName).toBe('Rx');
  });

  it('returns no patterns when bodyBlockIds is empty', () => {
    const blocks: Record<string, RawBlock> = {
      b1: changeVarBy('b1', 'idx1', 1),
    };
    const directives: ParsedDirective[] = [bind('idx1')];
    const result = collectIterationAdvancePatterns(blocks, [], directives);
    expect(result.patterns).toHaveLength(0);
  });

  it('returns no patterns when block is missing', () => {
    const directives: ParsedDirective[] = [bind('idx1')];
    const result = collectIterationAdvancePatterns({}, ['nonexistent'], directives);
    expect(result.patterns).toHaveLength(0);
  });
});
