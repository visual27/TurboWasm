/**
 * D1 demote classifier for region bodies.
 *
 * D1 (spec §4.1) rules:
 *
 *   - An unsupported opcode is in the body → region-level D1.
 *   - A nested @compute region (inner `control_repeat` carrying an
 *     `@compute` comment) is reachable inside the body → outer D1.
 *   - A `control_repeat_until`, `control_while`, or `control_forever` is
 *     reachable anywhere in the body → region-level D1.
 *
 * "Reachable" is determined by the region's `bodyBlockIds` plus a
 * recursive scan of `inputs.SUBSTACK / SUBSTACK2 / CONDITION` to catch
 * sub-stacks of nested control blocks. The block-subsetter operates on
 * the already-walked body, so nesting detection here is structural
 * (looking for inner `@compute` comments), not subtree-based.
 *
 * List-write opcodes
 * -------------------
 * `data_replaceitemoflist` is **deliberately allowed** — the WGSL
 * emitter emits a `scratch_list_write_f32(&name, idx, len, value)`
 * statement for it (wgsl-emitter.ts). Removing the listing here is
 * load-bearing for the GPU write-back path; without it, every list
 * write falls back to the JS path even when the project only uses
 * data_replaceitemoflist (which is the canonical Scratch 3.0 idiom
 * for `set <list> item <i> to <value>`).
 *
 * Other list mutations (`data_addtolist`, `data_deleteoflist`,
 * `data_insertatlist`, `data_deletealloflist`,
 * `data_changevariableoflist`) touch the host list shape and are
 * still D1 demoted.
 *
 * §Phase 5 — `procedure_call`, `argument_reporter_string`, and
 * `argument_reporter_boolean` are no longer in the unsafe set. The
 * `procedure-inliner.ts` module expands `procedure_call` sites at
 * pre-parse time so the resulting body contains only D1-safe opcodes;
 * when the runtime gate (`advanced.customBlockInliningEnabled`) is off,
 * the upstream `bootstrapGpuKernels` flips them back into the unsafe
 * set for that one bootstrap pass (see `buildBlockSubsetVerdictWithUnsafe`).
 */

import {
  HOOK_OPCODE_KEYS,
  type BlockSubsetVerdict,
  type Diagnostic,
  type ExtractedRegion,
  type ParsedComment,
  type ParsedDirective,
  type ParsedProject,
  type RawBlock,
} from './types';
import { extractBlockReference } from './block-reference';
import { inlineProcedures } from './procedure-inliner';
import { collectIterationAdvancePatterns } from './iteration-advance-pattern';
import { collectIndirectAccessPatterns } from './indirect-access-pattern';
import { validateBoundBlockIds } from './bound-block-validator';
import { mergePatterns } from './pattern-merger';

const GPU_UNSAFE_OPCODES: ReadonlySet<string> = new Set([
  // Loops not allowed inside a region.
  'control_repeat_until',
  'control_while',
  'control_forever',

  // String / random / wait / stop (side-effectful or not data-parallel).
  'operator_random',
  'operator_join',
  'operator_letter_of',
  'operator_stringLength',
  'operator_stringContains',
  'operator_stringIndex',
  'data_stringindex',
  'data_stringlength',
  'data_stringcontains',
  'control_wait',
  'control_wait_until',
  'control_stop',
  'event_broadcast',
  'event_broadcastandwait',

  // Pen + sound + sensing layer side effects.
  'pen_penDown',
  'pen_penUp',
  'pen_clear',
  'pen_stamp',
  'pen_changePenHueByParam',
  'pen_changePenParamBy',
  'pen_setPenColorToColor',
  'pen_setPenParamTo',
  'pen_changePenSizeBy',
  'pen_setPenSizeTo',
  'sound_play',
  'sound_playUntilDone',
  'sound_stopAllSounds',
  'sensing_username',
  'sensing_usernameId',
  'sensing_daysSince2000',
  'sensing_current',
  'sensing_loudness',
  'sensing_touchingobject',
  'sensing_touchingcolor',
  'sensing_coloristouchingcolor',
  'sensing_distanceto',
  'sensing_timer',
  'sensing_resettimer',
  'sensing_of',
  'sensing_mousex',
  'sensing_mousey',
  'sensing_mousedown',
  'sensing_keypressed',
  'sensing_setdragmode',

  // List mutations that touch the host (resize / append / insert /
  // delete). `data_replaceitemoflist` is intentionally absent — it
  // becomes `scratch_list_write_f32` in the WGSL emitter (see
  // emitListWrite in wgsl-emitter.ts).
  'data_addtolist',
  'data_deleteoflist',
  'data_insertatlist',
  'data_deletealloflist',
  'data_changevariableoflist',
]);

