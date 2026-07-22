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
 * # SSA uniqueness
 *
 * Per block-id, not per name. `data_setvariableto` blocks targeting the
 * same scratch var name (`tmp1 = buff_r ...; tmp1 = buff_g ...;`) each
 * get their own `let <safeName>_<n>: f32 = ...;` so scratch reference
 * semantics survive the immutability of WGSL `let`. Reads
 * (`data_variableof` / `data_variable`) walk the inlined body in order
 * and resolve to the most-recent preceding write of the same name; the
 * resolved emit name is exposed via `autoTmpReads[blockId]`.
 *
 * # Mutable scratch vars
 *
 * `data_changevariableby` on a scratch var (e.g. `change idx1 by 1`)
 * implies `var` semantics. The detector emits a single
 * `var <name>: f32 = <initial>;` declaration that the latest SSA name
 * for that scratch var reuses, and the WGSL emitter follows each
 * `data_changevariableby` block with `<latestEmitName> = <latestEmitName> + <delta>;`.
 *
 * # Constraints (per gpu-kernel-scratch-temporary-let-binding.md)
 *
 * - **scope = region body**: variables that do not appear in the
 *   region body are ignored.
 * - **collision rules**: scratch names that collide with `@bind`,
 *   `@map`, or `@repeat` directive names in the same region D1-demote
 *   the owning region via `PARSER_ERROR_CODES`.
 * - **cycle detection**: a `tmp1 = tmp2 + 1; tmp2 = tmp1 + 1`-style
 *   DAG cycle also D1-demotes via `PARSER_ERROR_CODES`.
 * - **canonical-key free**: `AutoTmpBinding` does NOT participate in
 *   `stripDirectiveVolatile`. Two regions with the same directives
 *   but different scratch tmp names share the same canonical key
 *   (and therefore the same compiled pipeline).
 *
 * # Output
 *
 * Returns an `AutoTmpVerdict` carrying:
 *   - `bindings`: every `let <safeName>_<n>: f32 = <expr>;` declaration
 *     in topological order (cycles/collisions cause `valid: false`).
 *   - `reads`: per-read-block resolution table. The WGSL emitter
 *     consults this when emitting `data_variableof` /
 *     `data_variable` reporters that target an auto-tmp scratch var.
 *   - `mutables`: per-scratch-var mutable binding info. Used by the
 *     emitter to emit `var <name>: f32 = <initial>;` declarations and
 *     `<latest> = <latest> + <delta>;` increments.
 */
