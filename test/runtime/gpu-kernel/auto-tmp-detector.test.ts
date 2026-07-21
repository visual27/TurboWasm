/**
 * §Phase 6 (gpu-kernel-scratch-temporary-let-binding.md) — unit tests
 * for the auto-tmp detector (`auto-tmp-detector.ts`).
 *
 * The detector runs as an M3 stage between `buildBlockSubsetVerdict`
 * and `analyzeAxes`. It walks the inlined body, collects every
 * `data_setvariableto` whose target is NOT bound by `@bind` /
 * `@map` / `@repeat`, builds the dependency DAG, detects cycles,
 * and returns a topologically ordered `AutoTmpBinding` list.
 */
import { describe, expect, it } from 'vitest';
import { detectAutoTmpBindings } from '@/runtime/gpu-kernel/auto-tmp-detector';
import { GPU_DIAGNOSTIC_CODES } from '@/runtime/gpu-kernel/diagnostic-codes';
import type {
  ExtractedRegion,
  ParsedProject,
  RawBlock,
} from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...opts };
}

function region(bodyBlockIds: string[]): ExtractedRegion {
  return {
    regionId: 'r0',
    blockId: 'b1',
    spriteId: 's1',
    commentId: 'c1',
    firstSubstackBlockId: bodyBlockIds[0] ?? '',
    bodyBlockIds,
    kernelContainerBlockId: 'b1',
    repeatPathTable: { self: 'b1' },
    regionIndex: 0,
    inlinedPrototypeBlockIds: [],
    commentAnchorBlockId: 'b1',
  };
}

function projectOf(blocks: RawBlock[]): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  return {
    targets: [{ id: 's1', isStage: false, blocks: blockMap }],
    comments: {},
  };
}

const EMPTY_DIRECTIVES = {
  binds: new Set<string>(),
  maps: new Set<string>(),
  repeats: new Set<string>(),
};