/**
 * §Phase 5 — opcodes that the `procedure-inliner.ts` would expand on
 * a successful inlining pass. When the user gates inlining off
 * (`advanced.customBlockInliningEnabled === false`), these opcodes must
 * surface as D1-unsafe again so the region demotes and falls back to
 * the JS path. Used by `buildBlockSubsetVerdictWithUnsafe` (see below).
 */
const INLINER_OPCODES: readonly string[] = [
  'procedure_call',
  'argument_reporter_string',
  'argument_reporter_boolean',
];

/**
 * §Phase 3 (gpu-kernel-dsl-phase3-spec §3.3) — diagnostic codes whose
 * presence on a region's diagnostic list forces a D1 demote regardless
 * of the `severity` field. Used to wire post-parser validation into the
 * demote path without inventing a new severity channel.
 *
 * Currently:
 *   - `gpu.dsl_syntax_error`: emitted by the parser for malformed
 *     directive syntax (and the @max removal in §15.3). Severity is
 *     `'error'` for hard-syntax cases and `'warn'` for shape-only
 *     warnings — both routes use this set so the region demotes on
 *     any breaking directive.
 *   - `gpu.max_removed`: Phase 2 (15.3) — backward-compat alias for the
 *     `@max` removal path. Kept in this set so old diagnostic payloads
 *     surface as D1 demotes without a refactor.
 *   - `gpu.multiple_compute_regions`: region-extractor emits this when
 *     a single block carries multiple `@compute` markers (Phase 3).
 *   - `gpu.bind_slot_collision`: emitted by the region-verdict pipeline
 *     when two `@bind` directives inside the same region claim the
 *     same `@group(0) @binding(N)` slot index.
 *
 * Codes that are emitted at `severity: 'warn'` only (`gpu.kc_container_collision`,
 * `gpu.regional_buffer_memory_pressure`, `gpu.implicit_axis_unsupported`,
 * `gpu.bound_block_not_found`, `gpu.axis_auto_detected`) are NOT in this
 * set — they must keep the existing `'severity === 'error''` filter
 * behaviour so a warn does not accidentally demote the region.
 */
export const PARSER_ERROR_CODES: ReadonlySet<string> = new Set([
  'gpu.dsl_syntax_error',
  'gpu.max_removed',
  'gpu.multiple_compute_regions',
  'gpu.bind_slot_collision',
  // §Phase 4 — repeat-path RESOLUTION errors from
  // `repeat-path-resolver.ts` (path-not-found / path-duplicate). The
  // parser-emitted `repeat_path_invalid` (malformed DSL attribute)
  // also routes through here because the owning region can never
  // recover from a malformed `repeatPath=...` suffix. The RESOLVER-emitted
  // `repeat_path_required` (no self-directive) is intentionally NOT in
  // the fatal set — regions with no `@repeat` directive at all still
  // work via the emitter's `emitTimesFromScratch` fallback that reads
  // `inputs.TIMES` from the kernel container.
  'gpu.repeat_path_invalid',
  'gpu.repeat_path_not_found',
  'gpu.repeat_path_duplicate',
  // §Phase 6 — auto-tmp detector collision / cycle errors. Both
  // surface as D1 demotes via this set so the region falls back to
  // the JS path without inventing a new severity channel.
  'gpu.scratch_variable_collision',
  'gpu.scratch_variable_cycle',
]);

export interface ClassifyBlockSubsetInput {
  region: ExtractedRegion;
  project: ParsedProject;
  /** Map of commentId → ParsedComment for nested-region detection. */
  comments: Record<string, ParsedComment>;
  /**
   * §Phase 5 — overrides `region.bodyBlockIds` for the body-walk step.
   * Used by `buildBlockSubsetVerdict` after `procedure-inliner` has
   * expanded the body. Defaults to `region.bodyBlockIds`.
   */
  bodyBlockIds?: readonly string[];
}

/**
 * Pure D1 verdict. `valid: false` means the region falls back to the JS
 * path (cascade into M5).
 *
 * Phase 1: 既存 API は後方互換のため維持。`effectivePatterns` は空配列
 * (= `[]`) を返す。`buildBlockSubsetVerdict` 経由でのみ pattern 抽出が
 * 走る。
 */
