/**
 * §Phase 6 (gpu-kernel-scratch-temporary-let-binding.md) — pure M3
 * stage that walks a region's inlined body to auto-detect scratch
 * temporary variables and synthesise WGSL `let` bindings for them.
 *
 * # Why this exists
 *
 * The previous pipeline treated `data_setvariableto` as a no-op in the
 * WGSL emitter (see `wgsl-emitter.ts:emitStatement`). The user's `fn
 * expo` / `fn clamp` style blocks read a `tmp1` set earlier in the
 * body via `data_variableof`, but the WGSL emitter had no `let tmp1`
 * declaration to resolve the reference against — the read fell back to
 * `0.0`. Users had to either inline the expression or declare an
 * explicit `@map tmp1 <- ...`. This stage closes that gap by promoting
 * scratch variable writes that are not bound by any directive into a
 * topologically ordered `let` chain.
 *
 * # Pipeline position
 *
 * Lives in `region-verdict-pipeline.ts:buildRegionVerdicts` between
 * `buildBlockSubsetVerdict` (D1) and `analyzeAxes` (D2). The
 * detector's input is the inlined body (= post-`procedure-inliner`),
 * so a custom-block prototype's scratch tmps are also covered.
 *
 * # Constraints (per gpu-kernel-scratch-temporary-let-binding.md)
 *
 * - **single-assignment only**: `data_setvariableto` is the only
 *   trigger. `data_changevariableby` is intentionally NOT promoted
 *   (WGSL `let` is non-reassignable); an `info` diagnostic surfaces
 *   the user's intent for opt-in to explicit `@map`.
 * - **scope = region body**: variables that do not appear in the
 *   region body are ignored.
 * - **collision rules**: scratch names that collide with `@bind`,
 *   `@map`, or `@repeat` directive names in the same region D1-demote
 *   the owning region via `PARSER_ERROR_CODES`.
 * - **cycle detection**: a `tmp1 = tmp2 + 1; tmp2 = tmp1 + 1`-style
 *   DAG cycle also D1-demotes via `PARSER_ERROR_CODES`.
 * - **last-write-wins**: multiple `data_setvariableto` writes to the
 *   same name are de-duplicated to the last occurrence; the dropped
 *   writes emit a `warn`-level `gpu.scratch_variable_duplicate_write`
 *   diagnostic so the user can surface the dynamic-semantics
 *   divergence.
 * - **canonical-key free**: `AutoTmpBinding` does NOT participate in
 *   `stripDirectiveVolatile`. Two regions with the same directives
 *   but different scratch tmp names share the same canonical key
 *   (and therefore the same compiled pipeline).
 *
 * # Output
 *
 * Returns an `AutoTmpVerdict` carrying the topo-ordered
 * `AutoTmpBinding` list. The WGSL emitter (`emitRegion`) consumes
 * this verbatim and emits `let <emitName>: f32 = <formula>;` per
 * binding above the body walk.
 */
import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import { extractBlockReference } from './block-reference';
import type {
  AutoTmpBinding,
  AutoTmpVerdict,
  Diagnostic,
  ExtractedRegion,
  ParsedProject,
  RawBlock,
} from './types';

/**
 * WGSL reserved identifiers. `safeIdentifier`
 * (`wgsl-emitter.ts:safeIdentifier`) hashes any name that lands here so
 * the detector hands off to the existing rename pipeline rather than
 * trying to escape on its own.
 *
 * Mirroring the exact set here would be brittle; the emitter's
 * `RESERVED_IDENTIFIERS` is the single source of truth. The detector
 * itself does not consult this set — `safeIdentifier` is called from
 * `emitRegion` once the `AutoTmpBinding` list reaches M4.
 */

export interface DetectAutoTmpInput {
  region: ExtractedRegion;
  inlinedBodyIds: readonly string[];
  project: ParsedProject;
  /** Lower-cased scratch names declared by directives in this region. */
  directiveNames: {
    binds: ReadonlySet<string>;
    maps: ReadonlySet<string>;
    repeats: ReadonlySet<string>;
  };
}

