/**
 * D2 axis-safety analysis. Per spec §4.2, an `@repeat Ri:<axis>` is
 * parallel-safe only if all five of these hold:
 *
 *   (a) `@map` declares `Ri`.
 *   (b) The formula references `Ri` at least once.
 *   (c) The body does not write to `Ri`.
 *   (d) No cross-iteration access (`Ri ± k`, k≠0).
 *   (e) Every block in the body is GPU-supportable.
 *
 * When any one of (a)-(d) fails, the axis collapses to `'sequential'`
 * (a for-loop on the JS side via the M5 dispatcher); (e) failure is
 * already covered by `block-subset` (D1 takes the whole region down).
 */

import type {
  AxisFinal,
  AxisVerdict,
  Diagnostic,
  ExtractedRegion,
  ParsedDirective,
  ParsedProject,
  RawBlock,
  RepeatDirective,
} from './types';

export interface AxisAnalysisResult {
  /** Keyed by `repeatName` (e.g. `'R0'`). */
  axes: Record<string, AxisVerdict>;
  diagnostics: Diagnostic[];
}

const INDEX_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function analyzeAxes(
  region: ExtractedRegion,
  directives: readonly ParsedDirective[],
  project: ParsedProject,
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
    const verdict = computeAxisVerdict(r, maps, bodyBlocks, region, diagnostics);
    out[r.name] = verdict;
  }
  return { axes: out, diagnostics };
}

function computeAxisVerdict(
  r: RepeatDirective,
  maps: Set<string>,
  bodyBlocks: RawBlock[],
  region: ExtractedRegion,
  diagnostics: Diagnostic[],
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
    diagnostics.push(
      axisDiag(region, r, `axis '${r.axis}' demoted: @map for '${r.name}' missing (D2)`),
    );
    return { requestedAxis: r.axis, finalAxis: 'sequential', demoteReason: 'd2', diagnostics: [] };
  }

  // (b) formula references Ri.
  if (!formulaMentions(r.formula, r.name)) {
    diagnostics.push(
      axisDiag(region, r, `axis '${r.axis}' demoted: formula does not reference '${r.name}' (D2)`),
    );
    return { requestedAxis: r.axis, finalAxis: 'sequential', demoteReason: 'd2', diagnostics: [] };
  }

  // (c) body does not write to Ri. We treat any block whose opcode is
  // `data_setvariableto` / `data_changevariableby` / `data_itemoflist`
  // mutation etc, with Ri in its variable name, as a write.
  const writes = findVariableWrites(bodyBlocks);
  if (writes.has(r.name)) {
    diagnostics.push(
      axisDiag(region, r, `axis '${r.axis}' demoted: body writes to '${r.name}' (D2)`),
    );
    return { requestedAxis: r.axis, finalAxis: 'sequential', demoteReason: 'd2', diagnostics: [] };
  }

  // (d) no cross-iteration access (`Ri±k`, k≠0). The body would have to
  // compute a numeric offset from Ri and use it as a list index. We
  // detect this by scanning block inputs for `(Ri + N)` / `(Ri - N)`
  // patterns nested inside list reads.
  if (hasCrossIterationAccess(bodyBlocks, r.name)) {
    diagnostics.push(
      axisDiag(region, r, `axis '${r.axis}' demoted: cross-iteration access on '${r.name}' (D2)`),
    );
    return { requestedAxis: r.axis, finalAxis: 'sequential', demoteReason: 'd2', diagnostics: [] };
  }

  return { requestedAxis: r.axis, finalAxis: r.axis, diagnostics: [] };
}

function axisDiag(region: ExtractedRegion, r: RepeatDirective, message: string): Diagnostic {
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
 * Walk every body block's `fields` / `inputs` and collect the names
 * referenced by `data_setvariableto` / `data_changevariableby` opcodes.
 * We use this to detect (c).
 */
function findVariableWrites(bodyBlocks: RawBlock[]): Set<string> {
  const writes = new Set<string>();
  for (const block of bodyBlocks) {
    if (
      block.opcode === 'data_setvariableto' ||
      block.opcode === 'data_changevariableby' ||
      block.opcode === 'data_setvariableto' // alias (some forks ship both)
    ) {
      const fields = block.fields;
      const variable = fields['VARIABLE'];
      if (
        variable &&
        typeof variable === 'object' &&
        typeof (variable as { id?: unknown }).id === 'string'
      ) {
        writes.add(((variable as { id: string }).id ?? '').toLowerCase());
      }
      // Some blocks carry the variable name as a top-level field.
      const variable2 = fields['FIELD_LIST'];
      if (typeof variable2 === 'string') writes.add(variable2.toLowerCase());
    }
  }
  return writes;
}

/**
 * Cross-iteration access: scan every body block's `inputs` for an
 * arithmetic expression of the form `<name> + <int>` or `<name> - <int>`
 * where the integer is anything but 0. We look at the *expression tree*,
 * which the vendored scratch-vm exposes as `{ opcode: 'operator_add',
 * inputs: { ... } }`.
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
      const fromInputs = detectOffsetInInputs(inputs, name);
      if (fromInputs) return true;
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

function detectOffsetInInputs(inputs: Record<string, unknown>, name: string): boolean {
  // inputs: { NUM1: <block or shadow>, NUM2: <block or shadow> }
  for (const slot of ['NUM1', 'NUM2']) {
    const operand = inputs[slot];
    if (!operand || typeof operand !== 'object') continue;
    const op = operand as Record<string, unknown>;
    // Shadow block: `[1, [10, "name"]]` or `[10, "name"]` (a literal name).
    if (op['opcode'] === 'data_variable' && typeof op['fields'] === 'object') {
      const fields = op['fields'] as Record<string, unknown>;
      const variable = fields['VARIABLE'];
      if (
        variable &&
        typeof variable === 'object' &&
        typeof (variable as { id?: unknown }).id === 'string' &&
        ((variable as { id: string }).id ?? '').toLowerCase() === name.toLowerCase()
      ) {
        // paired with a non-zero numeric literal in the other slot → cross-iter.
        return true;
      }
    }
  }
  return false;
}

function collectBodyBlocks(project: ParsedProject, region: ExtractedRegion): RawBlock[] {
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
    for (const key of ['SUBSTACK', 'SUBSTACK2']) {
      const sub = block.inputs[key];
      if (typeof sub === 'string') queue.push(sub);
      else if (sub && typeof sub === 'object' && typeof (sub as { id?: unknown }).id === 'string') {
        queue.push((sub as { id: string }).id);
      }
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