import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import { extractBlockReference } from './block-reference';
import type {
  AutoTmpBinding,
  AutoTmpMutableBinding,
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

  // §Phase 6 (extended) — deep body walk. `inlineProcedures` only walks
  // the kernel container's flat `next` chain, so a `data_setvariableto`
  // or `data_changevariableby` block inside a nested control_repeat
  // SUBSTACK would be invisible to the detector. We walk the body
  // deeply (recursing into SUBSTACK / SUBSTACK2 inputs) so the SSA
  // uniqueness + per-axis `change X by 1` folding reach every block
  // the WGSL emitter will lower.
  const deepBodyIds = collectDeepBodyIds(inlinedBodyIds, project);

  // §Phase 6 — SSA uniqueness per block id. Walk the inlined body once
  // and collect every `data_setvariableto` / `data_changevariableby`
  // whose target name is NOT claimed by any directive in this region.
  const writesByName = new Map<string, AutoTmpWriteEntry[]>();
  // Order-preserving list of all writes (used for cycle detection and
  // topological sort).
  const orderedWrites: AutoTmpWriteEntry[] = [];

  for (const blockId of deepBodyIds) {
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
      const valueInput = block.inputs['VALUE'];
      const entry: AutoTmpWriteEntry = {
        blockId,
        name,
        lowered,
        kind: 'set',
        valueInput,
        // Provisional emit name — finalised after topological sort so
        // the SSA suffix matches the topo index.
        emitName: '',
      };
      appendWrite(writesByName, entry, diagnostics);
      orderedWrites.push(entry);
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
      const deltaInput = block.inputs['VALUE'];
      const entry: AutoTmpWriteEntry = {
        blockId,
        name,
        lowered,
        kind: 'change',
        valueInput: deltaInput,
        deltaInput,
        emitName: '',
      };
      appendWrite(writesByName, entry, diagnostics);
      orderedWrites.push(entry);
      // Single info diagnostic per (name, regionId) so users get
      // actionable context — surfaces the intent for opt-in to explicit
      // `@map` or inlining.
      if (!wroteChangeInfoFor.has(lowered)) {
        wroteChangeInfoFor.add(lowered);
        diagnostics.push({
          severity: 'info',
          code: GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_CHANGEVARBY_IGNORED,
          message: `scratch variable '${name}' is mutated via 'change variable by' in region '${region.regionId}'; auto-tmp will emit a 'var' declaration so each thread keeps a per-thread mutable copy`,
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
        reads: new Map(),
        mutables: [],
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
  const nameSet = new Set(writesByName.keys());
  for (const write of orderedWrites) {
    const deps = collectAutoTmpDependencies(write.valueInput, project, nameSet);
    dependsOn.set(write.blockId, deps);
  }

  // Cycle detection (DFS coloring — `cascade-analysis.ts` is the
  // reference implementation for the same pattern over `@map`s).
  const cycle = detectAutoTmpCycle(orderedWrites, dependsOn);
  if (cycle) {
    const cyclePath = cycle.join(' -> ');
    return {
      valid: false,
      demoteReason: 'd1',
      bindings: [],
      reads: new Map(),
      mutables: [],
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
  // declarations above the body walk. `topoSortAutoTmp` returns
  // `set` writes in topological order; we then append `change` writes
  // for the same scratch var so the mutable-binding builder can pair
  // every change block with its scratch name.
  const topoOrder = topoSortAutoTmp(orderedWrites, dependsOn);
  for (const w of orderedWrites) {
    if (w.kind === 'change' && !topoOrder.includes(w)) topoOrder.push(w);
  }

  // Assign emit names per topo order. When a scratch var has multiple
  // `set` writes, every write gets its own SSA-unique emit name so
  // scratch reference semantics survive the immutability of WGSL `let`.
  // Single-write names keep the surface form so existing tests / WGSL
  // introspection patterns (`let tmp0: f32 = ...;`) survive unchanged.
  const writeCountByName = new Map<string, number>();
  for (const w of topoOrder) {
    writeCountByName.set(w.lowered, (writeCountByName.get(w.lowered) ?? 0) + 1);
  }
  for (let i = 0; i < topoOrder.length; i += 1) {
    const write = topoOrder[i]!;
    const total = writeCountByName.get(write.lowered) ?? 1;
    write.emitName = total > 1
      ? makeSsaEmitName(write.lowered, write.blockId, i)
      : safeIdentifierForName(write.lowered);
  }

  // Build per-name mutable bindings. A scratch var becomes `var` when
  // it has at least one `data_changevariableby`. The initial value is
  // the most-recent preceding `data_setvariableto` (forward scan); when
  // there's no preceding `set`, we initialise to 0.
  const mutables: AutoTmpMutableBinding[] = [];
  const latestEmitByName = new Map<string, string>();
  const initialValueByName = new Map<string, unknown>();
  for (const write of topoOrder) {
    if (write.kind === 'set') {
      latestEmitByName.set(write.lowered, write.emitName);
      if (!initialValueByName.has(write.lowered)) {
        // First `set` for this name wins as the `var` initialiser (we
        // need a single initial value; later sets overwrite via body
        // assignment statements).
        initialValueByName.set(write.lowered, write.valueInput);
      }
    } else {
      // `change`: the var's emit name is the LATEST SSA name for this
      // scratch var (so increments land on the same `var` declaration).
      const latestEmit = latestEmitByName.get(write.lowered);
      if (!latestEmit) {
        // `change` without preceding `set`: initialise to 0. The emit
        // name reuses the change-block hash so the WGSL body can find
        // the matching `var` declaration.
        latestEmitByName.set(write.lowered, write.emitName);
        initialValueByName.set(write.lowered, null);
      } else {
        write.emitName = latestEmit;
      }
      const initInput = initialValueByName.get(write.lowered) ?? null;
      mutables.push({
        name: write.name,
        lowered: write.lowered,
        emitName: latestEmit ?? write.emitName,
        initialInput: initInput,
        changeBlockIds: [
          ...(mutables.find((m) => m.lowered === write.lowered)?.changeBlockIds ?? []),
          write.blockId,
        ],
      });
    }
  }

  // Build the per-read resolution table. Reads (`data_variable` /
  // `data_variableof` for auto-tmp names) resolve to the latest
  // preceding `set` of the same name. We walk the deep body in order
  // and update `latestAtRead` as we cross each `set` block.
  const reads = new Map<string, string>();
  const latestAtRead = new Map<string, string>();
  for (const blockId of deepBodyIds) {
    const block = lookupBlock(project, blockId);
    if (!block) continue;
    if (block.opcode === 'data_setvariableto') {
      const name = readScratchVariableName(block);
      if (!name) continue;
      const lowered = name.toLowerCase();
      if (!nameSet.has(lowered)) continue;
      // Find the topo-ordered write that matches this block id.
      const write = orderedWrites.find((w) => w.blockId === blockId);
      if (write) latestAtRead.set(lowered, write.emitName);
      continue;
    }
    if (block.opcode === 'data_variable' || block.opcode === 'data_variableof') {
      const name = readScratchVariableName(block);
      if (!name) continue;
      const lowered = name.toLowerCase();
      const latest = latestAtRead.get(lowered);
      if (latest) reads.set(blockId, latest);
    }
  }

  // Materialise the bindings. The WGSL emitter calls `safeIdentifier`
  // on the surface name to derive `emitName` (handles reserved-word
  // collision uniformly with the existing rename pipeline).
  const bindings: AutoTmpBinding[] = topoOrder
    .filter((w) => w.kind === 'set')
    .map((write) => ({
      name: write.name,
      emitName: write.emitName,
      blockId: write.blockId,
      sourceBlockId: write.blockId,
    }));

  return {
    valid: true,
    bindings,
    reads,
    mutables,
    diagnostics,
  };
}

interface AutoTmpWriteEntry {
  blockId: string;
  name: string;
  lowered: string;
  kind: 'set' | 'change';
  valueInput: unknown;
  deltaInput?: unknown;
  emitName: string;
}

const wroteChangeInfoFor = new Set<string>();

function appendWrite(
  writesByName: Map<string, AutoTmpWriteEntry[]>,
  entry: AutoTmpWriteEntry,
  diagnostics: Diagnostic[],
): void {
  const existing = writesByName.get(entry.lowered);
  if (existing && existing.some((w) => w.kind === 'set') && entry.kind === 'set') {
    diagnostics.push({
      severity: 'warn',
      code: GPU_DIAGNOSTIC_CODES.SCRATCH_VARIABLE_DUPLICATE_WRITE,
      message: `scratch variable '${entry.name}' is written multiple times in region '${entry.blockId}'; SSA uniqueness keeps every write as its own 'let' so channel reads survive`,
      regionId: '',
      blockId: entry.blockId,
    });
  }
  const list = writesByName.get(entry.lowered) ?? [];
  list.push(entry);
  writesByName.set(entry.lowered, list);
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
 * Deep walk: starting from `inlinedBodyIds` (the kernel container's flat
 * `next` chain), recurse into every `control_repeat` / `control_if`
 * SUBSTACK / SUBSTACK2 input AND every input reference so the detector
 * sees writes that live inside a nested repeat body OR are reached via
 * an operator chain (= the user's `set idx1 = idx0` + `change idx1 by 1`
 * inside the inner pixel-axis loop pattern, and the
 * `data_variable tmp1` references inside the operator chains that
 * follow).
 *
 * Mirrors `region-extractor.ts:walkSubstackBody` exactly so the
 * auto-tmp-detector's read resolution sees every block the WGSL
 * emitter will lower.
 */
function collectDeepBodyIds(
  inlinedBodyIds: readonly string[],
  project: ParsedProject,
): string[] {
  const visited = new Set<string>();
  const out: string[] = [];

  function visit(blockId: string | null | undefined): void {
    if (!blockId || visited.has(blockId)) return;
    visited.add(blockId);
    out.push(blockId);
    const block = lookupBlock(project, blockId);
    if (!block) return;
    // Recurse into nested control flow first so any substack reads
    // are recorded before the parent's `next` chain continues.
    for (const key of ['SUBSTACK', 'SUBSTACK2'] as const) {
      const subId = extractBlockReference(block.inputs?.[key]);
      if (subId) visit(subId);
    }
    // Walk every input reference (= operator chain operands, list
    // read shadows, etc.) so the detector sees data_variable reporters
    // reached through operator chains. Same `extractBlockReference`
    // helper used by `region-extractor.ts:walkSubstackBody`.
    for (const value of Object.values(block.inputs ?? {})) {
      const refId = extractBlockReference(value);
      if (refId) visit(refId);
    }
    visit(block.next ?? null);
  }

  for (const blockId of inlinedBodyIds) visit(blockId);
  return out;
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
  candidateNames: ReadonlySet<string>,
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
        if (name && candidateNames.has(name)) deps.add(name);
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
 * `Map<blockId, Set<loweredName>>` shape produced here. Kept module-
 * local so the two cycle detectors can evolve independently.
 */
function detectAutoTmpCycle(
  writes: readonly AutoTmpWriteEntry[],
  dependsOn: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | null {
  enum Color {
    White,
    Gray,
    Black,
  }
  const color = new Map<string, Color>();
  const stack: string[] = [];
  for (const w of writes) color.set(w.blockId, Color.White);

  function visit(node: string): string[] | null {
    color.set(node, Color.Gray);
    stack.push(node);
    const children = dependsOn.get(node);
    if (children) {
      for (const next of children) {
        // Map the lowered-name dependency to the latest preceding
        // `set` write's block id. We scan all `set` writes in body
        // order; the DAG edge is "this write depends on the latest
        // prior `set` of `next`" (later writes mask earlier ones in
        // scratch reference semantics, so the cycle must close through
        // the most-recent preceding write).
        const targetBlockId = findLatestSetWrite(writes, next);
        if (!targetBlockId) continue;
        const c = color.get(targetBlockId) ?? Color.White;
        if (c === Color.Gray) {
          const idx = stack.indexOf(targetBlockId);
          if (idx >= 0) {
            return stack.slice(idx).concat(targetBlockId);
          }
          return [targetBlockId, node];
        }
        if (c === Color.White) {
          const r = visit(targetBlockId);
          if (r) return r;
        }
      }
    }
    stack.pop();
    color.set(node, Color.Black);
    return null;
  }

  for (const w of writes) {
    if ((color.get(w.blockId) ?? Color.White) === Color.White) {
      const r = visit(w.blockId);
      if (r) return r;
    }
  }
  return null;
}

/**
 * For a `data_setvariableto` write whose VALUE chain depends on the
 * (lowered) name `next`, find the latest `set` write of `next` in the
 * body's source order. The latest preceding write is the one a
 * `data_variableof`/`data_variable` reporter in `next`'s chain would
 * observe (scratch reads the most-recent prior assignment).
 */
function findLatestSetWrite(
  writes: readonly AutoTmpWriteEntry[],
  next: string,
): string | undefined {
  for (let i = writes.length - 1; i >= 0; i -= 1) {
    const w = writes[i];
    if (!w) continue;
    if (w.lowered !== next) continue;
    if (w.kind !== 'set') continue;
    return w.blockId;
  }
  return undefined;
}

/**
 * Kahn's topological sort. Stable when the cycle check above
 * guarantees acyclicity. The output is one valid topological order
 * of the auto-tmp bindings (= order in which the WGSL emitter will
 * emit `let` declarations).
 */
function topoSortAutoTmp(
  writes: readonly AutoTmpWriteEntry[],
  dependsOn: ReadonlyMap<string, ReadonlySet<string>>,
): AutoTmpWriteEntry[] {
  const setWrites = writes.filter((w) => w.kind === 'set');
  const blockIdToIndex = new Map<string, number>();
  for (let i = 0; i < setWrites.length; i += 1) {
    const w = setWrites[i]!;
    blockIdToIndex.set(w.blockId, i);
  }
  const inDegree = new Array<number>(setWrites.length).fill(0);
  const adj: number[][] = setWrites.map(() => []);
  for (const w of setWrites) {
    const deps = dependsOn.get(w.blockId);
    if (!deps) continue;
    for (const dep of deps) {
      // Find the latest preceding write of `dep` (by block-id order
      // in `writes`). If it exists in `setWrites`, that's the edge.
      const depBlockId = findLatestSetWrite(writes, dep);
      if (!depBlockId) continue;
      const depIdx = blockIdToIndex.get(depBlockId);
      if (depIdx === undefined) continue;
      adj[depIdx]!.push(blockIdToIndex.get(w.blockId)!);
      inDegree[blockIdToIndex.get(w.blockId)!]! += 1;
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < inDegree.length; i += 1) {
    if (inDegree[i] === 0) queue.push(i);
  }
  const out: AutoTmpWriteEntry[] = [];
  while (queue.length > 0) {
    const n = queue.shift();
    if (n === undefined) continue;
    out.push(setWrites[n]!);
    for (const m of adj[n] ?? []) {
      const d = (inDegree[m] ?? 0) - 1;
      inDegree[m] = d;
      if (d === 0) queue.push(m);
    }
  }
  return out;
}

/**
 * Generate a stable, SSA-unique WGSL identifier for one auto-tmp
 * write block. The naming scheme is `<safeName>_<shortHash>` where
 * the hash is the FNV-1a 32-bit digest of the block id (mirrors
 * `hashedIdentifier` from `wgsl-emitter.ts` so the runtime ABI stays
 * uniform across the GPU kernel pipeline).
 */
function makeSsaEmitName(loweredName: string, blockId: string, index: number): string {
  const safe = safeIdentifierForName(loweredName);
  return `${safe}_${shortHash(blockId)}_${index}`;
}

function safeIdentifierForName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `__tw_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function shortHash(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}
