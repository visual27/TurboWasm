import { describe, expect, it } from 'vitest';
import { axisToRepeatDirective, collectImplicitAxes } from '@/runtime/gpu-kernel/implicit-axis';
import { buildScratchBlockExprContext } from '@/runtime/gpu-kernel/scratch-block-expr';
import type { ParsedDirective, RawBlock, RepeatDirective } from '@/runtime/gpu-kernel/types';
import { GPU_DIAGNOSTIC_CODES } from '@/runtime/gpu-kernel/diagnostic-codes';

function block(id: string, opcode: string, options: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...options };
}

/**
 * Build a control_repeat with a TIMES shadow chain. `times` is the array of
 * blocks that the loop-count formula traverses (= operand tree).
 */
function repeatWithTimes(
  id: string,
  timesBlocks: RawBlock[],
  parent: string | null = null,
): RawBlock {
  const first = timesBlocks[0];
  if (!first) throw new Error('timesBlocks must be non-empty');
  const chain: Record<string, RawBlock> = {};
  for (const b of timesBlocks) chain[b.id] = b;
  // Wire parent/next for shadow chain (scratch shadow = opaque to emitter,
  // but block-id resolution needs to find them).
  for (let i = 0; i < timesBlocks.length - 1; i += 1) {
    const cur = timesBlocks[i];
    const nxt = timesBlocks[i + 1];
    if (cur && nxt) {
      cur.next = nxt.id;
      nxt.parent = cur.id;
    }
  }
  return block(id, 'control_repeat', {
    inputs: { TIMES: [2, first.id] },
    parent,
    ...(timesBlocks[0] ? {} : {}),
  });
}

function mathNumber(id: string, value: number): RawBlock {
  return block(id, 'math_number', { fields: { NUM: [String(value), null] } });
}

