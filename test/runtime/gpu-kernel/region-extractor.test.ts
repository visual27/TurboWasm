/**
 * Consolidated region-extractor tests.
 *
 * Replaces four previous files that all targeted `extractRegions`:
 *   - region-extractor.test.ts (§Phase 4 Form A behaviour + §15.1 SUBSTACK shapes + end-to-end)
 *   - region-extractor-loose-position.test.ts (Form A vs legacy diagnostic + repeatPathTable)
 *   - region-extractor-single-pass.test.ts (§Phase 5 single-pass invariant)
 *   - phase1-types.test.ts (Diagnostic codes catalogue + ExtractedRegion defaults)
 *
 * The consolidation removes duplicated `mkBlock` / `mkProject` helpers and
 * overlapping Form A scenarios. The catalogue assertion is collapsed to a
 * single `it.each` and now lives next to the behavioural tests so a
 * diagnostic-code rename shows up beside the diagnostic that emits it.
 */
import { describe, expect, it } from 'vitest';
import { buildBlockSubsetVerdict } from '@/runtime/gpu-kernel/block-subset';
import { GPU_DIAGNOSTIC_CODES } from '@/runtime/gpu-kernel/diagnostic-codes';
import { extractRegions } from '@/runtime/gpu-kernel/region-extractor';
import { buildRegionVerdicts } from '@/runtime/gpu-kernel/region-verdict-pipeline';
import { emitRegion } from '@/runtime/gpu-kernel/wgsl-emitter';
import type { ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

function mkBlock(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return {
    id,
    opcode,
    next: null,
    parent: null,
    inputs: {},
    fields: {},
    ...opts,
  };
}

function mkPrototype(
  id: string,
  proccode: string,
  argumentNames: string[],
  substackHeadId: string,
): RawBlock {
  return mkBlock(id, 'procedures_prototype', {
    inputs: { SUBSTACK: substackHeadId },
    mutation: { proccode, argumentnames: JSON.stringify(argumentNames) },
    topLevel: true,
  });
}

function mkCall(id: string, proccode: string, parent: string | null): RawBlock {
  return mkBlock(id, 'procedure_call', {
    inputs: {},
    mutation: { proccode },
    parent,
  });
}

function mkProject(
  blocks: RawBlock[],
  comments: { id?: string; text: string; blockId: string }[] = [],
): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  const commentsMap: Record<string, { text: string; blockId: string }> = {};
  for (const [i, c] of comments.entries()) {
    const id = c.id ?? `cmt${i + 1}`;
    commentsMap[id] = { text: c.text, blockId: c.blockId };
  }
  return {
    targets: [{ id: 'sprite1', isStage: false, blocks: blockMap }],
    comments: commentsMap,
  };
}

describe('Diagnostic codes catalogue (Phase 1 + Phase 3-5 registrations)', () => {
  it.each([
    ['KERNEL_CONTAINER_COLLISION', 'gpu.kernel_container_collision'],
    ['BIND_SLOT_COLLISION', 'gpu.bind_slot_collision'],
    ['REGIONAL_BUFFER_MEMORY_PRESSURE', 'gpu.regional_buffer_memory_pressure'],
    ['PROCEDURE_RECURSION_UNSUPPORTED', 'gpu.procedure_recursion_unsupported'],
    ['PROCEDURE_PROTOTYPE_NOT_FOUND', 'gpu.procedure_prototype_not_found'],
    ['LEGACY_COMPUTE_COMMENT_POSITION', 'gpu.legacy_compute_comment_position'],
    ['BOUND_BLOCK_REQUIRED', 'gpu.bound_block_required'],
  ] as const)('%s -> %s', (key, expected) => {
    expect(GPU_DIAGNOSTIC_CODES[key]).toBe(expected);
  });
});