/**
 * Entry point. Pure; no mutation of inputs. Runs the detection
 * algorithm end-to-end and returns the verdict. On cycle / collision
 * the verdict is `valid: false` and the caller
 * (`region-verdict-pipeline.ts`) routes the diagnostics through
 * `PARSER_ERROR_CODES` so the owning region D1-demotes.
 */
export function detectAutoTmpBindings(input: DetectAutoTmpInput): AutoTmpVerdict {
  const { region, inlinedBodyIds, project, directiveNames } = input;
  const diagnostics: Diagnostic[] = [];

  // §Phase 6 — single-assignment promotion. Walk the inlined body
  // once and collect every `data_setvariableto` whose target name is
  // NOT claimed by any directive in this region.
  const writesByName = new Map<
    string,
    { blockId: string; valueBlockId: string; valueInput: unknown; scratchBlock: RawBlock }
  >();
  const changevariablebyTargets = new Set<string>();

  for (const blockId of inlinedBodyIds) {
    const block = lookupBlock(project, blockId);
    if (!block) continue;

    if (block.opcode === 'data_setvariableto') {
      const name = readScratchVariableName(block);
      if (!name) continue;
      const lowered = name.toLowerCase();
      if (
        directiveNames.binds.has(lowered) ||
        directiveNames.maps.has(lowered) ||
        directiveNames.repeats.has(lowered)
      ) {
        // Bound variable: skip (existing pipeline handles it).
        continue;
      }
      const existing = writesByName.get(lowered);
      if (existing) {
        // last-write-wins — record the duplicate diagnostic against
        // the earlier block so the user can locate it.
        diagnostics.push({
          severity: 'warn',
          code: GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_DUPLICATE_WRITE,
          message: `scratch variable '${name}' is written multiple times in region '${region.regionId}'; only the last write is promoted to a WGSL 'let'`,
          regionId: region.regionId,
          blockId: existing.blockId,
        });
      }
      writesByName.set(lowered, {
        blockId,
        valueBlockId: extractBlockReference(block.inputs['VALUE']) ?? '',
        valueInput: block.inputs['VALUE'],
        scratchBlock: block,
      });
      continue;
    }

    if (block.opcode === 'data_changevariableby') {
      const name = readScratchVariableName(block);
      if (!name) continue;
      const lowered = name.toLowerCase();
      if (directiveNames.repeats.has(lowered) || directiveNames.binds.has(lowered)) {
        // Iteration advance on a bound variable: handled by
        // `iteration-advance-pattern`. Skip silently.
        continue;
      }
      if (!changevariablebyTargets.has(lowered)) {
        changevariablebyTargets.add(lowered);
        diagnostics.push({
          severity: 'info',
          code: GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_CHANGEVARBY_IGNORED,
          message: `scratch variable '${name}' is mutated via 'change variable by' in region '${region.regionId}'; auto-tmp is single-assignment-only, use an explicit '@map' or inline the accumulation`,
          regionId: region.regionId,
          blockId,
        });
      }
    }
  }

  // Collision check: each candidate name must be absent from the
  // directive sets (we already filtered @bind/@map/@repeat above, so
  // this is a defensive double-check against the lower-case form).
  for (const name of writesByName.keys()) {
    if (
      directiveNames.binds.has(name) ||
      directiveNames.maps.has(name) ||
      directiveNames.repeats.has(name)
    ) {
      return {
        valid: false,
        demoteReason: 'd1',
        bindings: [],
        diagnostics: [
          ...diagnostics,
          {
            severity: 'error',
            code: GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_COLLISION,
            message: `scratch variable '${name}' collides with a directive name in region '${region.regionId}'; D1 demote`,
            regionId: region.regionId,
          },
        ],
      };
    }
  }

  // Build the dependency DAG: each write's `inputs.VALUE` chain may
  // reference other auto-tmp names via `data_variableof`. Walk every
  // VALUE chain to collect the immediate set of auto-tmp dependencies.
  const dependsOn = new Map<string, Set<string>>();
  for (const [name, write] of writesByName.entries()) {
    const deps = collectAutoTmpDependencies(write.valueInput, project, writesByName);
    dependsOn.set(name, deps);
  }

  // Cycle detection (DFS coloring — `cascade-analysis.ts` is the
  // reference implementation for the same pattern over `@map`s).
  const cycle = detectAutoTmpCycle(writesByName, dependsOn);
  if (cycle) {
    const cyclePath = cycle.join(' -> ');
    return {
      valid: false,
      demoteReason: 'd1',
      bindings: [],
      diagnostics: [
        ...diagnostics,
        {
          severity: 'error',
          code: GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_CYCLE,
          message: `scratch 'let' DAG has a cycle (${cyclePath}) in region '${region.regionId}'; D1 demote`,
          regionId: region.regionId,
        },
      ],
    };
  }

  // Topological sort (Kahn's algorithm). The output is one valid
  // topological order; the emitter uses it verbatim to emit `let`
  // declarations above the body walk.
  const topoOrder = topoSortAutoTmp(writesByName, dependsOn);

  // Materialise the bindings. The WGSL emitter calls `safeIdentifier`
  // on the surface name to derive `emitName` (handles reserved-word
  // collision uniformly with the existing rename pipeline).
  const bindings: AutoTmpBinding[] = topoOrder.map((name) => {
    const write = writesByName.get(name)!;
    return {
      name: findOriginalCase(writesByName, name),
      emitName: name,
      blockId: write.blockId,
      sourceBlockId: write.blockId,
    };
  });

  return {
    valid: true,
    bindings,
    diagnostics,
  };
}