export function classifyBlockSubset(
  input: ClassifyBlockSubsetInput,
): BlockSubsetVerdict {
  return classifyD1Only(input);
}

/**
 * Phase 1: D1 verdict + pattern 抽出 (`effectivePatterns`) を一度に行う
 * orchestrator。`region-verdict-pipeline.ts:buildRegionVerdicts` から呼ばれる
 * 正規エントリ。
 *
 * §Phase 2 (15.2): parser 由来の diagnostics を `parsedDiagnostics`
 * で受け取り、`blockSubset.diagnostics` に連結する。`severity === 'error'`
 * の diagnostic が 1 件でも含まれる region は D1 demote
 * (`valid: false`, `demoteReason: 'd1'`) として返却する。warn severity
 * は後方互換のため `valid: true` を維持 (= 既存挙動)。
 *
 * §Phase 5: when `inliningEnabled === false`, the call site opts out
 * of the procedure-inliner (`advanced.customBlockInliningEnabled` user
 * toggle) and `procedure_call` / `argument_reporter_*` are temporarily
 * added back to the unsafe-opcode set. The body walk then surfaces
 * a D1 demote on the first such opcode, falling back to JS as before
 * Phase 5.
 */
export interface BuildBlockSubsetVerdictInput {
  region: ExtractedRegion;
  project: ParsedProject;
  comments: Record<string, ParsedComment>;
  parsedDirectives: readonly ParsedDirective[];
  /**
   * §Phase 2 (15.2) — diagnostics from `parseComputeComment`. Defaults
   * to `[]` for callers that don't have the parser surface (legacy unit
   * tests); `buildRegionVerdicts` always passes the live parser output.
   * A `severity: 'error'` entry demotes the region to D1.
   */
  parsedDiagnostics?: readonly Diagnostic[];
  /**
   * §Phase 5 — when `false`, the `procedure-inliner` is skipped and
   * `procedure_call` / `argument_reporter_*` are treated as D1-unsafe.
   * Defaults to `true` so existing callers (which have always lived
   * in the inlining-enabled world since this was added) keep working.
   * `bootstrapGpuKernels` passes the user's `customBlockInliningEnabled`
   * preference; legacy unit tests rely on the default `true` so the
   * `procedure-inliner.test.ts` style cases continue to pass without
   * exposing the gate at every test site.
   */
  inliningEnabled?: boolean;
}

export function buildBlockSubsetVerdict(
  input: BuildBlockSubsetVerdictInput,
): BlockSubsetVerdict {
  const { region, project, comments, parsedDirectives } = input;
  const parsedDiagnostics: readonly Diagnostic[] = input.parsedDiagnostics ?? [];
  const inliningEnabled = input.inliningEnabled ?? true;

  // §Phase 5 §5.2 — opt-out path. The user has disabled custom-block
  // inlining; we re-introduce `procedure_call` /
  // `argument_reporter_*` as D1-unsafe for this verdict so the region
  // demotes to the JS path.
  if (!inliningEnabled) {
    return buildBlockSubsetVerdictWithUnsafe(input, [...INLINER_OPCODES]);
  }

  // §Phase 5 §5.2 — inlining enabled. Run `procedure-inliner` against
  // the region's body and use the inlined body for D1 classification.
  // Inliner errors (`PROCEDURE_RECURSION_UNSUPPORTED`,
  // `PROCEDURE_PROTOTYPE_NOT_FOUND`) are folded into the diagnostic
  // list and force a D1 demote via the same parser-error channel.
  const inlined = inlineProcedures(region, project, region.spriteId);
  const inliningErrorDiagnostics = inlined.diagnostics.filter(
    (d) => d.severity === 'error',
  );
  if (inliningErrorDiagnostics.length > 0) {
    return {
      valid: false,
      demoteReason: 'd1',
      diagnostics: [...parsedDiagnostics, ...inlined.diagnostics],
      effectivePatterns: [],
    };
  }

  const base = classifyD1Only({ region, project, comments, bodyBlockIds: inlined.bodyBlockIds });

  // §Phase 2 (15.2): parser-error demote precedes D1 demote so the user
  // sees the broken-DSL diagnostic first (= the more actionable root
  // cause). When neither fires we proceed to Phase 1 pattern extraction.
  //
  // §Phase 3 (gpu-kernel-dsl-phase3-spec §3.3) — widen the trigger to
  // also include any diagnostic whose `code` is in `PARSER_ERROR_CODES`
  // (notably `gpu.bind_slot_collision`, emitted by
  // `region-verdict-pipeline.ts`). This makes the demote route
  // code-driven rather than purely severity-driven so future error-coded
  // diagnostics from M3 — M5 can land in this single demote path.
  const parserErrorDiagnostics = parsedDiagnostics.filter(
    (d) => d.severity === 'error' || PARSER_ERROR_CODES.has(d.code),
  );
  if (parserErrorDiagnostics.length > 0) {
    return {
      valid: false,
      demoteReason: 'd1',
      diagnostics: [...base.diagnostics, ...parsedDiagnostics, ...inlined.diagnostics],
      effectivePatterns: [],
    };
  }

  if (!base.valid) {
    // Preserve the existing D1-only return shape but include the warn-only
    // parser + inliner diagnostics so the user can still see them on
    // the ErrorLogPanel.
    return {
      ...base,
      diagnostics: [...base.diagnostics, ...parsedDiagnostics, ...inlined.diagnostics],
      effectivePatterns: [],
    };
  }

  const blockMap = collectAllBlocks(project);
  const iterResult = collectIterationAdvancePatterns(
    blockMap,
    inlined.bodyBlockIds,
    parsedDirectives,
  );
  const indirectResult = collectIndirectAccessPatterns(
    blockMap,
    inlined.bodyBlockIds,
    parsedDirectives,
  );
  const validationDiagnostics = validateBoundBlockIds(parsedDirectives, inlined.bodyBlockIds);

  const merged = mergePatterns(iterResult.patterns, indirectResult.patterns, base);

  return {
    ...base,
    effectivePatterns: merged.effective,
    diagnostics: [
      ...base.diagnostics,
      ...parsedDiagnostics,
      ...inlined.diagnostics,
      ...iterResult.diagnostics,
      ...indirectResult.diagnostics,
      ...validationDiagnostics,
      ...merged.diagnostics,
    ],
  };
}

