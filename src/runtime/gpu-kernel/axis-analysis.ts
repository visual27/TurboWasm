/**
 * D2 axis-safety analysis. Per spec §4.2, an `@repeat Ri:<axis>` is
 * parallel-safe only if all five of these hold:
 *
 *   (a) `@map` declares `Ri`.
 *   (b) The formula references `Ri` at least once.
 *   (c) The body does not write to `Ri`.
 *   (d) No cross-iteration access — `Ri ± k` with k ≠ 0 literal,
 *       or `Ri ± data_variable(non-R0)`.
 *   (e) Every block in the body is GPU-supportable (D1).
 *
 * When any of (a)–(d) fails, the axis collapses to `'sequential'`
 * (a for-loop on the JS side via the M5 dispatcher); (e) failure is
 * already covered by `block-subset` (D1 takes the whole region down).
 *
 * Safe expressions
 * ----------------
 * `Ri + 0` / `Ri - 0` are safe (k=0). A naïve "Ri and a number" check
 * would flag them; we test the partner slot for a literal zero shadow
 * (scratch-vm encodes a literal as `[1, [10, "<num>"]]` or `[10, "<num>"]`,
 * opcode 10 = `math_number`). Anything else (dynamic `data_variable`,
 * `operator_mathop`, string shadow, etc.) is treated as a real offset.
 */

import {
  HOOK_OPCODE_KEYS,
  type AxisFinal,
  type AxisVerdict,
  type Diagnostic,
  type ExtractedRegion,
  type ImplicitAxis,
  type ParsedDirective,
  type ParsedProject,
  type RawBlock,
  type RepeatDirective,
} from './types';
import { extractBlockReference } from './block-reference';

export interface AxisAnalysisResult {
  /** Keyed by `repeatName` (e.g. `'R0'`). */
  axes: Record<string, AxisVerdict>;
  diagnostics: Diagnostic[];
}

const INDEX_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Scratch-vm shadow opcode for `math_number` (used in BlockShadowArray). */
const SHADOW_OPCODE_MATH_NUMBER = 10;

export function analyzeAxes(
  region: ExtractedRegion,
  directives: readonly ParsedDirective[],
  project: ParsedProject,
  implicitAxes: readonly ImplicitAxis[] = [],
): AxisAnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const repeats = directives.filter(
    (d): d is RepeatDirective => d.kind === 'repeat',
  );
  const maps = new Set<string>();
  for (const d of directives) {
    if (d.kind === 'map') maps.add(d.var);
  }

  const bodyBlocks: RawBlock[] = collectBodyBlocks(project, region);

  const out: Record<string, AxisVerdict> = {};
  for (const r of repeats) {
    const verdict = computeAxisVerdict(r, maps, bodyBlocks, region);
    out[r.name] = verdict;
    diagnostics.push(...verdict.diagnostics);
  }

  // Phase 2 (nested-parallelization-03-phase2 §3.6): implicit axes を
  // verdict map に追加する。`formula === ''` (= scratchBlockToWgslExpr が
  // 失敗) は D2 sequential に降格。
  //
  // canonical key には反映しない (kernel-registry.ts:stripVolatile が
  // `implicitAxes` を一切見ない)。
  for (const implicit of implicitAxes) {
    const demoted = implicit.formula === '' || implicit.formula === null;
    const verdict: AxisVerdict = {
      requestedAxis: implicit.axis,
      finalAxis: demoted ? 'sequential' : implicit.axis,
      ...(demoted ? { demoteReason: 'd2' as const } : {}),
      diagnostics: demoted
        ? [
            {
              severity: 'warn',
              code: 'd2.axis_demoted',
              message: `implicit axis '${implicit.name}' demoted to sequential (unsupported formula)`,
              regionId: region.regionId,
              blockId: implicit.blockId,
            },
          ]
        : [],
    };
    out[implicit.name] = verdict;
    diagnostics.push(...verdict.diagnostics);
  }

  return { axes: out, diagnostics };
}

function computeAxisVerdict(
  r: RepeatDirective,
  maps: Set<string>,
  bodyBlocks: RawBlock[],
  region: ExtractedRegion,
): AxisVerdict {
  if (r.axis === 'sequential') {
    return {
      requestedAxis: r.axis,
      finalAxis: 'sequential',
      diagnostics: [],
    };
  }

  // (a) @map declares Ri.
  if (!maps.has(r.name)) {
    return {
      requestedAxis: r.axis,
      finalAxis: 'sequential',
      demoteReason: 'd2',
      diagnostics: [
        axisDiag(region, r, `axis '${r.axis}' demoted: @map for '${r.name}' missing (D2)`),
      ],
    };
  }

  // (b) formula references Ri.
  if (!formulaMentions(r.formula, r.name)) {
    return {
      requestedAxis: r.axis,
      finalAxis: 'sequential',
      demoteReason: 'd2',
      diagnostics: [
        axisDiag(
          region,
          r,
          `axis '${r.axis}' demoted: formula does not reference '${r.name}' (D2)`,
        ),
      ],
    };
  }

  // (c) body does not write to Ri.
  const writes = findVariableWrites(bodyBlocks);
  if (writes.has(r.name)) {
    return {
      requestedAxis: r.axis,
      finalAxis: 'sequential',
      demoteReason: 'd2',
      diagnostics: [
        axisDiag(region, r, `axis '${r.axis}' demoted: body writes to '${r.name}' (D2)`),
      ],
    };
  }

  // (d) no cross-iteration access (`Ri±k`, k≠0).
  if (hasCrossIterationAccess(bodyBlocks, r.name)) {
    return {
      requestedAxis: r.axis,
      finalAxis: 'sequential',
      demoteReason: 'd2',
      diagnostics: [
        axisDiag(
          region,
          r,
          `axis '${r.axis}' demoted: cross-iteration access on '${r.name}' (D2)`,
        ),
      ],
    };
  }

  return {
    requestedAxis: r.axis,
    finalAxis: r.axis,
    diagnostics: [],
  };
}

