import { describe, expect, it } from 'vitest';
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

function mkProject(
  blocks: RawBlock[],
  comments: { id: string; text: string; blockId: string }[],
): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  const commentsMap: Record<string, { text: string; blockId: string }> = {};
  for (const c of comments) commentsMap[c.id] = c;
  return {
    targets: [
      {
        id: 'sprite1',
        isStage: false,
        blocks: blockMap,
      },
    ],
    comments: commentsMap,
  };
}

describe('region-extractor (§Phase 4 — Form A only)', () => {
  it('extracts a single region when a control_repeat carries an @compute comment', () => {
    const body = [
      mkBlock('a', 'data_setvariableto', { next: 'b' }),
      mkBlock('b', 'operator_add', { next: 'c' }),
      mkBlock('c', 'data_itemoflist'),
    ];
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const project = mkProject([...body, repeat], [
      { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'repeat0' },
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
    expect(region?.commentId).toBe('cmt1');
  });

  it('returns no regions when no @compute comments exist', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const project = mkProject(
      [repeat, mkBlock('a', 'data_setvariableto')],
      [],
    );
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(0);
  });

  it('follows sub-stacks (control_if branches) into the body', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'control_if', { next: 'd', inputs: { SUBSTACK: 'b' } });
    const b = mkBlock('b', 'data_setvariableto', { next: 'c' });
    const c = mkBlock('c', 'data_itemoflist');
    const d = mkBlock('d', 'control_stop');
    const project = mkProject([repeat, a, b, c, d], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(new Set(region?.bodyBlockIds ?? [])).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('reads SUBSTACK from object-shaped input (vendored vm block reference)', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: { id: 'a', name: 'substack' } },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.firstSubstackBlockId).toBe('a');
  });

  it('reads SUBSTACK from [2, blockId] array shape (real SB3 layout, §15.1)', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: [2, 'a'] },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.firstSubstackBlockId).toBe('a');
    expect(regions[0]?.bodyBlockIds).toEqual(['a']);
  });

  it('reads SUBSTACK from [1, blockId] INPUT_SAME_BLOCK_SHADOW shape (§15.1)', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: [1, 'a'] },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.firstSubstackBlockId).toBe('a');
  });

  it('reads SUBSTACK from nested array [2, [2, "a"]] recursively (§15.1)', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: [2, [2, 'a']] },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.firstSubstackBlockId).toBe('a');
  });

  it('§Phase 4 — anchor on outer control_repeat yields kernel container = that repeat', () => {
    const a = mkBlock('a', 'data_setvariableto', { next: 'b' });
    const b = mkBlock('b', 'operator_add');
    const outer = mkBlock('outer', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const project = mkProject([outer, a, b], [
      { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'outer' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region?.kernelContainerBlockId).toBe('outer');
    expect(region?.blockId).toBe('outer');
    expect(region?.firstSubstackBlockId).toBe('a');
    expect(region?.commentAnchorBlockId).toBe('outer');
  });

  it('§Phase 4 — two regions with different kernel containers both survive', () => {
    const a = mkBlock('a', 'data_setvariableto');
    const c = mkBlock('c', 'data_setvariableto');
    const r1 = mkBlock('r1', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const r2 = mkBlock('r2', 'control_repeat', { inputs: { SUBSTACK: 'c' } });
    const project = mkProject([r1, a, r2, c], [
      { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'r1' },
      { id: 'cmt2', text: '@compute\n@bind tmp1(1) ro\n', blockId: 'r2' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(regions).toHaveLength(2);
    const byIndex = [...regions].sort((a, b) => a.regionIndex - b.regionIndex);
    expect(byIndex[0]?.blockId).toBe('r1');
    expect(byIndex[1]?.blockId).toBe('r2');
    expect(byIndex[0]?.regionIndex).toBe(0);
    expect(byIndex[1]?.regionIndex).toBe(1);
    expect(byIndex[0]?.regionId).toBe('region:sprite1:r1:0');
    expect(byIndex[1]?.regionId).toBe('region:sprite1:r2:1');
    const dupDiag = diagnostics.find(
      (d) => d.code === 'gpu.multiple_compute_regions',
    );
    expect(dupDiag).toBeUndefined();
  });
});

/**
 * §Phase 4 — end-to-end integration: region-extractor → buildRegionVerdicts →
 * emitRegion for Form A (`fn expo`-style: kernel container = `control_repeat`,
 * inner `@repeat Rx:global_x = formula, repeatPath="self"` driving the
 * dispatch).
 */
describe('region-extractor → emitRegion end-to-end (§Phase 4 Form A)', () => {
  function mathNumber(id: string, value: number): RawBlock {
    return mkBlock(id, 'math_number', {
      fields: { NUM: [String(value), null] },
    });
  }

  it('Form A: kernel container = control_repeat with @compute on itself', () => {
    // Structure:
    //   repeat (id='r0') ← @compute comment on the control_repeat
    //     SUBSTACK → b1 (data_replaceitemoflist)
    // The @repeat directive points at repeatPath="self" for axis dispatch.
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
            // `@map R0 <- 0` declares a scratch var `R0` whose value is
            // the per-iteration index (= `global_invocation_id.x`). This
            // satisfies D2's `@map has Ri` requirement on the axis name.
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
    expect(verdict.kernelContainerBlockId).toBe('r0');
    const result = emitRegion({
      regionVerdict: verdict,
      parsedProject: project,
      runtimeState: { listLengths: { buff_r: 64 } },
    });
    // §Phase 4 — Form A end-to-end pipeline assertion. The kernel
    // container (`r0`) carries its own `@compute` marker and a single
    // `@repeat` with `repeatPath="self"`. The dispatch plan routes
    // through `computeDispatchPlan`, which wraps the resolved formula
    // in `ceil(<formula> / <workgroup>)`. The actual numeric dispatch
    // extent is computed at runtime by `__dispatch-kernel-sync.ts`
    // against `runtimeState.listLengths`; here we only verify that
    // the pipeline produces a structurally sound plan (≠ `'1'`).
    expect(typeof result.dispatchPlan.x).toBe('string');
    expect(result.dispatchPlan.x.length).toBeGreaterThan(1);
    expect(result.dispatchPlan.y).toBe('1');
    expect(result.dispatchPlan.z).toBe('1');
    // The data_replaceitemoflist write is the actual parallel work.
    expect(result.wgsl).toContain('scratch_list_write_f32');
  });
});
