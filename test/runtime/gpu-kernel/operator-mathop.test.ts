/**
 * Phase 2 — `operator_mathop` → WGSL builtin lowering.
 *
 * Each scratch menu value (`abs` / `floor` / `ceiling` / `sqrt` /
 * `sin` / `cos` / `tan` / `asin` / `acos` / `atan` / `ln` / `log` /
 * `e ^` / `10 ^`) maps onto a single WGSL expression. Scratch uses
 * `NUM` for the single input and `fields.OPERATOR` for the menu
 * selection; the emitter reads both shapes directly.
 *
 * Sin/cos/tan convert degrees → radians via the WGSL `radians()`
 * builtin (scratch's trig is degrees-based). asin/acos/atan convert
 * the WGSL radian result back to degrees. `log` uses the f32 expansion
 * `log(x) * (1 / log(10))` since WGSL has no `log10` builtin.
 */
import { describe, expect, it } from 'vitest';
import {
  emitRegion,
  type EmitInput,
} from '@/runtime/gpu-kernel/wgsl-emitter';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import { resolveRepeatPaths } from '@/runtime/gpu-kernel/repeat-path-resolver';
import type {
  ExtractedRegion,
  ParsedProject,
  RawBlock,
  RegionVerdict,
} from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, options: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...options };
}

function mathNumber(id: string, value: number): RawBlock {
  return block(id, 'math_number', { fields: { NUM: [String(value), null] } });
}

function mathop(id: string, operator: string, numId: string): RawBlock {
  return block(id, 'operator_mathop', {
    fields: { OPERATOR: [operator, null] },
    inputs: { NUM: [2, numId] },
  });
}

function makeProject(body: RawBlock[]): ParsedProject {
  const blocks: Record<string, RawBlock> = {};
  blocks['repeat'] = block('repeat', 'control_repeat', {
    inputs: { SUBSTACK: body[0]?.id ? body[0].id : '' },
  });
  for (const b of body) blocks[b.id] = b;
  return { targets: [{ id: 'sprite', isStage: false, blocks }], comments: {} };
}

function makeVerdict(): {
  regionVerdict: RegionVerdict;
  build: (project: ParsedProject) => EmitInput;
} {
  const parsed = parseComputeComment(
    { blockId: 'body', text: '@compute\n@bind buff_r(1) rw f32' },
    'region',
  );
  const region: ExtractedRegion = {
    regionId: 'region',
    blockId: 'repeat',
    spriteId: 'sprite',
    commentId: 'body',
    firstSubstackBlockId: '',
    bodyBlockIds: [],
    kernelContainerBlockId: 'repeat',
    repeatPathTable: { self: 'repeat' },
    regionIndex: 0,
    inlinedPrototypeBlockIds: [],
    commentAnchorBlockId: 'repeat',
  };
  const resolved = resolveRepeatPaths(region, parsed.directives);
  const regionVerdict: RegionVerdict = {
    regionId: 'region',
    blockId: 'repeat',
    spriteId: 'sprite',
    directives: resolved.directives,
    blockSubset: { valid: true, diagnostics: [] },
    autoTmpVerdict: { valid: true, bindings: [], diagnostics: [] },
    axes: {},
    cascade: { valid: true, diagnostics: [], topoOrder: [] },
    diagnostics: [...parsed.diagnostics, ...resolved.diagnostics],
    parallelAxes: [],
    kernelContainerBlockId: 'repeat',
    firstSubstackBlockId: '',
  };
  return {
    regionVerdict,
    build: (project) => ({ regionVerdict, parsedProject: project }),
  };
}

function runMathop(operator: string, numValue: number): {
  wgsl: string;
  diagnostics: { code: string; severity: string }[];
} {
  const num = mathNumber('num', numValue);
  const op = mathop('op', operator, 'num');
  const { build } = makeVerdict();
  const result = emitRegion(build(makeProject([op, num])));
  return {
    wgsl: result.wgsl,
    diagnostics: result.diagnostics.map((d) => ({ code: d.code, severity: d.severity })),
  };
}

const HASH = '[0-9a-f]{8}';