describe('auto-tmp-detector (§Phase 6)', () => {
  it('promotes a single data_setvariableto into one let binding', () => {
    const setvar = block('s1', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp0', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const project = projectOf([setvar]);
    const out = detectAutoTmpBindings({
      region: region(['s1']),
      inlinedBodyIds: ['s1'],
      project,
      directiveNames: EMPTY_DIRECTIVES,
    });
    expect(out.valid).toBe(true);
    expect(out.bindings).toHaveLength(1);
    expect(out.bindings[0]?.name.toLowerCase()).toBe('tmp0');
    expect(out.bindings[0]?.emitName).toBe('tmp0');
    expect(out.bindings[0]?.blockId).toBe('s1');
    expect(out.diagnostics).toEqual([]);
  });

  it('preserves two independent tmps in topo order', () => {
    const a = block('a', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp0', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const b = block('b', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp1', null] },
      inputs: { VALUE: [10, ['math_number', '2']] },
    });
    const project = projectOf([a, b]);
    const out = detectAutoTmpBindings({
      region: region(['a', 'b']),
      inlinedBodyIds: ['a', 'b'],
      project,
      directiveNames: EMPTY_DIRECTIVES,
    });
    expect(out.valid).toBe(true);
    expect(out.bindings.map((bnd) => bnd.name.toLowerCase()).sort()).toEqual(['tmp0', 'tmp1']);
  });

  it('orders tmp with cross-tmp dependency (tmp1 <- tmp0 + 1)', () => {
    const r0 = block('r0', 'data_variable', {
      fields: { VARIABLE: ['R0', null] },
    });
    const tmp0Set = block('a', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp0', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const tmp1Set = block('b', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp1', null] },
      inputs: {
        VALUE: ['val', null],
      },
    });
    const val = block('val', 'operator_add', {
      inputs: { NUM1: r0, NUM2: [10, ['math_number', '1']] },
    });
    // Inject `tmp0` reference into val via a `data_variableof` for tmp0
    // — easier to wire directly with a `data_variable` reporter.
    const tmp0Reporter = block('trep', 'data_variable', {
      fields: { VARIABLE: ['tmp0', null] },
    });
    const valWithTmp0 = block('val', 'operator_add', {
      inputs: { NUM1: tmp0Reporter, NUM2: [10, ['math_number', '1']] },
    });
    const project = projectOf([tmp0Set, tmp1Set, r0, val, tmp0Reporter, valWithTmp0]);
    // Wire tmp1Set's VALUE to point at valWithTmp0.
    tmp1Set.inputs = { VALUE: { id: 'valWithTmp0', name: 'valWithTmp0' } };
    const out = detectAutoTmpBindings({
      region: region(['a', 'b']),
      inlinedBodyIds: ['a', 'b'],
      project,
      directiveNames: EMPTY_DIRECTIVES,
    });
    expect(out.valid).toBe(true);
    expect(out.bindings.map((bnd) => bnd.name.toLowerCase())).toEqual(['tmp0', 'tmp1']);
  });

  it('demotes (D1) on scratch-variable cycle (tmp1 = tmp2 + 1; tmp2 = tmp1 + 1)', () => {
    const r0 = block('r0', 'data_variable', {
      fields: { VARIABLE: ['R0', null] },
    });
    const tmp1Reporter = block('rep1', 'data_variable', {
      fields: { VARIABLE: ['tmp1', null] },
    });
    const tmp2Reporter = block('rep2', 'data_variable', {
      fields: { VARIABLE: ['tmp2', null] },
    });
    const val1 = block('v1', 'operator_add', {
      inputs: { NUM1: tmp2Reporter, NUM2: [10, ['math_number', '1']] },
    });
    const val2 = block('v2', 'operator_add', {
      inputs: { NUM1: tmp1Reporter, NUM2: [10, ['math_number', '1']] },
    });
    const tmp1Set = block('s1', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp1', null] },
      inputs: { VALUE: { id: 'v1', name: 'v1' } },
    });
    const tmp2Set = block('s2', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp2', null] },
      inputs: { VALUE: { id: 'v2', name: 'v2' } },
    });
    const project = projectOf([tmp1Set, tmp2Set, r0, tmp1Reporter, tmp2Reporter, val1, val2]);
    const out = detectAutoTmpBindings({
      region: region(['s1', 's2']),
      inlinedBodyIds: ['s1', 's2'],
      project,
      directiveNames: EMPTY_DIRECTIVES,
    });
    expect(out.valid).toBe(false);
    expect(out.demoteReason).toBe('d1');
    expect(out.diagnostics.some((d) => d.code === GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_CYCLE)).toBe(
      true,
    );
  });

  it('skips a scratch tmp whose name is already bound by @bind', () => {
    // Per gpu-kernel-scratch-temporary-let-binding.md §2.2 (5), a
    // scratch variable that collides with an `@bind` name is NOT
    // promoted to auto-tmp (= the existing `@bind` path handles it).
    // No demote — the user can still ship the region via JS / GPU
    // path as before.
    const setvar = block('s1', 'data_setvariableto', {
      fields: { VARIABLE: ['buff_r', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const project = projectOf([setvar]);
    const out = detectAutoTmpBindings({
      region: region(['s1']),
      inlinedBodyIds: ['s1'],
      project,
      directiveNames: { ...EMPTY_DIRECTIVES, binds: new Set(['buff_r']) },
    });
    expect(out.valid).toBe(true);
    expect(out.bindings).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  it('skips a scratch tmp whose name is already bound by @map', () => {
    const setvar = block('s1', 'data_setvariableto', {
      fields: { VARIABLE: ['A', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const project = projectOf([setvar]);
    const out = detectAutoTmpBindings({
      region: region(['s1']),
      inlinedBodyIds: ['s1'],
      project,
      directiveNames: { ...EMPTY_DIRECTIVES, maps: new Set(['a']) },
    });
    expect(out.valid).toBe(true);
    expect(out.bindings).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  it('does NOT promote a tmp whose name is bound by @repeat', () => {
    const setvar = block('s1', 'data_setvariableto', {
      fields: { VARIABLE: ['R0', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const project = projectOf([setvar]);
    const out = detectAutoTmpBindings({
      region: region(['s1']),
      inlinedBodyIds: ['s1'],
      project,
      directiveNames: { ...EMPTY_DIRECTIVES, repeats: new Set(['r0']) },
    });
    expect(out.valid).toBe(true);
    expect(out.bindings).toHaveLength(0);
  });

  it('warns (last-write-wins) on duplicate data_setvariableto writes', () => {
    const a = block('a', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp0', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const b = block('b', 'data_setvariableto', {
      fields: { VARIABLE: ['tmp0', null] },
      inputs: { VALUE: [10, ['math_number', '2']] },
    });
    const project = projectOf([a, b]);
    const out = detectAutoTmpBindings({
      region: region(['a', 'b']),
      inlinedBodyIds: ['a', 'b'],
      project,
      directiveNames: EMPTY_DIRECTIVES,
    });
    expect(out.valid).toBe(true);
    expect(out.bindings).toHaveLength(1);
    expect(
      out.diagnostics.some(
        (d) => d.code === GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_DUPLICATE_WRITE,
      ),
    ).toBe(true);
  });

  it('emits info diagnostic for data_changevariableby on a non-bound scratch var', () => {
    const change = block('s1', 'data_changevariableby', {
      fields: { VARIABLE: ['tmp0', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const project = projectOf([change]);
    const out = detectAutoTmpBindings({
      region: region(['s1']),
      inlinedBodyIds: ['s1'],
      project,
      directiveNames: EMPTY_DIRECTIVES,
    });
    expect(out.valid).toBe(true);
    expect(out.bindings).toHaveLength(0);
    expect(
      out.diagnostics.some(
        (d) => d.code === GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_CHANGEVARBY_IGNORED,
      ),
    ).toBe(true);
  });

  it('handles case-insensitive scratch variable names', () => {
    const setvar = block('s1', 'data_setvariableto', {
      fields: { VARIABLE: ['TmpMixed', null] },
      inputs: { VALUE: [10, ['math_number', '1']] },
    });
    const project = projectOf([setvar]);
    const out = detectAutoTmpBindings({
      region: region(['s1']),
      inlinedBodyIds: ['s1'],
      project,
      directiveNames: EMPTY_DIRECTIVES,
    });
    expect(out.valid).toBe(true);
    expect(out.bindings[0]?.name).toBe('tmpmixed');
  });

  it('returns empty bindings when no scratch tmp writes are present', () => {
    const item = block('a', 'data_itemoflist', {
      inputs: { INDEX: [10, ['math_number', '0']] },
      fields: { LIST: ['buff_r', null] },
    });
    const project = projectOf([item]);
    const out = detectAutoTmpBindings({
      region: region(['a']),
      inlinedBodyIds: ['a'],
      project,
      directiveNames: EMPTY_DIRECTIVES,
    });
    expect(out.valid).toBe(true);
    expect(out.bindings).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });
});
