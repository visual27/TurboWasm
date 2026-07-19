import { describe, expect, it } from 'vitest';
import {
  buildScratchBlockExprContext,
  scratchBlockToWgslExpr,
} from '@/runtime/gpu-kernel/scratch-block-expr';
import type { ParsedDirective, RawBlock } from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, options: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...options };
}

function mathNumber(id: string, value: number): RawBlock {
  return block(id, 'math_number', { fields: { NUM: [String(value), null] } });
}

function mathInteger(id: string, value: number): RawBlock {
  return block(id, 'math_integer', { fields: { NUM: [String(value), null] } });
}

function binaryOp(id: string, opcode: string, leftId: string, rightId: string): RawBlock {
  return block(id, opcode, {
    inputs: { NUM1: [2, leftId], NUM2: [2, rightId] },
  });
}

function negative(id: string, innerId: string): RawBlock {
  return block(id, 'math_negativenumber', { inputs: { NUM: [2, innerId] } });
}

function variableOf(id: string, name: string): RawBlock {
  return block(id, 'data_variableof', { fields: { VARIABLE: [name, null] } });
}

function itemOfList(id: string, listName: string, indexBlockId: string): RawBlock {
  return block(id, 'data_itemoflist', {
    inputs: {
      LIST: { name: listName },
      INDEX: [2, indexBlockId],
    },
    fields: { LIST: [listName, null] },
  });
}

const EMPTY_CONTEXT = buildScratchBlockExprContext([], {});

describe('scratchBlockToWgslExpr', () => {
  it('math_number → literal', () => {
    const b = mathNumber('n1', 42);
    expect(scratchBlockToWgslExpr(b, { n1: b }, EMPTY_CONTEXT)).toBe('42');
  });

  it('math_integer → literal', () => {
    const b = mathInteger('i1', 100);
    expect(scratchBlockToWgslExpr(b, { i1: b }, EMPTY_CONTEXT)).toBe('100');
  });

  it('math_negativenumber → -(inner)', () => {
    const inner = mathNumber('inner', 5);
    const neg = negative('neg', 'inner');
    const blocks = { neg, inner };
    expect(scratchBlockToWgslExpr(neg, blocks, EMPTY_CONTEXT)).toBe('-(5)');
  });

  it('operator_add → (a + b)', () => {
    const l = mathNumber('l', 3);
    const r = mathNumber('r', 4);
    const add = binaryOp('add', 'operator_add', 'l', 'r');
    const blocks = { add, l, r };
    expect(scratchBlockToWgslExpr(add, blocks, EMPTY_CONTEXT)).toBe('(3 + 4)');
  });

  it('operator_subtract → (a - b)', () => {
    const l = mathNumber('l', 10);
    const r = mathNumber('r', 3);
    const sub = binaryOp('sub', 'operator_subtract', 'l', 'r');
    const blocks = { sub, l, r };
    expect(scratchBlockToWgslExpr(sub, blocks, EMPTY_CONTEXT)).toBe('(10 - 3)');
  });

  it('operator_multiply → (a * b)', () => {
    const l = mathNumber('l', 6);
    const r = mathNumber('r', 7);
    const mul = binaryOp('mul', 'operator_multiply', 'l', 'r');
    const blocks = { mul, l, r };
    expect(scratchBlockToWgslExpr(mul, blocks, EMPTY_CONTEXT)).toBe('(6 * 7)');
  });

  it('operator_divide → scratch_div(a, b)', () => {
    const l = mathNumber('l', 10);
    const r = mathNumber('r', 2);
    const div = binaryOp('div', 'operator_divide', 'l', 'r');
    const blocks = { div, l, r };
    expect(scratchBlockToWgslExpr(div, blocks, EMPTY_CONTEXT)).toBe('scratch_div(10, 2)');
  });

  it('operator_mod → scratch_mod(a, b)', () => {
    const l = mathNumber('l', 10);
    const r = mathNumber('r', 3);
    const mod = binaryOp('mod', 'operator_mod', 'l', 'r');
    const blocks = { mod, l, r };
    expect(scratchBlockToWgslExpr(mod, blocks, EMPTY_CONTEXT)).toBe('scratch_mod(10, 3)');
  });

  it('nested arithmetic: (3 + 4) * 5', () => {
    const a = mathNumber('a', 3);
    const b = mathNumber('b', 4);
    const add = binaryOp('add', 'operator_add', 'a', 'b');
    const five = mathNumber('five', 5);
    const mul = binaryOp('mul', 'operator_multiply', 'add', 'five');
    const blocks = { add, mul, a, b, five };
    expect(scratchBlockToWgslExpr(mul, blocks, EMPTY_CONTEXT)).toBe('((3 + 4) * 5)');
  });

  it('data_variableof → null when scalarBindings empty and not a list binding', () => {
    // Phase 2 では scalarBindings 空のため data_variableof は常に null。
    // Phase 3 で `@bind ..., scalar` を導入したら通る。
    const v = variableOf('v', 'aabb_idx0');
    expect(scratchBlockToWgslExpr(v, { v }, EMPTY_CONTEXT)).toBeNull();
  });

  it('data_variableof → &storage when list binding exists', () => {
    const v = variableOf('v', 'aabb_h');
    const directives: ParsedDirective[] = [
      {
        kind: 'bind',
        name: 'aabb_h',
        slot: 0,
        readOnly: true,
        dtype: 'f32',
        line: 0,
        column: 0,
      },
    ];
    const context = buildScratchBlockExprContext(directives, {});
    expect(scratchBlockToWgslExpr(v, { v }, context)).toBe('&aabb_h');
  });

  it('data_variableof → u_scratch.<name> when scalarBindings has match (Phase 3 contract)', () => {
    const v = variableOf('v', 'aabb_idx0');
    const context = buildScratchBlockExprContext([], {}, [
      { name: 'aabb_idx0', wgslName: 'aabb_idx0', dtype: 'i32' },
    ]);
    expect(scratchBlockToWgslExpr(v, { v }, context)).toBe('u_scratch.aabb_idx0');
  });

  it('data_itemoflist → scratch_list_read_f32 with index expr', () => {
    const idx = mathNumber('idx', 5);
    const iol = itemOfList('iol', 'aabb_h', 'idx');
    const directives: ParsedDirective[] = [
      {
        kind: 'bind',
        name: 'aabb_h',
        slot: 0,
        readOnly: true,
        dtype: 'f32',
        line: 0,
        column: 0,
      },
    ];
    const context = buildScratchBlockExprContext(directives, {});
    const blocks = { iol, idx };
    expect(scratchBlockToWgslExpr(iol, blocks, context)).toBe(
      'scratch_list_read_f32(&aabb_h, scratch_index_clamp(5, u_scratch.aabb_h_length), u_scratch.aabb_h_length)',
    );
  });

  it('data_itemoflist → null when list not in bindings', () => {
    const idx = mathNumber('idx', 5);
    const iol = itemOfList('iol', 'unknown_list', 'idx');
    const blocks = { iol, idx };
    expect(scratchBlockToWgslExpr(iol, blocks, EMPTY_CONTEXT)).toBeNull();
  });

  it('unsupported opcode → null', () => {
    const unsupported = block('u', 'sensing_currentday');
    expect(scratchBlockToWgslExpr(unsupported, { u: unsupported }, EMPTY_CONTEXT)).toBeNull();
  });

  it('operator_random → null (random in axis formula unsupported)', () => {
    const r = block('r', 'operator_random');
    expect(scratchBlockToWgslExpr(r, { r }, EMPTY_CONTEXT)).toBeNull();
  });

  it('recursion depth > 32 → null (defensive guard)', () => {
    // Build a 50-deep chain of operator_add → operator_add → ...
    const blocks: Record<string, RawBlock> = {};
    blocks['l'] = mathNumber('l', 1);
    blocks['r'] = mathNumber('r', 1);
    let prev = binaryOp('op0', 'operator_add', 'l', 'r');
    blocks['op0'] = prev;
    for (let i = 1; i < 50; i += 1) {
      prev = binaryOp(`op${i}`, 'operator_add', 'op' + (i - 1), 'l');
      blocks[`op${i}`] = prev;
    }
    // Recursion should bail out and return null at depth > 32
    expect(scratchBlockToWgslExpr(prev, blocks, EMPTY_CONTEXT)).toBeNull();
  });

  it('binary op with missing input → null', () => {
    const add = block('add', 'operator_add', { inputs: { NUM1: [2, 'missing'] } });
    expect(scratchBlockToWgslExpr(add, {}, EMPTY_CONTEXT)).toBeNull();
  });

  it('math_positive_number → (literal)', () => {
    const p = block('p', 'math_positive_number', { fields: { NUM: [String(7), null] } });
    expect(scratchBlockToWgslExpr(p, { p }, EMPTY_CONTEXT)).toBe('(7)');
  });
});

