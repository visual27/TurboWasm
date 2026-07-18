/**
 * Phase 1 (nested-parallelization-02-phase1 §3.6) — explicit + auto-detected
 * pattern を precedence 規則で統合する helper。
 *
 * Precedence:
 *   1. explicit (`boundBlockId` で directive が指す block) は必ず採用。
 *   2. auto-detected で、同じ blockId を explicit が指している → auto-detected を drop。
 *   3. auto-detected はそのまま effective に登録。
 *   4. D1 で region が demote されている場合 (= `blockSubset.valid === false`)
 *      は patterns を全て drop (= effective は空配列)。
 *
 * 副作用として effective に残った auto-detected pattern に対し、
 * `gpu.axis_auto_detected` (severity info) を emit。`options.debug` (= default
 * `import.meta.env.DEV`) が truthy のときだけ実行されるので、production build
 * (= Vite が `import.meta.env.DEV` を `false` リテラルへ置換) では該当
 * ブロック全体が dead code 化され、ランタイムコストもバンドルサイズも 0。
 *
 * `useErrorLogStore` 側の `defaultMaxLogs=5` 超過で info は降格する既存
 * セマンティクス (§19.6 #14) はそのまま。
 */

import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import type {
  BlockSubsetVerdict,
  Diagnostic,
  EffectivePattern,
  IndirectAccessPattern,
  IterationAdvancePattern,
} from './types';

export interface PatternMergerResult {
  effective: EffectivePattern[];
  droppedAutoDetected: {
    pattern: IterationAdvancePattern | IndirectAccessPattern;
    reason: string;
  }[];
  diagnostics: Diagnostic[];
}

export interface PatternMergerOptions {
  /**
   * Whether to emit `gpu.axis_auto_detected` info diagnostics for
   * auto-detected patterns that survived the merge.
   *
   * Defaults to `import.meta.env.DEV` so that production builds (Vite
   * strips the expression to `false`) get a dead-code-eliminated block
   * with zero runtime / bundle cost. Vitest sets `NODE_ENV=test`, which
   * the Vite plugin maps to `DEV=true`, so the default behaviour there
   * preserves existing test assertions; tests that need to assert
   * production-mode silence pass `{ debug: false }` explicitly.
   */
  debug?: boolean;
}

export function mergePatterns(
  iterationPatterns: readonly IterationAdvancePattern[],
  indirectPatterns: readonly IndirectAccessPattern[],
  blockSubset: Pick<BlockSubsetVerdict, 'valid'>,
  options: PatternMergerOptions = {},
): PatternMergerResult {
  const effective: EffectivePattern[] = [];
  const droppedAutoDetected: PatternMergerResult['droppedAutoDetected'] = [];
  const diagnostics: Diagnostic[] = [];
  const debug = options.debug ?? import.meta.env.DEV;

  if (!blockSubset.valid) {
    return { effective, droppedAutoDetected, diagnostics };
  }

  const explicitBlockIds = new Set<string>();
  for (const p of [...iterationPatterns, ...indirectPatterns]) {
    if (p.source === 'explicit') explicitBlockIds.add(p.blockId);
  }

  for (const p of iterationPatterns) {
    if (p.source === 'explicit') {
      effective.push({ kind: 'iteration-advance', pattern: p });
      continue;
    }
    if (explicitBlockIds.has(p.blockId)) {
      droppedAutoDetected.push({
        pattern: p,
        reason: 'overridden by explicit boundBlockId',
      });
      continue;
    }
    effective.push({ kind: 'iteration-advance', pattern: p });
  }

  for (const p of indirectPatterns) {
    if (p.source === 'explicit') {
      effective.push({ kind: 'indirect-access', pattern: p });
      continue;
    }
    if (explicitBlockIds.has(p.blockId)) {
      droppedAutoDetected.push({
        pattern: p,
        reason: 'overridden by explicit boundBlockId',
      });
      continue;
    }
    effective.push({ kind: 'indirect-access', pattern: p });
  }

  if (debug) {
    for (const e of effective) {
      if (e.pattern.source === 'auto-detected') {
        diagnostics.push({
          severity: 'info',
          code: GPU_DIAGNOSTIC_CODES.AXIS_AUTO_DETECTED,
          message: `auto-detected ${e.kind} for blockId="${e.pattern.blockId}"`,
          blockId: e.pattern.blockId,
        });
      }
    }
  }

  return { effective, droppedAutoDetected, diagnostics };
}