function axisDiag(
  region: ExtractedRegion,
  r: RepeatDirective,
  message: string,
): Diagnostic {
  return {
    severity: 'warn',
    code: 'd2.axis_demoted',
    message,
    regionId: region.regionId,
    blockId: r.blockId,
    line: r.line,
  };
}

/**
 * Naive identifier scan: a `\b<var>\b` regex on the formula string. False
 * positives are bounded (e.g. `idx0` shares the `idx` substring but we
 * use whole-word matching), and a false negative only causes D2 to demote
 * when in reality the formula did reference the variable — never the
 * other way round. The WGSL emitter does the actual reference scan in M4.
 */
function formulaMentions(formula: string, name: string): boolean {
  if (!INDEX_VAR_PATTERN.test(name)) return false;
  const m = formula.match(new RegExp(`\\b${escapeRegExp(name)}\\b`));
  return m !== null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Opcodes whose execution writes to a scratch variable. Used by (c)
 * to detect "body writes to Ri".
 *
 * `data_setvariableto` and `data_changevariableby` are listed as
 * **independent** opcodes (not aliases): scratch-vm routes them
 * through different blocks (`setVariableTo` vs `changeVariableBy`)
 * with distinct fields, even though they share the same `VARIABLE`
 * shape we extract here. Aliasing them in this set would lose that
 * distinction if a future opcode-specific check is added.
 *
 * `data_changevaroflist` and `data_replaceitemoflist` write to list
 * elements rather than the index var, so they are not in this set.
 */
const VARIABLE_WRITE_OPCODES: ReadonlySet<string> = new Set([
  'data_setvariableto',
  'data_changevariableby',
]);

/**
 * Walk every body block's `fields` / `inputs` and collect the names
 * referenced by `data_setvariableto` / `data_changevariableby` opcodes.
 * We use this to detect (c).
 *
 * §Phase 1: `fields.VARIABLE` is fed through `extractBlockReference`
 * so the union of accept-shapes (`{ id }`, `{ id, name }`, bare string,
 * `[name, null]`-style primitive field, ...) all resolve uniformly. The
 * `[name, null]` array shape (SB3 primitive field) returns the first
 * element via the helper's per-element scan, matching the legacy
 * `{ id }.id`-style id we used to read here.
 */
function findVariableWrites(bodyBlocks: RawBlock[]): Set<string> {
  const writes = new Set<string>();
  for (const block of bodyBlocks) {
    if (!VARIABLE_WRITE_OPCODES.has(block.opcode)) continue;
    const fields = block.fields;
    const variable = fields['VARIABLE'];
    const refId = extractBlockReference(variable);
    if (refId) {
      writes.add(refId.toLowerCase());
    }
    // Some blocks carry the variable name as a top-level field.
    const variable2 = fields['FIELD_LIST'];
    if (typeof variable2 === 'string') writes.add(variable2.toLowerCase());
  }
  return writes;
}

/**
 * Cross-iteration access: scan every body block's `inputs` for an
 * arithmetic expression of the form `<name> + k` or `<name> - k` where
 * `k` is a numeric literal **not** equal to 0, or where the partner
 * operand is a `data_variable` referencing a different index var.
 */
function hasCrossIterationAccess(bodyBlocks: RawBlock[], name: string): boolean {
  const stack: unknown[] = [...bodyBlocks];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const obj = cur as Record<string, unknown>;
    const opcode = obj['opcode'];
    if (
      (opcode === 'operator_add' || opcode === 'operator_subtract') &&
      typeof obj['inputs'] === 'object' &&
      obj['inputs'] !== null
    ) {
      const inputs = obj['inputs'] as Record<string, unknown>;
      if (detectOffsetInInputs(inputs, name)) return true;
    }
    // Recurse into known nested fields.
    if (typeof obj['inputs'] === 'object' && obj['inputs'] !== null) {
      const inputs = obj['inputs'] as Record<string, unknown>;
      for (const v of Object.values(inputs)) stack.push(v);
    }
    if (typeof obj['fields'] === 'object' && obj['fields'] !== null) {
      const fields = obj['fields'] as Record<string, unknown>;
      for (const v of Object.values(fields)) stack.push(v);
    }
  }
  return false;
}