// --- helpers --------------------------------------------------------------

function lookupBlock(project: ParsedProject, id: string): RawBlock | undefined {
  for (const target of project.targets) {
    const block = target.blocks[id];
    if (block) return block;
  }
  return undefined;
}

/**
 * Read the target variable name off a `data_setvariableto` /
 * `data_changevariableby` block. Accepts the same union of
 * `fields.VARIABLE` shapes that `axis-analysis.ts:findVariableWrites`
 * and `procedure-inliner.ts:readArgumentReporterName` already
 * tolerate: `{ id, name }`, bare string, `[name, null]`, `[VARIABLE,
 * name]`, etc. Returns the lower-cased form so subsequent Set
 * membership tests are case-insensitive (scratch variables are
 * case-insensitive in the live runtime).
 */
function readScratchVariableName(block: RawBlock): string | null {
  const field = block.fields['VARIABLE'];
  if (!field) return null;
  if (typeof field === 'string') return field.toLowerCase();
  if (Array.isArray(field)) {
    for (const item of field) {
      if (typeof item === 'string') return item.toLowerCase();
    }
    return null;
  }
  if (typeof field === 'object') {
    const obj = field as Record<string, unknown>;
    if (typeof obj['name'] === 'string') return obj['name'].toLowerCase();
    if (typeof obj['id'] === 'string') return obj['id'].toLowerCase();
  }
  return null;
}

/**
 * Walks the `data_setvariableto.inputs.VALUE` shadow chain looking
 * for `data_variableof` reporters that reference any of the in-flight
 * auto-tmp names. Returns the set of dependency names.
 *
 * Other opcodes (`math_number`, `operator_add`, `data_itemoflist`, ...)
 * do not introduce auto-tmp dependencies — only `data_variableof`
 * pointing at a scratch variable carries the binding reference.
 */
