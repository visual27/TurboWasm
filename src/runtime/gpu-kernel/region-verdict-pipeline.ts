/**
 * Glue between M3 (parser + D1/D2/D3) and M5 (initializeGpuKernels).
 *
 * `loadProjectFromArrayBuffer` calls `collectRegionVerdictsFromArrayBuffer`
 * to drive the whole chain — parse project.json → walk blocks → emit
 * directives → classify block subset → analyze axes → cascade → return
 * a flat list of RegionVerdicts ready for the WGSL emitter.
 *
 * M3 was designed to take its inputs from arbitrary sources (so unit tests
 * can build tiny projects with hand-crafted blocks). M6 supplies a single
 * helper here that turns the vendored scratch-vm extraction layer into a
 * RegionVerdict list. This keeps M3 independent of how we obtain a project
 * and the M5 downstream free of plumbing.
 */

import {
  extractRegions,
} from './region-extractor';
import { buildBlockSubsetVerdict } from './block-subset';
import { parseComputeComment } from './comment-parser';
import { analyzeAxes } from './axis-analysis';
import { analyzeCascade } from './cascade-analysis';
import type {
  AxisFinal,
  Diagnostic,
  ExtractedRegion,
  ParsedComment,
  ParsedDirective,
  ParsedProject,
  RegionVerdict,
} from './types';

export interface RegionVerdictInputs {
  parsedProject: ParsedProject;
  /** `@compute`-marked regions discovered in `parsedProject`. */
  regions: ExtractedRegion[];
  /**
   * §Phase 5 §15.9 — diagnostics from the extraction step
   * (`extractRegions`) that did NOT match any region in `regions`.
   * Diagnostics that DO match a region by `regionId` are folded into
   * the corresponding `RegionVerdict.diagnostics` automatically.
   *
   * The orphan list is returned to the caller so
   * `bootstrapGpuKernels` can forward them to the ErrorLog without
   * losing the extraction-side diagnostics.
   */
  extractionDiagnostics?: readonly Diagnostic[];
}

export interface RegionVerdictOutputs {
  verdicts: RegionVerdict[];
  allDirectives: ParsedDirective[];
  /**
   * §Phase 5 §15.9 — extraction-side diagnostics whose `regionId`
   * did not match any adopted region. Empty when every extraction
   * diagnostic was attached to a surviving region.
   */
  extractionDiagnostics: Diagnostic[];
}

/**
 * Drive M3 end-to-end on every region and return a `RegionVerdict[]`
 * suitable for `initializeGpuKernels`. Diagnostics from each stage are
 * pushed into the returned `verdicts` so the caller can forward them to
 * `useErrorLogStore`. We also extract blockIds so apply-gpu-kernels
 * (M5) can install the lookup table directly.
 *
 * The function is synchronous by design: all M3 layers are pure
 * functions on the parsed project, and pre-compiling WGSL is itself
 * synchronous per spec §7 (Q14: `runtime dispatch はsync`).
 */