describe('extractRegions (§Phase 4 Form A)', () => {
  it('extracts a single region when the marker sits on control_repeat', () => {
    const body = [
      mkBlock('a', 'data_setvariableto', { next: 'b' }),
      mkBlock('b', 'operator_add', { next: 'c' }),
      mkBlock('c', 'data_itemoflist'),
    ];
    const repeat = mkBlock('repeat0', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const project = mkProject([...body, repeat], [
      { text: '@compute\n@bind tmp0(0) ro\n', blockId: 'repeat0' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region).toBeDefined();
    expect(region?.blockId).toBe('repeat0');
    expect(region?.kernelContainerBlockId).toBe('repeat0');
    expect(region?.firstSubstackBlockId).toBe('a');
    expect(region?.bodyBlockIds.slice().sort()).toEqual(['a', 'b', 'c'].sort());
    expect(region?.spriteId).toBe('sprite1');
    expect(region?.commentAnchorBlockId).toBe('repeat0');
    expect(region?.repeatPathTable['self']).toBe('repeat0');
    // Defaults carried by every region (Phase 1 invariants).
    expect(region?.regionIndex).toBe(0);
    expect(region?.inlinedPrototypeBlockIds).toEqual([]);
  });

  it('returns no regions when no @compute comments exist', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const project = mkProject([repeat, mkBlock('a', 'data_setvariableto')], []);
    expect(extractRegions(project).regions).toHaveLength(0);
  });

  it('follows sub-stacks (control_if branches) into the body', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const a = mkBlock('a', 'control_if', { next: 'd', inputs: { SUBSTACK: 'b' } });
    const b = mkBlock('b', 'data_setvariableto', { next: 'c' });
    const c = mkBlock('c', 'data_itemoflist');
    const d = mkBlock('d', 'control_stop');
    const project = mkProject([repeat, a, b, c, d], [
      { text: '@compute\n', blockId: 'repeat0' },
    ]);
    expect(extractRegions(project).regions[0]?.bodyBlockIds.slice().sort()).toEqual(
      ['a', 'b', 'c', 'd'],
    );
  });

  it.each([
    ['object-shaped input (vendored vm block reference)', { id: 'a', name: 'substack' }],
    ['[2, blockId] array shape (real SB3 layout, §15.1)', [2, 'a']],
    ['[1, blockId] INPUT_SAME_BLOCK_SHADOW shape (§15.1)', [1, 'a']],
    ['nested array [2, [2, "a"]] recursively (§15.1)', [2, [2, 'a']]],
  ])('reads SUBSTACK from %s', (_label, substackValue) => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: substackValue as unknown as string },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [{ text: '@compute\n', blockId: 'repeat0' }]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.firstSubstackBlockId).toBe('a');
  });

  it('two sibling Form A markers become two independent regions (no collision diagnostic)', () => {
    const a = mkBlock('a', 'data_setvariableto');
    const c = mkBlock('c', 'data_setvariableto');
    const r1 = mkBlock('r1', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const r2 = mkBlock('r2', 'control_repeat', { inputs: { SUBSTACK: 'c' } });
    const project = mkProject([r1, a, r2, c], [
      { text: '@compute\n@bind tmp0(0) ro\n', blockId: 'r1' },
      { text: '@compute\n@bind tmp1(1) ro\n', blockId: 'r2' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(2);
    const byIndex = [...regions].sort((a, b) => a.regionIndex - b.regionIndex);
    expect(byIndex.map((r) => r.blockId)).toEqual(['r1', 'r2']);
    expect(byIndex.map((r) => r.regionId)).toEqual([
      'region:sprite1:r1:0',
      'region:sprite1:r2:1',
    ]);
    expect(diagnostics.find((d) => d.code === 'gpu.multiple_compute_regions')).toBeUndefined();
  });

  it('warns once per duplicate marker on the same Form A anchor', () => {
    const r = mkBlock('r', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([r, a], [
      { text: '@compute\n', blockId: 'r' },
      { text: '@compute\n', blockId: 'r' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(
      diagnostics.filter((d) => d.code === 'gpu.legacy_compute_comment_position'),
    ).toHaveLength(0);
    expect(
      diagnostics.filter((d) => d.code === 'gpu.multiple_compute_regions'),
    ).toHaveLength(1);
  });
});

describe('extractRegions: rejected anchors emit gpu.legacy_compute_comment_position', () => {
  it.each([
    ['marker on first-substack block (legacy form)', 'a'],
    ['marker on a non-control_repeat block', 'a'],
  ])('%s', (_label, anchor) => {
    const a = mkBlock('a', 'data_setvariableto');
    const r = mkBlock('r', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const project = mkProject([r, a], [{ text: '@compute\n', blockId: anchor }]);
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(0);
    expect(
      diagnostics.find((d) => d.code === 'gpu.legacy_compute_comment_position'),
    ).toMatchObject({ severity: 'warn' });
  });

  it('repeatUntil / repeatWhile / forever anchors are skipped', () => {
    const project = mkProject(
      [mkBlock('a', 'control_repeat_until', { inputs: { SUBSTACK: 'a' } })],
      [{ text: '@compute\n', blockId: 'a' }],
    );
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(0);
    expect(
      diagnostics.some((d) => d.code === 'gpu.legacy_compute_comment_position'),
    ).toBe(true);
  });
});

describe('extractRegions: repeatPathTable (Form A only)', () => {
  it('builds sibling + descendant paths from SUBSTACK next chains', () => {
    const a = mkBlock('a', 'data_setvariableto');
    const inner = mkBlock('inner', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
      parent: 'r',
      next: 'sibling',
    });
    const sibling = mkBlock('sibling', 'control_repeat', {
      inputs: { SUBSTACK: 'b' },
      parent: 'r',
    });
    const b = mkBlock('b', 'data_setvariableto', { parent: 'sibling' });
    const r = mkBlock('r', 'control_repeat', { inputs: { SUBSTACK: 'inner' } });
    const project = mkProject([r, inner, a, sibling, b], [{ text: '@compute\n', blockId: 'r' }]);
    const table = extractRegions(project).regions[0]?.repeatPathTable ?? {};
    expect(table['self']).toBe('r');
    expect(table['0']).toBe('inner');
    expect(table['1']).toBe('sibling');
    expect(table['2']).toBeUndefined();
  });

  it('non-repeat sibling insertions do not shift the path table', () => {
    const a = mkBlock('a', 'data_setvariableto');
    const b = mkBlock('b', 'data_setvariableto');
    const inner = mkBlock('inner', 'control_repeat', {
      inputs: { SUBSTACK: 'b' },
      parent: 'r',
    });
    const r = mkBlock('r', 'control_repeat', { inputs: { SUBSTACK: 'inner' } });
    const project = mkProject([r, inner, a, b], [{ text: '@compute\n', blockId: 'r' }]);
    const table = extractRegions(project).regions[0]?.repeatPathTable ?? {};
    expect(table['0']).toBe('inner');
    expect(table['1']).toBeUndefined();
  });
});

describe('region-extractor single-pass invariant (§Phase 5 §5.3)', () => {
  function buildProjectWithCall(): ParsedProject {
    const sub = mkBlock('sub', 'data_itemoflist', { next: 'writeA' });
    const writeA = mkBlock('writeA', 'data_replaceitemoflist', { parent: 'sub' });
    const protoA = mkPrototype('protoA', 'fnA', [], 'sub');
    const callA = mkCall('callA', 'fnA', 'kernelContainer');
    const kernelContainer = mkBlock('kernelContainer', 'control_repeat', {
      inputs: { SUBSTACK: 'callA' },
    });
    const project = mkProject([protoA, sub, writeA, callA, kernelContainer]);
    project.comments['cmt'] = { blockId: 'kernelContainer', text: '@compute\n' };
    return project;
  }

  it('extractRegions runs once (no pass-5 re-extraction)', () => {
    const { regions } = extractRegions(buildProjectWithCall());
    expect(regions).toHaveLength(1);
  });

  it('region.bodyBlockIds keeps the original procedure_call (block-subset owns inlining)', () => {
    const { regions } = extractRegions(buildProjectWithCall());
    const region = regions[0]!;
    expect(region.bodyBlockIds).toContain('callA');
    expect(region.inlinedPrototypeBlockIds).toEqual([]);
  });

  it('block-subset inlines the call (default), D1-valid; opt-out keeps procedure_call and demotes', () => {
    const { regions } = extractRegions(buildProjectWithCall());
    const region = regions[0]!;
    const verdict = buildBlockSubsetVerdict({
      region,
      project: buildProjectWithCall(),
      comments: buildProjectWithCall().comments,
      parsedDirectives: [],
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const optOutVerdict = buildBlockSubsetVerdict({
      region,
      project: buildProjectWithCall(),
      comments: buildProjectWithCall().comments,
      parsedDirectives: [],
      inliningEnabled: false,
    });
    expect(optOutVerdict.valid).toBe(false);
    expect(optOutVerdict.demoteReason).toBe('d1');
    const demoteDiagnostic = optOutVerdict.diagnostics.find(
      (d) => d.code === 'd1.region_demoted',
    );
    expect(demoteDiagnostic?.message).toMatch(/procedure_call/);
  });
});

describe('region-extractor → emitRegion end-to-end (§Phase 4 Form A)', () => {
  function mathNumber(id: string, value: number): RawBlock {
    return mkBlock(id, 'math_number', { fields: { NUM: [String(value), null] } });
  }

  it('Form A: kernel container = control_repeat with @compute on itself', () => {
    const blocks: RawBlock[] = [
      mkBlock('r0', 'control_repeat', {
        inputs: { TIMES: [2, 'r0-times'], SUBSTACK: 'b1' },
      }),
      mkBlock('b1', 'data_replaceitemoflist', {
        next: null,
        parent: 'r0',
        inputs: {
          LIST: { name: 'buff_r' },
          INDEX: [2, 'b1-idx'],
          ITEM: { value: '1' },
        },
        fields: { LIST: ['buff_r', null] },
      }),
      mkBlock('b1-idx', 'math_number', {
        fields: { NUM: ['0', null] },
        parent: 'b1',
      }),
      mathNumber('r0-times', 100),
    ];
    const project: ParsedProject = {
      targets: [
        {
          id: 'sprite1',
          isStage: false,
          blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
        },
      ],
      comments: {
        cmt1: {
          blockId: 'r0',
          text:
            '@compute\n' +
            '@bind buff_r(0) rw f32\n' +
            '@repeat R0:global_x = R0, repeatPath="self"\n' +
            '@workgroup_size(64)\n' +
            '@map R0 <- 0',
        },
      },
    };
    const { regions, diagnostics: extractDiags } = extractRegions(project);
    expect(extractDiags.filter((d) => d.severity === 'error')).toEqual([]);
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    expect(region.kernelContainerBlockId).toBe('r0');
    expect(region.repeatPathTable['self']).toBe('r0');
    const { verdicts } = buildRegionVerdicts({ parsedProject: project, regions });
    expect(verdicts).toHaveLength(1);
    const verdict = verdicts[0]!;
    const result = emitRegion({
      regionVerdict: verdict,
      parsedProject: project,
      runtimeState: { listLengths: { buff_r: 64 } },
    });
    expect(typeof result.dispatchPlan.x).toBe('string');
    expect(result.dispatchPlan.x.length).toBeGreaterThan(1);
    expect(result.dispatchPlan.y).toBe('1');
    expect(result.dispatchPlan.z).toBe('1');
    expect(result.wgsl).toContain('scratch_list_write_f32');
  });
});