describe('buildScratchBlockExprContext', () => {
  it('builds bindingNameBySurface from @bind directives', () => {
    const directives: ParsedDirective[] = [
      { kind: 'bind', name: 'aabb_h', slot: 0, readOnly: true, dtype: 'f32', line: 0, column: 0 },
      { kind: 'bind', name: 'buff_r', slot: 1, readOnly: false, dtype: 'f32', line: 0, column: 0 },
    ];
    const ctx = buildScratchBlockExprContext(directives, {});
    expect(ctx.bindingNameBySurface.get('aabb_h')).toBe('aabb_h');
    expect(ctx.bindingNameBySurface.get('buff_r')).toBe('buff_r');
    expect(ctx.scalarBindings).toEqual([]);
  });

  it('uses renameTable for quoted/internalName binding names', () => {
    const directives: ParsedDirective[] = [
      { kind: 'bind', name: 'my list', internalName: '__tw_deadbeef', slot: 0, readOnly: true, dtype: 'f32', line: 0, column: 0 },
    ];
    const ctx = buildScratchBlockExprContext(directives, { 'my list': '__tw_deadbeef' });
    expect(ctx.bindingNameBySurface.get('my list')).toBe('__tw_deadbeef');
  });

  it('passes scalarBindings through unchanged', () => {
    const scalars = [{ name: 'aabb_idx0', wgslName: 'aabb_idx0', dtype: 'i32' as const }];
    const ctx = buildScratchBlockExprContext([], {}, scalars);
    expect(ctx.scalarBindings).toBe(scalars);
  });
});
