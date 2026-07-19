/**
 * Phase 2 (nested-parallelization-03-phase2 §3.4) — WGSL emitter 入口の
 * skip-set フィルタ。
 *
 * Phase 1 で `BlockSubsetVerdict.effectivePatterns` に統合された
 * `IterationAdvancePattern` / `IndirectAccessPattern` (= read のみ) を
 * skip-set として参照し、emitter が対象 block を kernel body から除外する
 * かどうかを判定する。
 *
 * **不変条件**:
 *   - write 系の `data_replaceitemoflist` は actual parallel work なので
 *     skip-set には入らない (`indirect-access-pattern.ts` で除外済み)。
 *     ここでも `IndirectAccessPattern.access === 'write'` は来ない前提。
 *   - `effectivePatterns` が空配列 (`undefined`) の場合は全 block を emit
 *     (= 既存 legacy 挙動)。
 */
import type { EffectivePattern } from './types';

export interface SkipBlockContext {
  /**
   * Phase 1 で計算された effective patterns (= skip-set の中身)。
   * `undefined` または空配列なら skip 無し。
   */
  effectivePatterns: readonly EffectivePattern[];
}

/**
 * Pure filter: returns `true` when the given blockId should be omitted
 * from the emitted WGSL body.
 *
 * Block-id 比較は O(N) (線形走査) だが、`effectivePatterns` は通常 0–4 件
 * 程度なので Set 化する必要は無い。
 */
export function shouldSkipBlock(blockId: string, context: SkipBlockContext): boolean {
  const patterns = context.effectivePatterns;
  if (!patterns || patterns.length === 0) return false;
  for (const entry of patterns) {
    if (entry.pattern.blockId === blockId) return true;
  }
  return false;
}