/**
 * Inspect both NUM1/NUM2 slots of an `operator_add` / `operator_subtract`
 * block. Cross-iteration is present if:
 *
 *   - One slot is a `data_variable` referencing `name`, **and**
 *   - The other slot is *not* a numeric literal whose text parses to 0,
 *     **and** the other slot is not itself a `data_variable` referencing
 *     the same `name` (`Ri + Ri` reads the same index value twice in
 *     one iteration — not a cross-iteration access).
 *
 * Any other dynamic partner (`data_variable` with a different id, math
 * operator, etc.) is treated as a real offset because we cannot prove
 * it is constant 0.
 */
function detectOffsetInInputs(
  inputs: Record<string, unknown>,
  name: string,
): boolean {
  const num1 = inputs['NUM1'];
  const num2 = inputs['NUM2'];
  // Special-case: `Ri ± Ri` — both slots resolve to the same index value
  // within a single iteration, so this is not a cross-iteration access.
  if (isDataVariableFor(num1, name) && isDataVariableFor(num2, name)) {
    return false;
  }
  const slots: Array<'NUM1' | 'NUM2'> = ['NUM1', 'NUM2'];
  for (const slot of slots) {
    const operand = inputs[slot];
    if (!isDataVariableFor(operand, name)) continue;
    // The partner slot is the other one.
    const partnerSlot = slot === 'NUM1' ? 'NUM2' : 'NUM1';
    const partner = inputs[partnerSlot];
    if (isZeroLiteralShadow(partner)) {
      // Ri ± 0 → safe. Continue scanning in case the other slot also
      // has a `data_variable` referencing a different `name`, which
      // would re-enter this loop on its own iteration.
      continue;
    }
    return true;
  }
  return false;
}

/**
 * True when `value` is a `data_variable` reporter referencing `name`
 * (case-insensitive). Used by `detectOffsetInInputs` to short-circuit
 * `Ri ± Ri` and to recognise `data_variable` reporters in either slot.
 */
function isDataVariableFor(value: unknown, name: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const op = value as Record<string, unknown>;
  if (op['opcode'] !== 'data_variable') return false;
  const fields = op['fields'];
  if (!fields || typeof fields !== 'object') return false;
  const variable = (fields as Record<string, unknown>)['VARIABLE'];
  if (!variable || typeof variable !== 'object') return false;
  const id = (variable as { id?: unknown }).id;
  return typeof id === 'string' && id.toLowerCase() === name.toLowerCase();
}

/**
 * True when `value` is a scratch-vm shadow encoding a numeric literal
 * whose value parses to 0. Accepts both `[1, [10, "0"]]` (BlockShadowArray)
 * and `[10, "0"]` (literal-only BlockShadow). Other shadow opcodes
 * (string, list) are not zero literals.
 */
function isZeroLiteralShadow(value: unknown): boolean {
  let payload: unknown = value;
  // Strip outer BlockShadowArray wrapper when present.
  if (Array.isArray(value)) {
    if (value.length >= 2 && value[0] === 1 && Array.isArray(value[1])) {
      payload = value[1];
    } else if (value.length >= 2 && typeof value[0] === 'number') {
      payload = value[1];
    } else {
      return false;
    }
  } else if (value && typeof value === 'object') {
    // Object form: `{ block, shadow, ... }` — recursively inspect.
    const obj = value as Record<string, unknown>;
    if ('shadow' in obj) return isZeroLiteralShadow(obj['shadow']);
    if ('block' in obj) return isZeroLiteralShadow(obj['block']);
    return false;
  } else {
    return false;
  }
  if (!Array.isArray(payload) || payload.length < 2) return false;
  const opcode = payload[0];
  if (opcode !== SHADOW_OPCODE_MATH_NUMBER) return false;
  const text = payload[1];
  if (typeof text !== 'string') return false;
  // Parse defensively: "0", "0.0", "-0", "-0.0" are all zero.
  if (text.trim() === '') return false;
  const num = Number(text);
  return Number.isFinite(num) && num === 0;
}

function collectBodyBlocks(
  project: ParsedProject,
  region: ExtractedRegion,
): RawBlock[] {
  const out: RawBlock[] = [];
  const visited = new Set<string>();
  const queue = [...region.bodyBlockIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const block = lookupBlock(project, id);
    if (!block) continue;
    out.push(block);
    if (typeof block.next === 'string') queue.push(block.next);
    // §Phase 1: route every hook (SUBSTACK / SUBSTACK2 / CONDITION)
    // through `extractBlockReference` so this walker shares its accept
    // criteria with region-extractor / block-subset.
    for (const key of HOOK_OPCODE_KEYS) {
      const refId = extractBlockReference(block.inputs[key]);
      if (refId) queue.push(refId);
    }
  }
  return out;
}

function lookupBlock(project: ParsedProject, id: string): RawBlock | undefined {
  for (const t of project.targets) {
    const b = t.blocks[id];
    if (b) return b;
  }
  return undefined;
}

// Re-export the type alias so consumers don't reach into ./types for it.
export type { AxisFinal };
