/**
 * Phase 1 (nested-parallelization-02-phase1 §3.3) — body 内の
 * `data_changevariableby(<var>, <delta>)` block を auto-detect し、
 * `IterationAdvancePattern` の配列を作る pure helper。
 *
 * 検出条件:
 *   - opcode が `data_changevariableby`
 *   - `inputs.VALUE` の shadow が数値 literal (`math_number` / `math_integer`)
 *   - `fields.VARIABLE` の name が `@bind` または `@repeat` directive に
 *     bind されている (= `boundVarNames` 集合に含まれている)
 *
 * `boundBlockId` を directive に持つ block (`explicit` source) と、
 * 上記条件だけを満たす `auto-detected` source を区別する。
 *
 * §3.4 修正版: `data_replaceitemoflist` (write) は対象外。iteration
 * advance は read 側の advance のみ。
 */

import type {
  Diagnostic,
  IterationAdvancePattern,
  MapDirective,
  ParsedDirective,
  RawBlock,
  RepeatDirective,
} from './types';

export interface CollectResult {
  patterns: IterationAdvancePattern[];
  diagnostics: Diagnostic[];
}

/**
 * Walk body block ids and collect every `data_changevariableby(<boundVar>,
 * <numeric>)` instance.
 */
export function collectIterationAdvancePatterns(
  blocks: Record<string, RawBlock>,
  bodyBlockIds: readonly string[],
  parsedDirectives: readonly ParsedDirective[],
): CollectResult {
  const patterns: IterationAdvancePattern[] = [];
  const diagnostics: Diagnostic[] = [];

  const boundVarNames = new Set<string>();
  for (const d of parsedDirectives) {
    if (d.kind === 'repeat') boundVarNames.add(d.name);
    if (d.kind === 'bind') boundVarNames.add(d.name);
  }

  const explicitByBlockId = new Map<string, ParsedDirective>();
  for (const d of parsedDirectives) {
    if (d.kind === 'repeat' || d.kind === 'map') {
      if (d.boundBlockId) {
        explicitByBlockId.set(d.boundBlockId, d);
      }
    }
  }

  for (const blockId of bodyBlockIds) {
    const block = blocks[blockId];
    if (!block) continue;
    if (block.opcode !== 'data_changevariableby') continue;

    const valueShadow = block.inputs['VALUE'];
    const delta = extractNumericLiteral(valueShadow);
    if (delta === null) continue;

    const variableField = block.fields['VARIABLE'];
    const varName = extractVariableName(variableField);
    if (!varName) continue;
    if (!boundVarNames.has(varName)) continue;

    const explicitDirective = explicitByBlockId.get(blockId);
    const isExplicit = explicitDirective !== undefined;
    patterns.push({
      kind: 'iteration-advance',
      varName,
      delta,
      blockId,
      source: isExplicit ? 'explicit' : 'auto-detected',
      directive: isExplicit
        ? directiveRef(explicitDirective as RepeatDirective | MapDirective)
        : undefined,
    });
  }

  return { patterns, diagnostics };
}

function directiveRef(
  d: RepeatDirective | MapDirective,
): IterationAdvancePattern['directive'] {
  if (d.kind === 'repeat') {
    return { kind: 'repeat', name: d.name, line: d.line, column: d.column };
  }
  return { kind: 'map', name: d.var, line: d.line, column: d.column };
}

/**
 * scratch-vm の shadow shape から数値 literal を抽出。
 *
 *   [PRIMITIVE, [<opcode>, "<num>"]]  (e.g. [10, ['math_number', '5']])
 *
 * or 直接 `[opcode, value]` shape も受理 (scratch-vm の reporter shape)。
 * Phase 1 では `math_number` / `math_integer` のみ受理。浮動小数は
 * iterate advance として不自然なため literal 化しない。
 */
export function extractNumericLiteral(value: unknown): number | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const tuple = value[1];
  if (!Array.isArray(tuple) || tuple.length < 2) return null;
  const opcode = tuple[0];
  const literal = tuple[1];
  if (typeof literal !== 'string') return null;
  if (opcode !== 'math_number' && opcode !== 'math_integer') return null;
  const n = Number(literal);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * scratch-vm の field shape から variable name を抽出。
 *
 *   ['VARIABLE', '<name>']  (legacy shape)
 *   { name: '<name>' }      (newer shape)
 */
export function extractVariableName(field: unknown): string | null {
  if (Array.isArray(field)) {
    if (typeof field[1] === 'string') return field[1];
    return null;
  }
  if (field && typeof field === 'object' && 'name' in field) {
    const name = (field as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}