describe('collectImplicitAxes', () => {
  it('legacy layout (no nested repeats) returns empty axes', () => {
    const kernelContainer = block('k1', 'control_repeat');
    const blocks: Record<string, RawBlock> = { k1: kernelContainer };
    const directives: ParsedDirective[] = [
      {
        kind: 'repeat',
        name: 'R0',
        axis: 'global_x',
        formula: '64',
        blockId: 'R0-directive',
        line: 0,
        column: 0,
      },
    ];
    const context = buildScratchBlockExprContext(directives, {});
    const result = collectImplicitAxes({
      kernelContainerId: 'k1',
      nestedRepeatIds: [],
      blocks,
      context,
      regionId: 'region:legacy',
      directives,
    });
    expect(result.axes).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('nested layout emits Ry:global_y from kernel container TIMES', () => {
    const shadow1 = mathNumber('shadow1', 64);
    const shadow2 = mathNumber('shadow2', 100);
    const kernelContainer = repeatWithTimes('k1', [shadow1]);
    const candidate = repeatWithTimes('c1', [shadow2]);
    const blocks: Record<string, RawBlock> = {
      k1: kernelContainer,
      c1: candidate,
      shadow1,
      shadow2,
    };
    const directives: ParsedDirective[] = [];
    const context = buildScratchBlockExprContext(directives, {});
    const result = collectImplicitAxes({
      kernelContainerId: 'k1',
      nestedRepeatIds: ['c1'],
      blocks,
      context,
      regionId: 'region:nested',
      directives,
    });
    const ry = result.axes.find((a) => a.name === 'Ry');
    const rx0 = result.axes.find((a) => a.name === 'Rx0');
    expect(ry).toBeDefined();
    expect(ry?.axis).toBe('global_y');
    expect(ry?.formula).toBe('64');
    expect(ry?.source).toBe('kernel-container');
    expect(ry?.blockId).toBe('k1');
    expect(rx0).toBeDefined();
    expect(rx0?.axis).toBe('global_x');
    expect(rx0?.formula).toBe('100');
    expect(rx0?.source).toBe('nested-repeat');
    expect(rx0?.blockId).toBe('c1');
  });

  it('nested layout emits Rx0, Rx1, Rx2 for multiple nested repeats', () => {
    const k1 = repeatWithTimes('k1', [mathNumber('s-k', 10)]);
    const c1 = repeatWithTimes('c1', [mathNumber('s-c1', 20)]);
    const n1 = repeatWithTimes('n1', [mathNumber('s-n1', 30)]);
    const n2 = repeatWithTimes('n2', [mathNumber('s-n2', 40)]);
    const blocks: Record<string, RawBlock> = {
      k1,
      c1,
      n1,
      n2,
      's-k': mathNumber('s-k', 10),
      's-c1': mathNumber('s-c1', 20),
      's-n1': mathNumber('s-n1', 30),
      's-n2': mathNumber('s-n2', 40),
    };
    const context = buildScratchBlockExprContext([], {});
    const result = collectImplicitAxes({
      kernelContainerId: 'k1',
      nestedRepeatIds: ['c1', 'n1', 'n2'],
      blocks,
      context,
      regionId: 'region:nested-multi',
      directives: [],
    });
    expect(result.axes.map((a) => a.name)).toEqual(['Ry', 'Rx0', 'Rx1', 'Rx2']);
    expect(result.axes.map((a) => a.formula)).toEqual(['10', '20', '30', '40']);
  });

  it('explicit @repeat Ry drops implicit Ry (explicit precedence)', () => {
    const k1 = repeatWithTimes('k1', [mathNumber('s-k', 64)]);
    const c1 = repeatWithTimes('c1', [mathNumber('s-c1', 100)]);
    const blocks: Record<string, RawBlock> = {
      k1,
      c1,
      's-k': mathNumber('s-k', 64),
      's-c1': mathNumber('s-c1', 100),
    };
    const directives: ParsedDirective[] = [
      {
        kind: 'repeat',
        name: 'Ry',
        axis: 'global_y',
        formula: '64',
        blockId: 'ry-directive',
        line: 0,
        column: 0,
      },
    ];
    const context = buildScratchBlockExprContext(directives, {});
    const result = collectImplicitAxes({
      kernelContainerId: 'k1',
      nestedRepeatIds: ['c1'],
      blocks,
      context,
      regionId: 'region:explicit-ry',
      directives,
    });
    // Ry は explicit 優先で implicit なし、Rx0 のみ
    expect(result.axes.map((a) => a.name)).toEqual(['Rx0']);
    expect(result.axes.map((a) => a.formula)).toEqual(['100']);
  });

  it('unsupported loop count formula → diagnostic + axis with empty formula (D2 demote trigger)', () => {
    // Loop count が `sensing_daysSince2000` など未対応 opcode の場合。
    const unsupportedShadow = block('s-unsupported', 'sensing_daysSince2000', {
      fields: { CURRENTMENU: ['daysSince2000', null] },
    });
    const k1 = repeatWithTimes('k1', [unsupportedShadow]);
    const c1 = repeatWithTimes('c1', [mathNumber('s-c1', 100)]);
    const blocks: Record<string, RawBlock> = {
      k1,
      c1,
      's-unsupported': unsupportedShadow,
      's-c1': mathNumber('s-c1', 100),
    };
    const context = buildScratchBlockExprContext([], {});
    const result = collectImplicitAxes({
      kernelContainerId: 'k1',
      nestedRepeatIds: ['c1'],
      blocks,
      context,
      regionId: 'region:unsupported',
      directives: [],
    });
    const ry = result.axes.find((a) => a.name === 'Ry');
    expect(ry).toBeDefined();
    expect(ry?.formula).toBe(''); // empty → axis-analysis で sequential に降格
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe(GPU_DIAGNOSTIC_CODES.IMPLICIT_AXIS_UNSUPPORTED);
    expect(result.diagnostics[0]?.severity).toBe('warn');
    // Rx0 は正常
    const rx0 = result.axes.find((a) => a.name === 'Rx0');
    expect(rx0?.formula).toBe('100');
  });

  it('empty TIMES input on kernel container → axis demoted', () => {
    const k1 = block('k1', 'control_repeat', { inputs: {} });
    const c1 = repeatWithTimes('c1', [mathNumber('s-c1', 100)]);
    const blocks: Record<string, RawBlock> = {
      k1,
      c1,
      's-c1': mathNumber('s-c1', 100),
    };
    const context = buildScratchBlockExprContext([], {});
    const result = collectImplicitAxes({
      kernelContainerId: 'k1',
      nestedRepeatIds: ['c1'],
      blocks,
      context,
      regionId: 'region:no-times',
      directives: [],
    });
    const ry = result.axes.find((a) => a.name === 'Ry');
    expect(ry?.formula).toBe('');
    expect(result.diagnostics.some((d) => d.code === GPU_DIAGNOSTIC_CODES.IMPLICIT_AXIS_UNSUPPORTED)).toBe(true);
  });

  it('missing kernel container block → no Ry emitted (no crash)', () => {
    const c1 = repeatWithTimes('c1', [mathNumber('s-c1', 100)]);
    const blocks: Record<string, RawBlock> = {
      c1,
      's-c1': mathNumber('s-c1', 100),
    };
    const context = buildScratchBlockExprContext([], {});
    const result = collectImplicitAxes({
      kernelContainerId: 'non-existent',
      nestedRepeatIds: ['c1'],
      blocks,
      context,
      regionId: 'region:missing-kc',
      directives: [],
    });
    expect(result.axes.map((a) => a.name)).toEqual(['Rx0']);
  });

  it('data_itemoflist in loop count resolves to scratch_list_read_f32', () => {
    // @repeat Ry = aabb_h[aabb_idx0] 相当 (= kernel container の TIMES)
    // ただし Phase 2 では aabb_idx0 は scalarBindings 経由で解決できないため
    // formula が null になり axis demote。
    const itemOfList = block('iol1', 'data_itemoflist', {
      inputs: {
        LIST: { name: 'aabb_h' },
        INDEX: { block: 'idx-ref', name: 'aabb_idx0' },
      },
      fields: { LIST: ['aabb_h', null] },
    });
    const k1 = repeatWithTimes('k1', [itemOfList]);
    const c1 = repeatWithTimes('c1', [mathNumber('s-c1', 100)]);
    const blocks: Record<string, RawBlock> = {
      k1,
      c1,
      iol1: itemOfList,
      's-c1': mathNumber('s-c1', 100),
    };
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
    const result = collectImplicitAxes({
      kernelContainerId: 'k1',
      nestedRepeatIds: ['c1'],
      blocks,
      context,
      regionId: 'region:itemoflist',
      directives,
    });
    const ry = result.axes.find((a) => a.name === 'Ry');
    // INDEX の shadow がない (= idx-ref という block id だけ) → resolveInput が null
    // → 全体として formula = '' に降格
    expect(ry?.formula).toBe('');
  });
});

describe('axisToRepeatDirective', () => {
  it('converts ImplicitAxis to RepeatDirective-shape', () => {
    const axis = {
      name: 'Ry',
      axis: 'global_y' as const,
      formula: '64',
      blockId: 'k1',
      source: 'kernel-container' as const,
    };
    const directive: RepeatDirective = axisToRepeatDirective(axis);
    expect(directive.kind).toBe('repeat');
    expect(directive.name).toBe('Ry');
    expect(directive.axis).toBe('global_y');
    expect(directive.formula).toBe('64');
    expect(directive.blockId).toBe('k1');
    expect(directive.line).toBe(0);
    expect(directive.column).toBe(0);
  });
});
