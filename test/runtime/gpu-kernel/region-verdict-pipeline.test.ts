import { describe, expect, it } from 'vitest';
import { buildBlockSubsetVerdict } from '@/runtime/gpu-kernel/block-subset';
import { extractRegions } from '@/runtime/gpu-kernel/region-extractor';
import { buildRegionVerdicts } from '@/runtime/gpu-kernel/region-verdict-pipeline';
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
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
    ]);
    const { regions } = extractRegions(project);
    const region = regions[0]!;

    const errorDiag: Diagnostic = {
      severity: 'error',
      code: 'gpu.dsl_syntax_error',
      message: '@max is removed in v9; use runtime list length instead',
      regionId: region.regionId,
      blockId: 'a',
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

  it('keeps the region valid when parser diagnostics are warn-only', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
    ]);
    const { regions } = extractRegions(project);
    const region = regions[0]!;

    const warnDiag: Diagnostic = {
      severity: 'warn',
      code: 'gpu.dsl_syntax_error',
      message: 'malformed @bind: expected ...',
      regionId: region.regionId,
      blockId: 'a',
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

  it('folds mixed severities and demotes when at least one is error', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n', blockId: 'a' },
    ]);
    const { regions } = extractRegions(project);
    const region = regions[0]!;

    const warnDiag: Diagnostic = {
      severity: 'warn',
      code: 'gpu.dsl_syntax_error',
      message: 'unknown directive',
      regionId: region.regionId,
      blockId: 'a',
      line: 0,
      column: 0,
    };
    const errorDiag: Diagnostic = {
      severity: 'error',
      code: 'gpu.dsl_syntax_error',
      message: '@max is removed in v9',
      regionId: region.regionId,
      blockId: 'a',
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
      { id: 'cmt1', text: '@compute\n@bogus foo\n', blockId: 'a' },
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

  it('keeps the region valid when parser diagnostics are warn-only', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      { id: 'cmt1', text: '@compute\n@bogus foo\n', blockId: 'a' },
    ]);
    const { regions } = extractRegions(project);
    const { verdicts } = buildRegionVerdicts({ parsedProject: project, regions });
    expect(verdicts[0]!.blockSubset.valid).toBe(true);
  });
});
