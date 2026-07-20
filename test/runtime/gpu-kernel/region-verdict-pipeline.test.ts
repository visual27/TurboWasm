import { describe, expect, it } from 'vitest';
import { buildBlockSubsetVerdict } from '@/runtime/gpu-kernel/block-subset';
import { extractRegions } from '@/runtime/gpu-kernel/region-extractor';
import {
  buildRegionVerdicts,
  collectRegionVerdictsFromArrayBuffer,
} from '@/runtime/gpu-kernel/region-verdict-pipeline';
import type { Diagnostic, ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

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
  for (const c of comments) {
    commentsMap[c.id] = { text: c.text, blockId: c.blockId };
  }
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

/**
 * §Phase 2 (15.2) — parser diagnostics whose severity is `error` must
 * demote the owning region to D1. Warn-severity diagnostics keep the
 * existing behaviour (`valid: true`).
 *
 * The current parser only emits warn-severity `gpu.dsl_syntax_error`s,
 * so the test path goes through `buildBlockSubsetVerdict` with a
 * synthetic error diagnostic. The full `buildRegionVerdicts` →
 * `initializeGpuKernels` end-to-end path is exercised separately in the
 * `@max` removal tests under `comment-parser.test.ts` once §15.3 lands.
 */
describe('buildBlockSubsetVerdict: parser-error demote (Phase 2 §15.2)', () => {
  it('demotes the region when parser diagnostics contain a severity=error entry', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    const region = regions[0]!;

    const errorDiag: Diagnostic = {
      severity: 'error',
      code: 'gpu.dsl_syntax_error',
      message: '@max is removed in v9; use runtime list length instead',
      regionId: region.regionId,
      blockId: 'repeat0',
      line: 0,
      column: 0,
    };
    const verdict = buildBlockSubsetVerdict({
      region,
      project,
      comments: project.comments,
      parsedDirectives: [],
      parsedDiagnostics: [errorDiag],
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.demoteReason).toBe('d1');
    expect(verdict.diagnostics).toContainEqual(errorDiag);
    // No pattern extraction runs on a parser-error region.
    expect(verdict.effectivePatterns).toEqual([]);
  });

  it('keeps the region valid when parser diagnostics are warn-only with a non-PARSER_ERROR_CODES code', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    const region = regions[0]!;

    // §Phase 3 — `gpu.dsl_syntax_error` is now in `PARSER_ERROR_CODES`
    // and forces a D1 demote regardless of severity. Use a different
    // warn code so this test exercises the warn-only path (the
    // originally intended contract).
    const warnDiag: Diagnostic = {
      severity: 'warn',
      code: 'gpu.some_warn',
      message: 'malformed @bind: expected ...',
      regionId: region.regionId,
      blockId: 'repeat0',
      line: 0,
      column: 0,
    };
    const verdict = buildBlockSubsetVerdict({
      region,
      project,
      comments: project.comments,
      parsedDirectives: [],
      parsedDiagnostics: [warnDiag],
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.diagnostics).toContainEqual(warnDiag);
  });

  it('demotes the region when a warn-severity diagnostic carries a code in PARSER_ERROR_CODES (§Phase 3)', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    const region = regions[0]!;

    // §Phase 3 — even at warn severity, a diagnostic whose code is in
    // `PARSER_ERROR_CODES` forces a D1 demote. `gpu.bind_slot_collision`
    // is the canonical example: emitted at warn-or-error depending on
    // upstream convention, but always routes through the parser-error
    // demote path.
    const slotWarn: Diagnostic = {
      severity: 'warn',
      code: 'gpu.bind_slot_collision',
      message: '@bind slot 0 used by both foo and bar',
      regionId: region.regionId,
      blockId: 'repeat0',
      line: 0,
      column: 0,
    };
    const verdict = buildBlockSubsetVerdict({
      region,
      project,
      comments: project.comments,
      parsedDirectives: [],
      parsedDiagnostics: [slotWarn],
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.demoteReason).toBe('d1');
    expect(verdict.diagnostics).toContainEqual(slotWarn);
  });

  it('folds mixed severities and demotes when at least one is error', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    const region = regions[0]!;

    const warnDiag: Diagnostic = {
      severity: 'warn',
      code: 'gpu.dsl_syntax_error',
      message: 'unknown directive',
      regionId: region.regionId,
      blockId: 'repeat0',
      line: 0,
      column: 0,
    };
    const errorDiag: Diagnostic = {
      severity: 'error',
      code: 'gpu.dsl_syntax_error',
      message: '@max is removed in v9',
      regionId: region.regionId,
      blockId: 'repeat0',
      line: 1,
      column: 0,
    };
    const verdict = buildBlockSubsetVerdict({
      region,
      project,
      comments: project.comments,
      parsedDirectives: [],
      parsedDiagnostics: [warnDiag, errorDiag],
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.demoteReason).toBe('d1');
    // Both diagnostics surface on the region's diagnostic list — the
    // user sees the broken-DSL cause alongside any older warnings.
    expect(verdict.diagnostics).toContainEqual(warnDiag);
    expect(verdict.diagnostics).toContainEqual(errorDiag);
  });
});

/**
 * §Phase 2 (15.2) — the region-verdict pipeline must propagate parser
 * diagnostics into `blockSubset.diagnostics` and avoid double-counting
 * them on the final `RegionVerdict.diagnostics`.
 */
describe('buildRegionVerdicts: parser diagnostics propagation (Phase 2 §15.2)', () => {
  it('folds parser diagnostics into blockSubset.diagnostics and does not double-count', () => {
    // Trigger a parser `severity: 'warn'` diagnostic via an unknown
    // directive head. We can't synthesise a `severity: 'error'`
    // diagnostic from the public parser surface in 15.2 alone (that's
    // wired up by 15.3's `@max` removal) — this test asserts the
    // warn-only path which is the more subtle half: the diagnostics must
    // reach the final RegionVerdict exactly once.
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      // `@bogus foo` triggers the unknown-directive diagnostic at warn severity.
      { id: 'cmt1', text: '@compute\n@bogus foo\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    const { verdicts } = buildRegionVerdicts({ parsedProject: project, regions });
    expect(verdicts).toHaveLength(1);
    const verdict = verdicts[0]!;
    const dslSyntax = verdict.diagnostics.filter(
      (d) => d.code === 'gpu.dsl_syntax_error' && d.message.includes('@bogus'),
    );
    expect(dslSyntax).toHaveLength(1);
    // The same diagnostic must also surface through blockSubset.diagnostics
    // (single source of truth for parser-derived entries).
    const inBlockSubset = verdict.blockSubset.diagnostics.filter(
      (d) => d.code === 'gpu.dsl_syntax_error' && d.message.includes('@bogus'),
    );
    expect(inBlockSubset).toHaveLength(1);
  });

  it('keeps the region valid when parser diagnostics are warn-only (non-PARSER_ERROR_CODES code)', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    // §Phase 3 — `gpu.dsl_syntax_error` now demotes via
    // `PARSER_ERROR_CODES`. Use the `@bogus` path that still emits a
    // warn-severity `gpu.dsl_syntax_error` — under the new filter it
    // demotes. To exercise the truly warn-only path, we no longer have
    // a public parser surface that emits a non-PARSER_ERROR_CODES warn
    // diagnostic in this build, so we drive the pipeline with an empty
    // parser-error stream and assert the demote stays off.
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    const { verdicts } = buildRegionVerdicts({ parsedProject: project, regions });
    expect(verdicts[0]!.blockSubset.valid).toBe(true);
  });
});

/**
 * §Phase 5 §15.9 — extraction-side diagnostics (e.g.
 * `gpu.multiple_compute_regions`) must fold into the surviving
 * region's `RegionVerdict.diagnostics` without double-counting, and
 * unmatched extraction diagnostics must surface on the pipeline's
 * returned `extractionDiagnostics` list for the player bootstrap to
 * forward.
 */
describe('buildRegionVerdicts: extraction diagnostics forwarding (Phase 5 §15.9)', () => {
  it('folds a gpu.multiple_compute_regions diagnostic into the adopted region', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);
    const region = regions[0]!;

    const errorDiag: Diagnostic = {
      severity: 'error',
      code: 'gpu.multiple_compute_regions',
      regionId: region.regionId,
      blockId: region.blockId,
      message: 'Multiple @compute markers found',
    };
    const { verdicts, extractionDiagnostics } = buildRegionVerdicts({
      parsedProject: project,
      regions,
      extractionDiagnostics: [errorDiag],
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.diagnostics).toContainEqual(errorDiag);
    // The diagnostic was consumed by the fold, so the orphan list is empty.
    expect(extractionDiagnostics).toEqual([]);
  });

  it('returns unmatched extraction diagnostics in extractionDiagnostics', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'repeat0' },
    ]);
    const { regions } = extractRegions(project);

    const orphan: Diagnostic = {
      severity: 'warn',
      code: 'gpu.sprite_level_warning',
      // regionId points at a region that is NOT in the input set, so
      // the fold cannot attach it.
      regionId: 'region:sprite1:phantom',
      blockId: 'phantom',
      message: 'unforwarded warning',
    };
    const { verdicts, extractionDiagnostics } = buildRegionVerdicts({
      parsedProject: project,
      regions,
      extractionDiagnostics: [orphan],
    });
    expect(verdicts).toHaveLength(1);
    // No fold happened because the regionId is unknown.
    expect(verdicts[0]!.diagnostics).not.toContainEqual(orphan);
    expect(extractionDiagnostics).toEqual([orphan]);
  });

  it('does not double-count extraction diagnostics across multiple verdicts', () => {
    // Two adopted regions across TWO sprites (each sprite promotes its
    // first @compute marker to a region without the duplicate-merge
    // path). The extraction diagnostic only attaches to the matching
    // region; the other region's diagnostic list is untouched.
    const repeatA = mkBlock('repeatA', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const a = mkBlock('a', 'data_setvariableto');
    const repeatB = mkBlock('repeatB', 'control_repeat', { inputs: { SUBSTACK: 'b' } });
    const b = mkBlock('b', 'data_setvariableto');
    // Inlined multi-sprite `ParsedProject` because the local `mkProject`
    // helper is pinned to a single sprite. Region-extractor's
    // duplicate-merge only fires inside a single sprite, so splitting
    // across sprites is the cleanest way to exercise the
    // "two adopted regions, one fold target" shape.
    const project: ParsedProject = {
      targets: [
        {
          id: 'spriteA',
          isStage: false,
          blocks: { repeatA, a },
        },
        {
          id: 'spriteB',
          isStage: false,
          blocks: { repeatB, b },
        },
      ],
      comments: {
        cmtA: { text: '@compute\n', blockId: 'repeatA' },
        cmtB: { text: '@compute\n', blockId: 'repeatB' },
      },
    };
    const { regions } = extractRegions(project);
    expect(regions).toHaveLength(2);
    const targetRegion = regions.find((r) => r.blockId === 'repeatA');
    if (!targetRegion) throw new Error('expected repeatA region');
    const foldable: Diagnostic = {
      severity: 'warn',
      code: 'gpu.foo',
      regionId: targetRegion.regionId,
      blockId: targetRegion.blockId,
      message: 'attached once',
    };
    const { verdicts } = buildRegionVerdicts({
      parsedProject: project,
      regions,
      extractionDiagnostics: [foldable],
    });
    expect(verdicts).toHaveLength(2);
    const matching = verdicts.find((v) => v.regionId === targetRegion.regionId);
    const other = verdicts.find((v) => v.regionId !== targetRegion.regionId);
    expect(matching, 'matching region verdict should exist').toBeDefined();
    expect(other, 'other region verdict should exist').toBeDefined();
    expect(matching!.diagnostics.filter((d) => d === foldable)).toHaveLength(1);
    expect(other!.diagnostics).not.toContainEqual(foldable);
  });

  it('collectRegionVerdictsFromArrayBuffer adopts both regions and emits no diagnostic for distinct control_repeats (§Phase 3)', () => {
    const a = mkBlock('a', 'data_setvariableto');
    const r1 = mkBlock('r1', 'control_repeat', { inputs: { SUBSTACK: 'a' } });
    const c = mkBlock('c', 'data_setvariableto');
    const r2 = mkBlock('r2', 'control_repeat', { inputs: { SUBSTACK: 'c' } });
    const project = mkProject([r1, a, r2, c], [
      { id: 'cmt1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'r1' },
      { id: 'cmt2', text: '@compute\n@bind tmp1(1) ro\n', blockId: 'r2' },
    ]);
    const { verdicts, extractionDiagnostics } =
      collectRegionVerdictsFromArrayBuffer(project);
    // §Phase 3 — two distinct control_repeats each with their own
    // @compute marker → 2 regions adopted. No MULTIPLE_COMPUTE_REGIONS,
    // no KERNEL_CONTAINER_COLLISION.
    expect(verdicts).toHaveLength(2);
    expect(extractionDiagnostics).toEqual([]);
    for (const v of verdicts) {
      const colliding = v.diagnostics.find(
        (d) =>
          d.code === 'gpu.multiple_compute_regions' ||
          d.code === 'gpu.kernel_container_collision',
      );
      expect(colliding, `verdict ${v.regionId} should carry no collision diagnostic`).toBeUndefined();
    }
  });

  it('§Phase 4 — two Form A regions with distinct kernel containers both survive (no KERNEL_CONTAINER_COLLISION)', () => {
    // Layout (Phase 4 Form A): each `@compute` marker sits on its own
    // `control_repeat` (= kernel container). There is no shared
    // ancestor-promote path; the Phase 3 `KERNEL_CONTAINER_COLLISION`
    // concept is gone (each region owns a distinct kernel container
    // from the start). We pin this invariant here so a future
    // accidental reintroduction is caught.
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
    const kc = mkBlock('kc', 'control_repeat', { inputs: { SUBSTACK: 'inner1' } });
    const project = mkProject([kc, inner1, inner1Body, inner2, inner2Body], [
      { id: 'cmt_inner1', text: '@compute\n@bind tmp0(0) ro\n', blockId: 'inner1' },
      { id: 'cmt_inner2', text: '@compute\n@bind tmp1(1) ro\n', blockId: 'inner2' },
    ]);
    const { verdicts, extractionDiagnostics } =
      collectRegionVerdictsFromArrayBuffer(project);
    // Both regions adopted: inner1 and inner2 each carry their own
    // @compute marker on a distinct control_repeat (= kernel container).
    expect(verdicts).toHaveLength(2);
    const containerIds = verdicts.map((v) => v.kernelContainerBlockId).sort();
    expect(containerIds).toEqual(['inner1', 'inner2']);
    // The KERNEL_CONTAINER_COLLISION diagnostic was retired in Phase 4.
    const kcDiag = verdicts.flatMap((v) => v.diagnostics).find(
      (d) => d.code === 'gpu.kernel_container_collision',
    );
    expect(kcDiag).toBeUndefined();
    expect(extractionDiagnostics).toEqual([]);
  });
});
