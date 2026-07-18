/**
 * Phase 1 (nested-parallelization-02-phase1 §3.4) — body 内の
 * `data_itemoflist(LIST=L, INDEX=Rx)` block (= read) を auto-detect し、
 * `IndirectAccessPattern` の配列を作る pure helper。
 *
 * **不変条件 (Phase 1 修正版)**:
 *   - `data_replaceitemoflist` (write) は actual parallel work なので
 *     skip-set に入れない。**本 helper の対象外**。
 *   - 返却される pattern は **全て `access === 'read'`** となる。
 *   - `opcode` は **`'data_itemoflist'` 固定**。
 *
 * `fn expo` での実例:
 *   - `tmp1 = tmp0 * buff_r[idx1]` (read) は body chain に直接出ない
 *     (formula 内に `data_itemoflist`) ので、auto-detect は走らない。
 *     これは設計上 OK — formula 内の read は WGSL emit 経路で別途処理。
 *   - `buff_r[idx1] = ...` (write) は `data_replaceitemoflist` なので
 *     本 helper で対象外 (= 常に emit される)。
 */

import type {
  Diagnostic,
  IndirectAccessPattern,
  MapDirective,
  ParsedDirective,
  RawBlock,
} from './types';
import { extractVariableName } from './iteration-advance-pattern';

export interface CollectResult {
  patterns: IndirectAccessPattern[];
  diagnostics: Diagnostic[];
}

export function collectIndirectAccessPatterns(
  blocks: Record<string, RawBlock>,
  bodyBlockIds: readonly string[],
  parsedDirectives: readonly ParsedDirective[],
): CollectResult {
  const patterns: IndirectAccessPattern[] = [];
  const diagnostics: Diagnostic[] = [];

  const boundListNames = new Set<string>();
  for (const d of parsedDirectives) {
    if (d.kind === 'bind') boundListNames.add(d.name);
  }

  const explicitByBlockId = new Map<string, ParsedDirective>();
  for (const d of parsedDirectives) {
    if (d.kind === 'map' && d.boundBlockId) {
      explicitByBlockId.set(d.boundBlockId, d);
    }
  }

  for (const blockId of bodyBlockIds) {
    const block = blocks[blockId];
    if (!block) continue;

    if (block.opcode !== 'data_itemoflist') continue;

    const listField = block.fields['LIST'];
    const scratchListName = extractVariableName(listField);
    if (!scratchListName) continue;
    if (!boundListNames.has(scratchListName)) continue;

    const indexShadow = block.inputs['INDEX'];
    const indexExpr = extractVariableReference(indexShadow);
    if (!indexExpr) continue;

    const explicitDirective = explicitByBlockId.get(blockId);
    const isExplicit = explicitDirective !== undefined;
    patterns.push({
      kind: 'indirect-access',
      scratchListName,
      indexExpr,
      opcode: 'data_itemoflist',
      blockId,
      access: 'read',
      source: isExplicit ? 'explicit' : 'auto-detected',
      directive: isExplicit
        ? directiveRef(explicitDirective as MapDirective)
        : undefined,
    });
  }

  return { patterns, diagnostics };
}

function directiveRef(d: MapDirective): IndirectAccessPattern['directive'] {
  return { kind: 'map', name: d.var, line: d.line, column: d.column };
}

function extractVariableReference(shadow: unknown): string | null {
  return extractVariableName(shadow);
}
