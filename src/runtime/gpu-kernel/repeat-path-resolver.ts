/**
 * §Phase 4 (gpu-kernel-dsl-phase4-spec §4.4) — resolve user-authored
 * `repeatPath="..."` strings onto concrete `control_repeat` block ids.
 *
 * The resolver runs between the comment parser and the block-subsetter
 * in `region-verdict-pipeline.ts`. Each `@repeat` becomes a
 * `ResolvedRepeatDirective` with `resolvedRepeatBlockId` populated.
 * Diagnostics emitted here are folded into the parser-error D1 demote
 * path through `PARSER_ERROR_CODES` (`block-subset.ts`).
 *
 * Validation rules:
 *   - `repeatPath === 'self'` ⇒ kernel container.
 *   - Numeric path ⇒ resolved through `ExtractedRegion.repeatPathTable`.
 *   - Missing path in table ⇒ `gpu.repeat_path_not_found` error.
 *   - Duplicate `repeatPath` within the same region ⇒
 *     `gpu.repeat_path_duplicate` error.
 *   - Duplicate `resolvedRepeatBlockId` within the same region ⇒
 *     `gpu.repeat_path_duplicate` error (one block cannot own two
 *     parallel axes from one `@compute` region).
 *   - The kernel container MUST have exactly one `repeatPath="self"`
 *     `@repeat` (one self directive). Missing ⇒ error.
 *
 * The function is pure: it does not mutate the input directives or the
 * parsed project. It also does not mutate the input region.
 */

import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import type {
  Diagnostic,
  ExtractedRegion,
  ParsedDirective,
  RepeatDirective,
  ResolvedParsedDirective,
  ResolvedRepeatDirective,
} from './types';

export interface ResolveRepeatPathsResult {
  directives: ResolvedParsedDirective[];
  diagnostics: Diagnostic[];
}

/**
 * Resolve every `@repeat` directive inside `region` against the region's
 * `repeatPathTable`. Non-`@repeat` directives pass through unchanged.
 */
export function resolveRepeatPaths(
  region: ExtractedRegion,
  directives: readonly ParsedDirective[],
): ResolveRepeatPathsResult {
  const result: ResolvedParsedDirective[] = [];
  const diagnostics: Diagnostic[] = [];

  const selfDirectives: RepeatDirective[] = [];
  const usedPaths = new Map<string, ResolvedRepeatDirective>();
  const usedBlockIds = new Map<string, ResolvedRepeatDirective>();

  for (const directive of directives) {
    if (directive.kind !== 'repeat') {
      result.push(directive);
      continue;
    }

    const repeatPath = directive.repeatPath;
    let resolvedId: string | undefined;

    if (repeatPath === 'self') {
      resolvedId = region.kernelContainerBlockId;
      selfDirectives.push(directive);
    } else {
      resolvedId = region.repeatPathTable[repeatPath];
      if (!resolvedId) {
        diagnostics.push({
          severity: 'error',
          code: GPU_DIAGNOSTIC_CODES.REPEAT_PATH_NOT_FOUND,
          regionId: region.regionId,
          blockId: region.blockId,
          message: `repeatPath '${repeatPath}' does not resolve to any control_repeat in region '${region.regionId}'`,
          line: directive.line,
          column: directive.column,
        });
        continue;
      }
    }

    if (usedPaths.has(repeatPath)) {
      diagnostics.push({
        severity: 'error',
        code: GPU_DIAGNOSTIC_CODES.REPEAT_PATH_DUPLICATE,
        regionId: region.regionId,
        blockId: region.blockId,
        message: `repeatPath '${repeatPath}' is used more than once in region '${region.regionId}'`,
        line: directive.line,
        column: directive.column,
      });
      continue;
    }
    if (usedBlockIds.has(resolvedId)) {
      diagnostics.push({
        severity: 'error',
        code: GPU_DIAGNOSTIC_CODES.REPEAT_PATH_DUPLICATE,
        regionId: region.regionId,
        blockId: region.blockId,
        message: `repeatPath '${repeatPath}' and an earlier directive both target control_repeat '${resolvedId}' in region '${region.regionId}'`,
        line: directive.line,
        column: directive.column,
      });
      continue;
    }

    const resolved: ResolvedRepeatDirective = {
      ...directive,
      resolvedRepeatBlockId: resolvedId,
    };
    usedPaths.set(repeatPath, resolved);
    usedBlockIds.set(resolvedId, resolved);
    result.push(resolved);
  }

  // §Phase 4: a kernel container with NO `@repeat` directive is
  // allowed — the emitter falls back to `inputs.TIMES` from the kernel
  // container (`emitTimesFromScratch`). The legacy `REPEAT_PATH_REQUIRED`
  // diagnostic was retired because the "the dispatch count is
  // undefined" argument only applies to nested layouts, which Phase 4
  // removed. We only emit `REPEAT_PATH_DUPLICATE` when the user
  // explicitly declared two `self` directives (= a real bug).
  if (selfDirectives.length > 1) {
    diagnostics.push({
      severity: 'error',
      code: GPU_DIAGNOSTIC_CODES.REPEAT_PATH_DUPLICATE,
      regionId: region.regionId,
      blockId: region.blockId,
      message: `region '${region.regionId}' has ${selfDirectives.length} @repeat directives with repeatPath="self"; only one is allowed`,
    });
  }

  return { directives: result, diagnostics };
}