function collectAutoTmpDependencies(
  valueInput: unknown,
  project: ParsedProject,
  writesByName: ReadonlyMap<string, unknown>,
): Set<string> {
  const deps = new Set<string>();
  const stack: unknown[] = [valueInput];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;

    // Recurse into nested block references (binary ops, etc.).
    const refId = extractBlockReference(cur);
    if (refId && !visited.has(refId)) {
      visited.add(refId);
      const block = lookupBlock(project, refId);
      if (!block) continue;
      // §Phase 6 — both `data_variableof` (Phase 2 fixture style)
      // and `data_variable` (Phase 1+ reporter block) carry the
      // scratch variable name in `fields.VARIABLE`. Treat either as
      // an auto-tmp dependency edge so the cycle detector catches
      // `tmp1 = tmp2 + 1; tmp2 = tmp1 + 1`-style patterns across
      // both encodings.
      if (block.opcode === 'data_variableof' || block.opcode === 'data_variable') {
        const name = readScratchVariableName(block);
        if (name && writesByName.has(name)) deps.add(name);
      }
      // Continue walking the block's inputs (operator sub-trees).
      for (const value of Object.values(block.inputs)) {
        stack.push(value);
      }
    } else if (Array.isArray(cur)) {
      // Push array elements onto the stack; `extractBlockReference`
      // would unwrap the literal payload on its own but we want to
      // also descend into nested reporter chains.
      for (const item of cur) stack.push(item);
    } else {
      const obj = cur as Record<string, unknown>;
      for (const value of Object.values(obj)) stack.push(value);
    }
  }

  return deps;
}

/**
 * DFS three-color cycle detector. Returns the cycle path as
 * `[a, b, c, a]` or `null` when acyclic.
 *
 * Mirrors `cascade-analysis.ts:detectCycle` but operates on the
 * `Map<name, Set<name>>` shape produced here. Kept module-local so
 * the two cycle detectors can evolve independently.
 */
function detectAutoTmpCycle(
  writesByName: ReadonlyMap<string, unknown>,
  dependsOn: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | null {
  enum Color {
    White,
    Gray,
    Black,
  }
  const color = new Map<string, Color>();
  const stack: string[] = [];
  for (const name of writesByName.keys()) color.set(name, Color.White);

  function visit(node: string): string[] | null {
    color.set(node, Color.Gray);
    stack.push(node);
    const children = dependsOn.get(node);
    if (children) {
      for (const next of children) {
        const c = color.get(next) ?? Color.White;
        if (c === Color.Gray) {
          const idx = stack.indexOf(next);
          if (idx >= 0) {
            return stack.slice(idx).concat(next);
          }
          return [next, node];
        }
        if (c === Color.White) {
          const r = visit(next);
          if (r) return r;
        }
      }
    }
    stack.pop();
    color.set(node, Color.Black);
    return null;
  }

  for (const name of writesByName.keys()) {
    if ((color.get(name) ?? Color.White) === Color.White) {
      const r = visit(name);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Kahn's topological sort. Stable when the cycle check above
 * guarantees acyclicity. The output is one valid topological order
 * of the auto-tmp bindings (= order in which the WGSL emitter will
 * emit `let` declarations).
 */
function topoSortAutoTmp(
  writesByName: ReadonlyMap<string, unknown>,
  dependsOn: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const name of writesByName.keys()) {
    inDegree.set(name, 0);
    adj.set(name, []);
  }
  for (const [dependent, deps] of dependsOn) {
    for (const dep of deps) {
      if (!inDegree.has(dep)) continue;
      adj.get(dep)?.push(dependent);
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }
  const out: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift();
    if (n === undefined) continue;
    out.push(n);
    for (const m of adj.get(n) ?? []) {
      const d = (inDegree.get(m) ?? 0) - 1;
      inDegree.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  return out;
}

/**
 * Recover the original case of a scratch variable name from the
 * writes map. The detector stores names lower-cased for case-
 * insensitive Set membership tests, but the WGSL emitter wants the
 * user's surface form to honour scratch-vm case sensitivity at the
 * UI surface.
 */
function findOriginalCase(
  writesByName: ReadonlyMap<string, { scratchBlock: RawBlock }>,
  lowered: string,
): string {
  const write = writesByName.get(lowered);
  if (!write) return lowered;
  const name = readScratchVariableName(write.scratchBlock);
  // We stored lower-cased; the surface form is gone by the time we
  // reach here, so return the lower-cased form as the canonical name.
  // The WGSL emitter calls `safeIdentifier` on it anyway.
  return name ?? lowered;
}