/**
 * §Phase 5 §5.2 — internal helper. Re-evaluates the body when an
 * extra set of unsafe opcodes must be treated as D1-demoting (used
 * when inlining is opted out). `UNSAFE_OPCODES_EXTRA` is appended to
 * `GPU_UNSAFE_OPCODES` for the duration of the classification.
 *
 * Kept module-private because the public `buildBlockSubsetVerdict`
 * already encodes the opt-out decision; callers outside this file
 * should use the main entry with `inliningEnabled: false`.
 */
function buildBlockSubsetVerdictWithUnsafe(
  input: BuildBlockSubsetVerdictInput,
  unsafeOpcodesExtra: readonly string[],
): BlockSubsetVerdict {
  const { region, project, comments, parsedDirectives } = input;
  const parsedDiagnostics: readonly Diagnostic[] = input.parsedDiagnostics ?? [];
  // We do not run the inliner at all on the opt-out path so the
  // `procedure_call` block survives in the body and trips the
  // unsafe-opcode check inside `classifyD1OnlyWithUnsafe`.
  const base = classifyD1OnlyWithUnsafe(
    { region, project, comments },
    unsafeOpcodesExtra,
  );
  const parserErrorDiagnostics = parsedDiagnostics.filter(
    (d) => d.severity === 'error' || PARSER_ERROR_CODES.has(d.code),
  );
  if (parserErrorDiagnostics.length > 0) {
    return {
      valid: false,
      demoteReason: 'd1',
      diagnostics: [...base.diagnostics, ...parsedDiagnostics],
      effectivePatterns: [],
    };
  }
  if (!base.valid) {
    return {
      ...base,
      diagnostics: [...base.diagnostics, ...parsedDiagnostics],
      effectivePatterns: [],
    };
  }
  const blockMap = collectAllBlocks(project);
  const iterResult = collectIterationAdvancePatterns(
    blockMap,
    region.bodyBlockIds,
    parsedDirectives,
  );
  const indirectResult = collectIndirectAccessPatterns(
    blockMap,
    region.bodyBlockIds,
    parsedDirectives,
  );
  const validationDiagnostics = validateBoundBlockIds(parsedDirectives, region.bodyBlockIds);
  const merged = mergePatterns(iterResult.patterns, indirectResult.patterns, base);
  return {
    ...base,
    effectivePatterns: merged.effective,
    diagnostics: [
      ...base.diagnostics,
      ...parsedDiagnostics,
      ...iterResult.diagnostics,
      ...indirectResult.diagnostics,
      ...validationDiagnostics,
      ...merged.diagnostics,
    ],
  };
}

