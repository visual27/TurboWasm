/**
 * Phase 1 (nested-parallelization-02-phase1 §3.5) — `boundBlockId`
 * validation helper.
 *
 * Phase 0 で `comment-parser.ts:parseRepeat` / `parseMap` が
 * `, blockId="<id>"` suffix を受理するようになった。Phase 1 では
 * 受理した id が region body に存在することを検証し、欠けていれば
 * `gpu.bound_block_not_found` (severity warn) を発火する。
 *
 * 発火条件:
 *   - `boundBlockId` が directive にある (= explicit bind 指定)
 *   - その id が `bodyBlockIds` に含まれない
 *
 * 発火しない条件:
 *   - `boundBlockId` が無い directive (auto-detect のみ)
 *   - `boundBlockId` があり body にも含まれる (正常)
 */

import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import type { Diagnostic, ParsedDirective } from './types';

export function validateBoundBlockIds(
  parsedDirectives: readonly ParsedDirective[],
  bodyBlockIds: readonly string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const bodySet = new Set(bodyBlockIds);

  for (const d of parsedDirectives) {
    if (d.kind !== 'repeat' && d.kind !== 'map') continue;
    if (!d.boundBlockId) continue;
    if (!bodySet.has(d.boundBlockId)) {
      diagnostics.push({
        severity: 'warn',
        code: GPU_DIAGNOSTIC_CODES.BOUND_BLOCK_NOT_FOUND,
        message:
          `boundBlockId="${d.boundBlockId}" not found in body ` +
          `(directive: @${d.kind} ${d.kind === 'repeat' ? d.name : d.var})`,
        blockId: d.boundBlockId,
        line: d.line,
        column: d.column,
      });
    }
  }

  return diagnostics;
}
