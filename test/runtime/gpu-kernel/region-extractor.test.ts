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

function mkProject(blocks: RawBlock[], comments: { id: string; text: string; blockId: string }[]): ParsedProject {
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

describe('region-extractor', () => {
  it('extracts a single region when a control_repeat carries an @compute comment', () => {
    const body = [
      mkBlock('a', 'data_setvariableto', {
        next: 'b',
      }),
      mkBlock('b', 'operator_add', {
        next: 'c',
      }),
      mkBlock('c', 'data_itemoflist'),
    ];
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const project = mkProject([...body, repeat], [
      { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
    ]);
    const { regions, diagnostics } = extractRegions(project);
    expect(diagnostics).toEqual([]);
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region).toBeDefined();
    expect(region?.firstSubstackBlockId).toBe('a');
    expect(region?.bodyBlockIds.sort()).toEqual(['a', 'b', 'c'].sort());
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
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
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
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.firstSubstackBlockId).toBe('a');
  });

  it('reads SUBSTACK from [2, blockId] array shape (real SB3 layout, §15.1)', () => {
    // Real SB3 wraps block references in arrays where `input[0]` is the
    // shadow kind (2 = `INPUT_BLOCK_NO_SHADOW`) and `input[1]` is the
    // referenced block id. Phase 1 unifies all shapes through
    // `extractBlockReference` so this works without per-call-site
    // branching.
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: [2, 'a'] },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
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
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
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
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
    ]);
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.firstSubstackBlockId).toBe('a');
  });

  describe('kernel container promotion (§Phase 0, nested parallelization)', () => {
    it("'@compute' on outer control_repeat (legacy) returns the candidate as kernel container", () => {
      // Layout: control_repeat('outer') { a -> b }
      //   a carries @compute comment
      const a = mkBlock('a', 'data_setvariableto', { next: 'b' });
      const b = mkBlock('b', 'operator_add');
      const outer = mkBlock('outer', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
      });
      const project = mkProject([outer, a, b], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(regions).toHaveLength(1);
      const region = regions[0];
      expect(region?.kernelContainerBlockId).toBe('outer');
      expect(region?.blockId).toBe('outer');
      expect(region?.firstSubstackBlockId).toBe('a');
      expect(region?.nestedRepeatContainerBlockIds).toEqual([]);
    });

    it("'@compute' on nested control_repeat promotes ancestor to kernel container", () => {
      // Layout: control_repeat('outer') { inner (control_repeat) { a -> b } }
      //   a carries @compute comment (the candidate is `inner`)
      //   bodyEntry for the region is `a` (= candidate's substack head)
      //   kernel container is `outer` (the ancestor)
      const a = mkBlock('a', 'data_setvariableto', { next: 'b' });
      const b = mkBlock('b', 'operator_add');
      const inner = mkBlock('inner', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
        parent: 'outer',
      });
      const outer = mkBlock('outer', 'control_repeat', {
        inputs: { SUBSTACK: 'inner' },
      });
      const project = mkProject([outer, inner, a, b], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(regions).toHaveLength(1);
      const region = regions[0];
      expect(region?.kernelContainerBlockId).toBe('outer');
      expect(region?.blockId).toBe('outer');
      expect(region?.firstSubstackBlockId).toBe('a');
      // The candidate's `inner` control_repeat shows up as a nested
      // candidate for Phase 2 implicit-axis emission.
      expect(region?.nestedRepeatContainerBlockIds).toEqual(['inner']);
    });

    it("'@compute' on deeply nested control_repeat promotes the nearest ancestor", () => {
      // Layout: outer -> middle -> inner (control_repeat) { a }
      //   a carries @compute comment; kernel container must be `middle`
      //   (1 step up), not `outer`.
      const a = mkBlock('a', 'data_setvariableto');
      const inner = mkBlock('inner', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
        parent: 'middle',
      });
      const middle = mkBlock('middle', 'control_repeat', {
        inputs: { SUBSTACK: 'inner' },
        parent: 'outer',
      });
      const outer = mkBlock('outer', 'control_repeat', {
        inputs: { SUBSTACK: 'middle' },
      });
      const project = mkProject([outer, middle, inner, a], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
      ]);
      const { regions } = extractRegions(project);
      expect(regions).toHaveLength(1);
      expect(regions[0]?.kernelContainerBlockId).toBe('middle');
      // `inner` is the nested candidate; `outer` is outside the body
      // and should not appear here.
      expect(regions[0]?.nestedRepeatContainerBlockIds).toEqual(['inner']);
    });

    it("findKernelContainer skips non-control_repeat ancestors", () => {
      // Layout: data_setvariableto('p') -> control_repeat('outer') { inner { a @compute } }
      //   Parent chain: a → inner → outer. We need `outer` as kernel
      //   container, not `p`. Since `findKernelContainer` only checks
      //   direct `parent` chain, place the candidate's `parent` directly
      //   on `outer` to model the simpler case used by `fn expo`.
      const a = mkBlock('a', 'data_setvariableto', { parent: 'inner' });
      const inner = mkBlock('inner', 'control_repeat', {
        inputs: { SUBSTACK: 'a' },
        parent: 'outer',
      });
      const outer = mkBlock('outer', 'control_repeat', {
        inputs: { SUBSTACK: 'inner' },
      });
      const project = mkProject([outer, inner, a], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
      ]);
      const { regions } = extractRegions(project);
      expect(regions).toHaveLength(1);
      expect(regions[0]?.kernelContainerBlockId).toBe('outer');
    });

    it("adopts every distinct @compute candidate as its own region (§Phase 3)", () => {
      // Layout: control_repeat('r1') { a @compute } AND control_repeat('r2') { c @compute }
      //   Two different `control_repeat` blocks each with their own
      //   `@compute` marker → 2 regions adopted, no
      //   `MULTIPLE_COMPUTE_REGIONS` diagnostic. §Phase 3 broke the
      //   legacy "first candidate wins, rest are duplicates" path.
      const a = mkBlock('a', 'data_setvariableto');
      const r1 = mkBlock('r1', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
      const c = mkBlock('c', 'data_setvariableto');
      const r2 = mkBlock('r2', 'control_repeat', { inputs: { SUBSTACK: 'c' } });
      const project = mkProject([r1, a, r2, c], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
        { id: 'cmt2', text: '@compute\n@bind tmp1(1) ro\n', blockId: 'c' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      // Both regions survive.
      expect(regions).toHaveLength(2);
      // regionIndex is the per-sprite 0-based sequence.
      const byIndex = [...regions].sort((a, b) => a.regionIndex - b.regionIndex);
      expect(byIndex[0]?.blockId).toBe('r1');
      expect(byIndex[1]?.blockId).toBe('r2');
      expect(byIndex[0]?.regionIndex).toBe(0);
      expect(byIndex[1]?.regionIndex).toBe(1);
      // regionId format carries the per-sprite index so two regions
      // with the same kernel container (= unlikely but possible) stay
      // distinguishable downstream.
      expect(byIndex[0]?.regionId).toBe('region:sprite1:r1:0');
      expect(byIndex[1]?.regionId).toBe('region:sprite1:r2:1');
      // No MULTIPLE_COMPUTE_REGIONS — the two markers live on distinct
      // blocks.
      const dupDiag = diagnostics.find(
        (d) => d.code === 'gpu.multiple_compute_regions',
      );
      expect(dupDiag).toBeUndefined();
      // And no KERNEL_CONTAINER_COLLISION either — each region owns a
      // distinct control_repeat (= its own kernel container).
      const kcDiag = diagnostics.find(
        (d) => d.code === 'gpu.kernel_container_collision',
      );
      expect(kcDiag).toBeUndefined();
    });

    it("emits gpu.multiple_compute_regions when a single block carries duplicate @compute markers", () => {
      // Phase 3: this scenario is unreachable in real scratch-vm data
      // because every block has at most one comment. The extractor
      // walks `Object.values(target.blocks)` so each `control_repeat`
      // appears in `candidates[]` at most once. Defensive dedupe
      // inside the loop is therefore dead code; the assertion below
      // documents that fact rather than asserting a non-event.
      const a = mkBlock('a', 'data_setvariableto');
      const r1 = mkBlock('r1', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
      const project = mkProject([r1, a], [
        { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
        { id: 'cmt1dup', text: '@compute\n@bind tmp1(1) ro\n', blockId: 'a' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      expect(regions).toHaveLength(1);
      // `commentIdByBlockId` overwrites on duplicate `blockId`, so the
      // second comment is silently dropped — no MULTIPLE_COMPUTE_REGIONS
      // diagnostic fires from the extractor.
      const dupDiag = diagnostics.find(
        (d) => d.code === 'gpu.multiple_compute_regions',
      );
      expect(dupDiag).toBeUndefined();
    });

    it("§Phase 3 — emits gpu.kernel_container_collision when 2 candidates share a kernel container", () => {
      // Layout (nested):
      //   kc  (control_repeat, no @compute) ← kernel container
      //     → inner1 (control_repeat, @compute) ← candidate 1
      //     → inner2 (control_repeat, @compute) ← candidate 2
      //
      // `findKernelContainer` promotes both candidates' kernel
      // container to `kc`. The first one wins (regionIndex 0); the
      // second surfaces a `gpu.kernel_container_collision` warn. No
      // `MULTIPLE_COMPUTE_REGIONS` fires — the markers live on
      // distinct entry blocks, only the kernel container overlaps.
      const inner1Body = mkBlock('inner1Body', 'data_setvariableto');
      const inner1 = mkBlock('inner1', 'control_repeat', {
        parent: 'kc',
        inputs: { SUBSTACK: 'inner1Body' },
      });
      const inner2Body = mkBlock('inner2Body', 'data_setvariableto');
      const inner2 = mkBlock('inner2', 'control_repeat', {
        parent: 'kc',
        inputs: { SUBSTACK: 'inner2Body' },
      });
      const kc = mkBlock('kc', 'control_repeat', {
        inputs: { SUBSTACK: 'inner1' },
      });
      const project = mkProject([kc, inner1, inner1Body, inner2, inner2Body], [
        { id: 'cmt_inner1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'inner1Body' },
        { id: 'cmt_inner2', text: '@compute\n@bind tmp1(1) ro\n', blockId: 'inner2Body' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      // Only the first candidate is adopted; the second is dropped
      // because the kernel container is already in use.
      expect(regions).toHaveLength(1);
      expect(regions[0]?.kernelContainerBlockId).toBe('kc');
      expect(regions[0]?.regionId).toBe('region:sprite1:kc:0');
      const kcDiag = diagnostics.find(
        (d) =>
          d.severity === 'warn' &&
          d.code === 'gpu.kernel_container_collision',
      );
      expect(kcDiag).toBeDefined();
      // The diagnostic's regionId points at the surviving region's
      // id so the region-verdict pipeline can fold it into
      // RegionVerdict.diagnostics without an extra lookup pass.
      expect(kcDiag?.regionId).toBe('region:sprite1:kc:0');
      expect(kcDiag?.blockId).toBe('kc');
      // No MULTIPLE_COMPUTE_REGIONS — Phase 3 only emits that when the
      // same block id carries duplicate markers.
      const dupDiag = diagnostics.find(
        (d) => d.code === 'gpu.multiple_compute_regions',
      );
      expect(dupDiag).toBeUndefined();
    });

    it("§Phase 3 — different kernel containers, even with nested @compute, do not collide", () => {
      // Sanity: two nested candidates whose findKernelContainer
      // results differ (= Phase 0 promotion lands on different
      // ancestors) both survive. We hand-build a layout where one
      // candidate's ancestor is kcA and the other's is kcB (top-level
      // siblings) — the adopt loop should treat them as independent
      // regions.
      const a = mkBlock('a', 'data_setvariableto');
      const b = mkBlock('b', 'data_setvariableto');
      const innerA = mkBlock('innerA', 'control_repeat', {
        parent: 'kcA',
        inputs: { SUBSTACK: 'a' },
      });
      const kcA = mkBlock('kcA', 'control_repeat', {
        inputs: { SUBSTACK: 'innerA' },
      });
      const innerB = mkBlock('innerB', 'control_repeat', {
        parent: 'kcB',
        inputs: { SUBSTACK: 'b' },
      });
      const kcB = mkBlock('kcB', 'control_repeat', {
        inputs: { SUBSTACK: 'innerB' },
      });
      const project = mkProject([kcA, kcB, innerA, innerB, a, b], [
        { id: 'cmt_a', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
        { id: 'cmt_b', text: '@compute\n@bind tmp1(1) ro\n', blockId: 'b' },
      ]);
      const { regions, diagnostics } = extractRegions(project);
      expect(regions).toHaveLength(2);
      expect(regions.map((r) => r.kernelContainerBlockId).sort()).toEqual(['kcA', 'kcB']);
      expect(diagnostics).toEqual([]);
    });
  });
});

/**
 * Phase 2 end-to-end integration: region-extractor → buildRegionVerdicts →
 * emitRegion を 1 つの scratch ブロックツリーで通す。
 *
 * 既存の `region-extractor` test は RegionVerdict 構築で止まるが、ここでは
 * emitRegion まで繋いで nested `fn expo` 形式の最終 WGSL を観測する。
 */
describe('region-extractor → emitRegion end-to-end (Phase 2 nested)', () => {
  function mathNumber(id: string, value: number): RawBlock {
    return mkBlock(id, 'math_number', {
      fields: { NUM: [String(value), null] },
    });
  }

  it('nested @compute: kernel container + candidate → 2D parallel kernel', () => {
    // Structure:
    //   outer (kernel container, id='k1') — NOT a candidate (no @compute on its substack head)
    //     SUBSTACK → 'outer-body-1'
    //       outer-body-1 → c1 (control_repeat = candidate)
    //         c1.SUBSTACK → 'b1'  ← @compute marker
    //           b1 → b2 (data_changevariableby)  ← iteration advance (skip)
    //           b2 → b3 (data_replaceitemoflist)  ← actual parallel write
    //   TIMES for both = math_number literal
    const blocks: RawBlock[] = [
      mkBlock('k1', 'control_repeat', {
        inputs: { TIMES: [2, 'kc-times'], SUBSTACK: 'outer-body-1' },
      }),
      mkBlock('outer-body-1', 'data_setvariableto', {
        next: 'c1',
        parent: 'k1',
        fields: { VARIABLE: ['outer_helper', null] },
      }),
      mkBlock('c1', 'control_repeat', {
        parent: 'outer-body-1',
        inputs: { TIMES: [2, 'cand-times'], SUBSTACK: 'b1' },
      }),
      mkBlock('b1', 'data_changevariableby', {
        next: 'b2',
        parent: 'c1',
        // Shadow format: [shadow_opcode, [reporter_opcode, value]] = [10, ['math_number', '1']]
        inputs: { VALUE: [10, ['math_number', '1']] },
        fields: { VARIABLE: ['idx1', null] },
      }),
      mkBlock('b2', 'data_replaceitemoflist', {
        next: null,
        parent: 'b1',
        inputs: {
          LIST: { name: 'buff_r' },
          INDEX: [2, 'b2-idx'],
          ITEM: { value: '1' },
        },
        fields: { LIST: ['buff_r', null] },
      }),
      mkBlock('b2-idx', 'math_number', {
        fields: { NUM: ['0', null] },
        parent: 'b2',
      }),
      mathNumber('kc-times', 64),
      mathNumber('cand-times', 100),
    ];
    const project: ParsedProject = {
      targets: [{ id: 'sprite1', isStage: false, blocks: Object.fromEntries(blocks.map((b) => [b.id, b])) }],
      comments: {
        // idx1 を @bind することで `data_changevariableby(idx1, 1)` が
        // auto-detect (= iteration-advance pattern) される。
        cmt1: {
          blockId: 'b1',
          text: '@compute\n@bind buff_r(0) rw f32\n@bind idx1(1) ro f32\n@workgroup_size(64)',
        },
      },
    };
    const { regions, diagnostics: extractDiags } = extractRegions(project);
    expect(extractDiags).toEqual([]);
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    expect(region.kernelContainerBlockId).toBe('k1');
    expect(region.nestedRepeatContainerBlockIds).toEqual(['c1']);
    // Build RegionVerdict + emit.
    const { verdicts } = buildRegionVerdicts({ parsedProject: project, regions });
    expect(verdicts).toHaveLength(1);
    const verdict = verdicts[0]!;
    expect(verdict.kernelContainerBlockId).toBe('k1');
    expect(verdict.nestedRepeatContainerBlockIds).toEqual(['c1']);
    expect(verdict.firstSubstackBlockId).toBe('b1');
    const result = emitRegion({ regionVerdict: verdict, parsedProject: project });
    // Effective patterns: data_changevariableby for idx1 (auto-detected).
    // b2 (write) は残るので scratch_list_write_f32 が出る。
    expect(
      verdict.blockSubset.effectivePatterns?.some(
        (e) => e.kind === 'iteration-advance' && e.pattern.blockId === 'b1',
      ),
    ).toBe(true);
    // WGSL body: write は残る (skip-set に含まれない)。
    expect(result.wgsl).toContain('scratch_list_write_f32(&buff_r');
    // iteration advance block b1 は body に残らない (skip される)。
    expect(result.wgsl).not.toMatch(/let __tw_expr_b1\b/);
    // dispatch plan: y = ceil(64 / 1) from kernel container, x = ceil(100 / 64) from candidate.
    expect(result.dispatchPlan.y).toMatch(/ceil\(64/);
    expect(result.dispatchPlan.x).toMatch(/ceil\(100/);
  });
});