export function buildRegionVerdicts(input: RegionVerdictInputs): RegionVerdictOutputs {
  const verdicts: RegionVerdict[] = [];
  const allDirectives: ParsedDirective[] = [];
  // §Phase 5 §15.9 — partition the extraction-side diagnostics by
  // whether their `regionId` matches an adopted region. The matched
  // ones fold into `RegionVerdict.diagnostics`; the unmatched ones
  // are returned to the caller so the player can forward them
  // through the ErrorLog path.
  const matchedExtraction = new Map<string, Diagnostic[]>();
  const unmatchedExtraction: Diagnostic[] = [];
  const knownRegionIds = new Set(input.regions.map((r) => r.regionId));
  for (const d of input.extractionDiagnostics ?? []) {
    if (d.regionId && knownRegionIds.has(d.regionId)) {
      const bucket = matchedExtraction.get(d.regionId) ?? [];
      bucket.push(d);
      matchedExtraction.set(d.regionId, bucket);
    } else {
      unmatchedExtraction.push(d);
    }
  }
  for (const region of input.regions) {
    const comment = input.parsedProject.comments[region.commentId];
    if (!comment) continue;
    // 1. parse the comment text into directives.
    const parsed = parseComputeComment(comment, region.regionId);
    // 2. D1 + Phase 1 pattern extraction: `buildBlockSubsetVerdict` is
    // the canonical entry that combines the D1 verdict with the
    // auto-detected `effectivePatterns` (= skip-set for the WGSL emitter
    // in Phase 2). §Phase 1 (nested-parallelization-02-phase1 §3.7).
    //
    // §Phase 2 (15.2): parser diagnostics are folded into
    // `blockSubset.diagnostics` here so a `severity: 'error'` diagnostic
    // (e.g. the `@max` removal in §15.3) demotes the region to D1.
    const blockSubset = buildBlockSubsetVerdict({
      region,
      project: input.parsedProject,
      comments: input.parsedProject.comments,
      parsedDirectives: parsed.directives,
      parsedDiagnostics: parsed.diagnostics,
    });
    // 3. D2: per-axis verdict.
    const axesResult = analyzeAxes(region, parsed.directives, input.parsedProject);
    // 4. D3: cascade verdict (uses survived-axes set).
    const survivedAxes = new Set<string>();
    for (const [name, verdict] of Object.entries(axesResult.axes)) {
      if (verdict.finalAxis !== 'sequential') survivedAxes.add(name);
    }
    const cascade = analyzeCascade({
      region,
      directives: parsed.directives,
      project: input.parsedProject,
      survivedAxes,
    });

    const parallelAxes = collectParallelAxes(axesResult.axes);

    const diagnostics = [
      // §Phase 2 (15.2): `parsed.diagnostics` is already folded into
      // `blockSubset.diagnostics` by `buildBlockSubsetVerdict`, so it
      // must NOT be re-spread here (= would double-count parser
      // diagnostics on the ErrorLogPanel).
      ...blockSubset.diagnostics,
      ...axesResult.diagnostics,
      ...cascade.diagnostics,
      // §Phase 5 §15.9 — attach the extraction-side diagnostic (e.g.
      // `gpu.multiple_compute_regions`) to the adopted region's
      // diagnostic list. The player routes from `verdict.diagnostics`
      // so this is the natural place for the fold.
      ...(matchedExtraction.get(region.regionId) ?? []),
    ];

    for (const directive of parsed.directives) allDirectives.push(directive);

    verdicts.push({
      regionId: region.regionId,
      blockId: region.blockId,
      spriteId: region.spriteId,
      directives: parsed.directives,
      blockSubset,
      axes: axesResult.axes,
      cascade,
      diagnostics,
      parallelAxes,
      // Phase 2 (nested-parallelization-03-phase2): ExtractedRegion から
      // kernel container / nested repeats / firstSubstackBlockId を
      // RegionVerdict に伝搬。`implicitAxes` は emitRegion 入口で再計算
      // されるため、ここでは省略 (= undefined)。
      kernelContainerBlockId: region.kernelContainerBlockId,
      nestedRepeatContainerBlockIds: region.nestedRepeatContainerBlockIds,
      firstSubstackBlockId: region.firstSubstackBlockId,
    });
  }
  return { verdicts, allDirectives, extractionDiagnostics: unmatchedExtraction };
}

/**
 * Convenience: parse, extract, analyse — all in one call from
 * `loadProjectFromArrayBuffer` so the M6 wiring in player.ts stays
 * declarative. The first stage is the only place that touches the
 * vendored scratch-vm fields directly.
 *
 * §Phase 5 §15.9 — the returned `extractionDiagnostics` is the slice
 * of `extractRegions().diagnostics` that did not get folded into any
 * surviving `RegionVerdict.diagnostics`. Empty in the common case;
 * non-empty when a future extractor emits a sprite-wide diagnostic
 * (currently unused).
 */
export function collectRegionVerdictsFromArrayBuffer(
  parsedProject: ParsedProject,
): RegionVerdictOutputs {
  const { regions, diagnostics } = extractRegions(parsedProject);
  return buildRegionVerdicts({ parsedProject, regions, extractionDiagnostics: diagnostics });
}

function collectParallelAxes(
  axes: Record<string, { requestedAxis: AxisFinal; finalAxis: AxisFinal }>,
): { repeatName: string; axis: AxisFinal }[] {
  const out: { repeatName: string; axis: AxisFinal }[] = [];
  for (const [name, axis] of Object.entries(axes)) {
    if (axis.finalAxis !== 'sequential') {
      out.push({ repeatName: name, axis: axis.finalAxis });
    }
  }
  return out;
}

/**
 * Helper for M5's `applyGpuKernels`: re-key `parsedProject.comments` so
 * the M3 parser can find the right `ParsedComment` for each region.
 * The vendored scratch-vm represents `comments` as `{ id: { blockId, text } }`
 * — same shape `ParsedProject.comments` already has, so this is just a
 * coercion.
 */
export function asCommentMap(
  raw: Record<string, { blockId: string; text: string }> | undefined,
): Record<string, ParsedComment> {
  if (!raw) return {};
  const out: Record<string, ParsedComment> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!value) continue;
    if (typeof value.blockId !== 'string' || typeof value.text !== 'string') continue;
    out[id] = { blockId: value.blockId, text: value.text };
  }
  return out;
}