/**
 * Internal: D1 demote 判定のみ。`buildBlockSubsetVerdict` と
 * `classifyBlockSubset` (後方互換) から呼ばれる pure helper。
 */
function classifyD1Only(input: ClassifyBlockSubsetInput): BlockSubsetVerdict {
  return classifyD1OnlyWithUnsafe(input, []);
}

/**
 * §Phase 5 — opt-out internal: same as `classifyD1Only` but with an
 * extra set of opcodes treated as D1-unsafe. Used by the
 * `inliningEnabled === false` branch so `procedure_call` /
 * `argument_reporter_*` trip the D1 demote when the user explicitly
 * disabled custom-block inlining.
 */
function classifyD1OnlyWithUnsafe(
  input: ClassifyBlockSubsetInput,
  extraUnsafe: readonly string[],
): BlockSubsetVerdict {
  const { region, project } = input;
  const diagnostics: Diagnostic[] = [];
  const bodyIds = input.bodyBlockIds ?? region.bodyBlockIds;
  const unsafeSet =
    extraUnsafe.length === 0
      ? GPU_UNSAFE_OPCODES
      : new Set<string>([...GPU_UNSAFE_OPCODES, ...extraUnsafe]);

  const bodyBlocks = collectReachableBlocks(project, bodyIds);

  for (const block of bodyBlocks) {
    if (unsafeSet.has(block.opcode)) {
      const diag: Diagnostic = {
        severity: 'warn',
        code: 'd1.region_demoted',
        message: `region '${region.regionId}' contains unsupported opcode '${block.opcode}' (D1 demote, falling back to JS)`,
        regionId: region.regionId,
        blockId: region.blockId,
      };
      return { valid: false, demoteReason: 'd1', diagnostics: [diag], effectivePatterns: [] };
    }
  }

  for (const block of bodyBlocks) {
    if (block.opcode !== 'control_repeat') continue;
    const subId = readSubstackId(block);
    if (!subId) continue;
    const inner = findBlock(project, subId);
    if (!inner) continue;
    const innerComment = findCommentByBlockId(input.comments, inner.id);
    if (innerComment && innerComment.text.trim().startsWith('@compute')) {
      const diag: Diagnostic = {
        severity: 'warn',
        code: 'd1.region_demoted',
        message: `region '${region.regionId}' contains a nested @compute region (D1 demote, falling back to JS)`,
        regionId: region.regionId,
        blockId: region.blockId,
      };
      return { valid: false, demoteReason: 'd1', diagnostics: [diag], effectivePatterns: [] };
    }
  }

  return { valid: true, diagnostics, effectivePatterns: [] };
}

function collectReachableBlocks(project: ParsedProject, bodyBlockIds: readonly string[]): RawBlock[] {
  const bodyBlocks: RawBlock[] = [];
  const visited = new Set<string>();
  const queue: string[] = [...bodyBlockIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const block = findBlock(project, id);
    if (!block) continue;
    bodyBlocks.push(block);
    if (typeof block.next === 'string') queue.push(block.next);
    // §Phase 1: route every hook (SUBSTACK / SUBSTACK2 / CONDITION)
    // through `extractBlockReference` so the union of accept-shapes is
    // shared with `region-extractor.ts` and `axis-analysis.ts`.
    for (const key of HOOK_OPCODE_KEYS) {
      const refId = extractBlockReference(block.inputs[key]);
      if (refId) queue.push(refId);
    }
  }
  return bodyBlocks;
}

function collectAllBlocks(project: ParsedProject): Record<string, RawBlock> {
  const out: Record<string, RawBlock> = {};
  for (const target of project.targets) {
    for (const [id, block] of Object.entries(target.blocks)) {
      if (block) out[id] = block;
    }
  }
  return out;
}

function findBlock(project: ParsedProject, id: string): RawBlock | undefined {
  for (const target of project.targets) {
    const b = target.blocks[id];
    if (b) return b;
  }
  return undefined;
}

/**
 * §Phase 1: SUBSTACK id extraction is a thin wrapper around the shared
 * `extractBlockReference` helper so all callers across the gpu-kernel
 * pipeline accept the same union of shapes.
 */
function readSubstackId(block: RawBlock): string | null {
  return extractBlockReference(block.inputs['SUBSTACK']);
}

function findCommentByBlockId(
  comments: Record<string, ParsedComment>,
  blockId: string,
): ParsedComment | undefined {
  for (const c of Object.values(comments)) {
    if (c && c.blockId === blockId) return c;
  }
  return undefined;
}