describe('operator_mathop → WGSL intrinsics', () => {
  it.each([
    ['abs', 2.7, 'abs(2.7)'],
    ['floor', 2.7, 'floor(2.7)'],
    ['ceiling', 2.3, 'ceil(2.3)'],
    ['sqrt', 4, 'sqrt(4.0)'],
  ])('unary %s emits %s', (operator, num, expected) => {
    const { wgsl, diagnostics } = runMathop(operator, num);
    const re = new RegExp(`let __tw_expr_${HASH}: f32 = ${expected.replace(/[.()+*]/g, '\\$&')};`);
    expect(wgsl).toMatch(re);
    expect(diagnostics.filter((d) => d.code === 'gpu.emitter_unsupported_opcode')).toEqual([]);
  });

  it('ln maps to log(x) (natural logarithm)', () => {
    const { wgsl, diagnostics } = runMathop('ln', 2);
    expect(wgsl).toMatch(new RegExp(`let __tw_expr_${HASH}: f32 = log\\(2\\.0\\);`));
    expect(diagnostics).toEqual([]);
  });

  it('log (base-10) maps to log(x) * (1 / log(10)) (no WGSL log10 builtin)', () => {
    const { wgsl, diagnostics } = runMathop('log', 100);
    expect(wgsl).toMatch(
      new RegExp(`let __tw_expr_${HASH}: f32 = \\(log\\(100\\.0\\) \\* \\(1\\.0 / log\\(10\\.0\\)\\)\\);`),
    );
    expect(diagnostics).toEqual([]);
  });

  it('e ^ maps to exp(x)', () => {
    const { wgsl, diagnostics } = runMathop('e ^', 1);
    expect(wgsl).toMatch(new RegExp(`let __tw_expr_${HASH}: f32 = exp\\(1\\.0\\);`));
    expect(diagnostics).toEqual([]);
  });

  it('10 ^ maps to pow(10.0, x)', () => {
    const { wgsl, diagnostics } = runMathop('10 ^', 2);
    expect(wgsl).toMatch(new RegExp(`let __tw_expr_${HASH}: f32 = pow\\(10\\.0, 2\\.0\\);`));
    expect(diagnostics).toEqual([]);
  });

  it('sin applies degrees→radians conversion', () => {
    const { wgsl } = runMathop('sin', 90);
    expect(wgsl).toMatch(
      new RegExp(`let __tw_expr_${HASH}: f32 = sin\\(radians\\(90\\.0\\)\\);`),
    );
  });

  it('cos applies degrees→radians conversion', () => {
    const { wgsl } = runMathop('cos', 45);
    expect(wgsl).toMatch(
      new RegExp(`let __tw_expr_${HASH}: f32 = cos\\(radians\\(45\\.0\\)\\);`),
    );
  });

  it('tan applies degrees→radians conversion', () => {
    const { wgsl } = runMathop('tan', 30);
    expect(wgsl).toMatch(
      new RegExp(`let __tw_expr_${HASH}: f32 = tan\\(radians\\(30\\.0\\)\\);`),
    );
  });

  it('asin applies radians→degrees conversion', () => {
    const { wgsl } = runMathop('asin', 1);
    expect(wgsl).toMatch(
      new RegExp(`let __tw_expr_${HASH}: f32 = degrees\\(asin\\(1\\.0\\)\\);`),
    );
  });

  it('acos applies radians→degrees conversion', () => {
    const { wgsl } = runMathop('acos', 0);
    expect(wgsl).toMatch(
      new RegExp(`let __tw_expr_${HASH}: f32 = degrees\\(acos\\(0\\.0\\)\\);`),
    );
  });

  it('atan applies radians→degrees conversion', () => {
    const { wgsl } = runMathop('atan', 1);
    expect(wgsl).toMatch(
      new RegExp(`let __tw_expr_${HASH}: f32 = degrees\\(atan\\(1\\.0\\)\\);`),
    );
  });

  it('normalises uppercase OPERATOR (scratch-vm is case-insensitive)', () => {
    const num = mathNumber('num', 3);
    const op = block('op', 'operator_mathop', {
      fields: { OPERATOR: ['ABS', null] },
      inputs: { NUM: [2, 'num'] },
    });
    const { regionVerdict, build } = makeVerdict();
    const { wgsl } = emitRegion(build(makeProject([op, num])));
    expect(wgsl).toMatch(new RegExp(`let __tw_expr_${HASH}: f32 = abs\\(3\\.0\\);`));
    expect(regionVerdict.regionId).toBe('region');
  });

  it('chains e ^ (ln(2) * v) through nested mathop blocks', () => {
    //   product   = ln(2.0) * 1.0
    //   exponent  = e ^ product
    // The two intermediate reporters are pulled in via
    // `emitBlockExpression` recursion even though only `exponent` is
    // attached to the body. Verify the final expression tree is right.
    const two = mathNumber('two', 2);
    const one = mathNumber('one', 1);
    const lnOf2 = mathop('lnOf2', 'ln', 'two');
    const product = block('product', 'operator_multiply', {
      inputs: { NUM1: [2, 'lnOf2'], NUM2: [2, 'one'] },
    });
    const expOfProduct = mathop('expOfProduct', 'e ^', 'product');
    const { build } = makeVerdict();
    const { wgsl } = emitRegion(
      build(makeProject([expOfProduct, product, lnOf2, two, one])),
    );
    expect(wgsl).toMatch(
      new RegExp(`let __tw_expr_${HASH}: f32 = exp\\(\\(log\\(2\\.0\\) \\* 1\\.0\\)\\);`),
    );
  });

  it('emits unsupported-opcode diagnostic for unknown OPERATOR values', () => {
    const num = mathNumber('num', 1);
    const op = block('op', 'operator_mathop', {
      fields: { OPERATOR: ['__bogus__', null] },
      inputs: { NUM: [2, 'num'] },
    });
    const { build } = makeVerdict();
    const { wgsl, diagnostics } = emitRegion(build(makeProject([op, num])));
    expect(wgsl).toMatch(new RegExp(`let __tw_expr_${HASH}: f32 = 0\\.0;`));
    expect(
      diagnostics.filter((d) => d.code === 'gpu.emitter_unsupported_opcode'),
    ).toHaveLength(1);
  });

  it('resolves a literal `NUM` (no reporter attached)', () => {
    const op = block('op', 'operator_mathop', {
      fields: { OPERATOR: ['sqrt', null] },
      inputs: {},
    });
    const { build } = makeVerdict();
    const { wgsl, diagnostics } = emitRegion(build(makeProject([op])));
    expect(wgsl).toMatch(new RegExp(`let __tw_expr_${HASH}: f32 = sqrt\\(0\\.0\\);`));
    expect(diagnostics.filter((d) => d.code === 'gpu.emitter_unsupported_opcode')).toEqual([]);
  });
});