/**
 * §Phase 5 (gpu-kernel-dsl-phase5-spec §5.1) — pre-parse inline
 * expansion of `procedure_call` blocks inside `@compute` region bodies.
 *
 * The inliner replaces every `procedure_call` in a region's `bodyBlockIds`
 * with the procedure prototype's body (deep-copied under fresh sprite-local
 * block ids), and rewires `argument_reporter_string` /
 * `argument_reporter_boolean` reporters inside the prototype body so they
 * point at the call-site's argument block ids. The function is pure: it
 * never mutates the input `region` or `project`.
 *
 * Cycle detection
 * ---------------
 * Visits are tracked via a `Set<string>` of original prototype block ids.
 * If the same prototype id re-enters within a single inlining tree,
 * `gpu.procedure_recursion_unsupported` fires immediately. The set is
 * threaded through recursive expansion so mutual recursion
 * (proc A -> proc B -> proc A) trips at the second `A` visit, regardless
 * of depth.
 *
 * Depth limit
 * -----------
 * `MAX_INLINING_DEPTH` (16, exported from `src/utils/constants.ts`) caps
 * the deepest possible call chain. The check fires before each body walk
 * so an over-long chain short-circuits without expanding blocks. The
 * depth counter is the only guard against runaway straight chains —
 * the visited-set does not bound depth because a chain
 * `proc[1] -> proc[2] -> ... -> proc[17]` revisits no prototype.
 *
 * Note on `@compute` placement
 * ----------------------------
 * Phase 4's loose-position form (`@compute` on the `control_repeat`
 * itself) means a procedure body may itself contain a `control_repeat`
 * that carries its own `@compute` marker. We do not extract such nested
 * regions here; the inliner walks the body for further `procedure_call`
 * sites only. A deeply-inlined prototype's own `@compute` region would
 * still be detected by a separate region-extractor pass over the same
 * sprite — outside Phase 5's scope.
 */
import { MAX_INLINING_DEPTH } from '@/utils/constants';
import { extractBlockReference } from './block-reference';
import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import type {
  Diagnostic,
  ExtractedRegion,
  ParsedProject,
  ParsedTarget,
  RawBlock,
} from './types';

export interface InlineResult {
  /**
   * Inlined `bodyBlockIds`. Each id is either a fresh sprite-local
   * string (for blocks inside an inlined prototype body) or the
   * original block id (for body blocks outside any inlined prototype).
   */
  bodyBlockIds: string[];
  /**
   * `freshId -> originalId` map for every block produced by the
   * inliner. Empty when no procedure_call was encountered. Diagnostic /
   * `__exposeForBrowserVerify` only — the dispatcher does not consult
   * this map (it uses canonical keys, not block ids).
   */
  freshBlockIdMappings: Map<string, string>;
  /**
   * `freshId -> originalId` map for `control_repeat` blocks that ended
   * up inside an inlined prototype body. The WGSL emitter and
   * `bound-block-validator.ts` consume this so that a `@repeat`
   * directive authored against a prototype's `control_repeat` continues
   * to resolve to the same logical block after inlining renumbers
   * internal ids.
   *
   * Empty when no inlining happened, or when the inlined prototype body
   * contained no `control_repeat` blocks.
   */
  boundBlockIdRemaps: Map<string, string>;
  /**
   * Deduplicated list of `procedures_prototype` block ids that were
   * inlined. Surfaced via `ExtractedRegion.inlinedPrototypeBlockIds` so
   * `kernel-registry.ts:registerDispatch` and `region-extractor.ts`
   * can follow up on canonical-key sharing.
   */
  inlinedPrototypeBlockIds: string[];
  /**
   * Diagnostics from the inliner pass. Empty on success. Errors force a
   * D1 demote via the upstream `buildBlockSubsetVerdict` channel.
   */
  diagnostics: Diagnostic[];
}

/**
 * Top-level inliner entry point. The default `depth = 0` and
 * `visitedPrototypeIds = empty set` are suitable for the initial region;
 * recursive expansion increments `depth` and clones the visited set so
 * each tree branch can independently track its prototypes.
 */
export function inlineProcedures(
  region: ExtractedRegion,
  project: ParsedProject,
  spriteId: string,
  depth: number = 0,
  visitedPrototypeIds: Set<string> = new Set(),
): InlineResult {
  const sprite = project.targets.find((t) => t.id === spriteId);
  if (!sprite) {
    return {
      bodyBlockIds: [...region.bodyBlockIds],
      freshBlockIdMappings: new Map(),
      boundBlockIdRemaps: new Map(),
      inlinedPrototypeBlockIds: [],
      diagnostics: [
        {
          severity: 'error',
          code: GPU_DIAGNOSTIC_CODES.PROCEDURE_RECURSION_UNSUPPORTED,
          regionId: region.regionId,
          blockId: region.blockId,
          message: `procedure-inliner: sprite "${spriteId}" not found in project`,
        },
      ],
    };
  }

  // §Phase 5 §5.1 — depth ceiling check fires before the body walk so an
  // over-long chain short-circuits without expanding blocks. The depth
  // counter increments by 1 per recursive expansion step.
  if (depth > MAX_INLINING_DEPTH) {
    return {
      bodyBlockIds: [...region.bodyBlockIds],
      freshBlockIdMappings: new Map(),
      boundBlockIdRemaps: new Map(),
      inlinedPrototypeBlockIds: [],
      diagnostics: [
        {
          severity: 'error',
          code: GPU_DIAGNOSTIC_CODES.PROCEDURE_RECURSION_UNSUPPORTED,
          regionId: region.regionId,
          blockId: region.blockId,
          message: `procedure inlining depth exceeded ${MAX_INLINING_DEPTH}; suspected deep chain or recursion`,
        },
      ],
    };
  }

  const generator = createBlockIdGenerator(sprite);
  const ctx: InlineContext = {
    blocks: sprite.blocks,
    generator,
    freshBlockIdMappings: new Map(),
    boundBlockIdRemaps: new Map(),
    inlinedPrototypeBlockIds: [],
    diagnostics: [],
    depth,
    visitedPrototypeIds,
  };

  const newBodyBlockIds: string[] = [];
  for (const blockId of region.bodyBlockIds) {
    const block = ctx.blocks[blockId];
    if (!block) continue;

    if (!isProcedureCallOpcode(block.opcode)) {
      newBodyBlockIds.push(blockId);
      continue;
    }

    const expansion = expandCall(block, ctx, region);
    newBodyBlockIds.push(...expansion.newBlockIds);
  }

  return {
    bodyBlockIds: newBodyBlockIds,
    freshBlockIdMappings: ctx.freshBlockIdMappings,
    boundBlockIdRemaps: ctx.boundBlockIdRemaps,
    inlinedPrototypeBlockIds: dedup(ctx.inlinedPrototypeBlockIds),
    diagnostics: ctx.diagnostics,
  };
}

/**
 * Mutable expansion context threaded through every recursive call so
 * fresh-id generation, mapping tables, and depth bookkeeping share one
 * canonical state per top-level `inlineProcedures` invocation.
 */
interface InlineContext {
  blocks: Record<string, RawBlock>;
  generator: () => string;
  freshBlockIdMappings: Map<string, string>;
  boundBlockIdRemaps: Map<string, string>;
  inlinedPrototypeBlockIds: string[];
  diagnostics: Diagnostic[];
  depth: number;
  visitedPrototypeIds: Set<string>;
}

/**
 * Expand a single `procedure_call` block against the inliner's current
 * context. Returns the fresh-id'd body block ids (in document order)
 * that should replace the call site.
 */
function expandCall(
  callSite: RawBlock,
  ctx: InlineContext,
  region: ExtractedRegion,
): { newBlockIds: string[] } {
  const proccode = readProccode(callSite);
  const prototype = findProcedurePrototype(ctx.blocks, proccode);
  if (!prototype) {
    ctx.diagnostics.push({
      severity: 'error',
      code: GPU_DIAGNOSTIC_CODES.PROCEDURE_PROTOTYPE_NOT_FOUND,
      regionId: region.regionId,
      blockId: callSite.id,
      message: `procedure prototype for proccode "${proccode}" not found`,
    });
    return { newBlockIds: [] };
  }

  if (ctx.visitedPrototypeIds.has(prototype.id)) {
    ctx.diagnostics.push({
      severity: 'error',
      code: GPU_DIAGNOSTIC_CODES.PROCEDURE_RECURSION_UNSUPPORTED,
      regionId: region.regionId,
      blockId: callSite.id,
      message: `procedure prototype "${proccode}" (${prototype.id}) appears in call cycle; recursion not supported`,
    });
    return { newBlockIds: [] };
  }

  // §Phase 5 §5.1 — depth increment happens on every nested expansion.
  if (ctx.depth + 1 > MAX_INLINING_DEPTH) {
    ctx.diagnostics.push({
      severity: 'error',
      code: GPU_DIAGNOSTIC_CODES.PROCEDURE_RECURSION_UNSUPPORTED,
      regionId: region.regionId,
      blockId: callSite.id,
      message: `procedure inlining depth exceeded ${MAX_INLINING_DEPTH}; suspected deep chain or recursion`,
    });
    return { newBlockIds: [] };
  }

  const childCtx: InlineContext = {
    blocks: ctx.blocks,
    generator: ctx.generator,
    freshBlockIdMappings: ctx.freshBlockIdMappings,
    boundBlockIdRemaps: ctx.boundBlockIdRemaps,
    inlinedPrototypeBlockIds: ctx.inlinedPrototypeBlockIds,
    diagnostics: ctx.diagnostics,
    depth: ctx.depth + 1,
    visitedPrototypeIds: new Set(ctx.visitedPrototypeIds),
  };
  childCtx.visitedPrototypeIds.add(prototype.id);

  const argumentNames = readArgumentNames(prototype);
  const callSiteArgs = collectCallSiteArguments(callSite, argumentNames);

  const substackId = extractBlockReference(prototype.inputs['SUBSTACK']);
  const substackEntry = substackId ? ctx.blocks[substackId] : undefined;
  if (!substackId || !substackEntry) {
    // A prototype with no body still consumes one call site — record
    // the inlined id but emit no body blocks.
    ctx.inlinedPrototypeBlockIds.push(prototype.id);
    return { newBlockIds: [] };
  }

  const newBlockIds = walkPrototypeBody(
    substackEntry,
    callSiteArgs,
    childCtx,
  );

  ctx.inlinedPrototypeBlockIds.push(prototype.id);
  return { newBlockIds };
}

/**
 * Walk a prototype's body, emitting fresh-id'd copies of every block
 * while substituting `argument_reporter_*` blocks with their call-site
 * argument references. `procedure_call` blocks encountered inside the
 * prototype body are expanded recursively (depth + visited-set
 * bound).
 */
function walkPrototypeBody(
  substackEntry: RawBlock,
  callSiteArgs: ReadonlyMap<string, string>,
  ctx: InlineContext,
): string[] {
  const newBlockIds: string[] = [];
  const oldToNew = new Map<string, string>();

  // Stack contains block ids we still need to visit. We push substack
  // entries first (in document order), then process them in LIFO order
  // (= depth-first). For each block id we either rewire it to a
  // call-site argument (reporter substitution), inline it (procedure
  // callsite), or allocate a fresh id and recurse into its sub-blocks.
  const stack: string[] = [substackEntry.id];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || oldToNew.has(currentId)) continue;

    const oldBlock = ctx.blocks[currentId];
    if (!oldBlock) continue;

    // §Phase 5 §5.1 — `argument_reporter_string` /
    // `argument_reporter_boolean` get replaced by the call-site's
    // matching argument block id. We do NOT allocate a fresh id; the
    // call-site's argument block is shared across every inlined call
    // site within the same region. The replacement id is also pushed
    // into `newBlockIds` so downstream consumers
    // (`block-subset.collectReachableBlocks`) walk the substituted
    // argument and surface its opcodes in the body's D1 / D2 verdict.
    if (isArgumentReporterOpcode(oldBlock.opcode)) {
      const argName = readArgumentReporterName(oldBlock);
      const replacement = argName ? callSiteArgs.get(argName) : undefined;
      if (replacement) {
        oldToNew.set(currentId, replacement);
        newBlockIds.push(replacement);
        continue;
      }
    }

    if (isProcedureCallOpcode(oldBlock.opcode)) {
      // Recursively inline further calls inside the prototype body.
      // The expanded body blocks are emitted in document order, but
      // their `next` chain keeps the original scratch order. We emit
      // them into the running output BEFORE continuing the outer
      // walk so the upstream `inlineProcedures` body ordering
      // matches the resulting scratch semantics.
      const nested = expandCall(oldBlock, ctx, substackEntryRegion());
      newBlockIds.push(...nested.newBlockIds);
      oldToNew.set(currentId, '__inlined_into_parent__');
      continue;
    }

    const newId = ctx.generator();
    oldToNew.set(currentId, newId);
    ctx.freshBlockIdMappings.set(newId, currentId);

    if (oldBlock.opcode === 'control_repeat') {
      ctx.boundBlockIdRemaps.set(newId, currentId);
    }

    newBlockIds.push(newId);

    if (typeof oldBlock.next === 'string') stack.push(oldBlock.next);
    for (const value of Object.values(oldBlock.inputs)) {
      const refId = extractBlockReference(value);
      if (refId) stack.push(refId);
    }
  }

  return newBlockIds;
}

/**
 * Stub region used when emitting diagnostics from inside the prototype
 * body walker. The region's `regionId` / `blockId` aren't meaningful for
 * inner-call diagnostics (the outer region is what the user sees in the
 * ErrorLogPanel), but the field contract of `Diagnostic` requires a
 * shape we can synthesize cheaply.
 */
function substackEntryRegion(): ExtractedRegion {
  return {
    regionId: 'procedure-inliner:nested',
    blockId: 'procedure-inliner:nested',
    spriteId: '',
    commentId: '',
    firstSubstackBlockId: '',
    bodyBlockIds: [],
    kernelContainerBlockId: '',
    repeatPathTable: {},
    regionIndex: 0,
    inlinedPrototypeBlockIds: [],
    commentAnchorBlockId: '',
  };
}

/**
 * Read the `proccode` field off a `procedure_call` /
 * `procedures_prototype` block's mutation object. Scratch stores it
 * as `mutation.proccode` (a string like `"fn apply_expo %s"`).
 */
function readProccode(callBlock: RawBlock): string {
  const mutation = callBlock.mutation;
  if (!mutation || typeof mutation !== 'object') return '';
  const proccode = (mutation as Record<string, unknown>)['proccode'];
  return typeof proccode === 'string' ? proccode : '';
}

/**
 * Recognise both the official scratch opcode (`procedures_call`) and the
 * legacy in-repo alias (`procedure_call`) used by GPU-内部 DTOs and
 * older fixtures. The official form is what a pure-Scratch project
 * would carry; the alias is preserved for backward compatibility with
 * existing tests and in-memory block shapes.
 */
function isProcedureCallOpcode(opcode: string): boolean {
  return opcode === 'procedure_call' || opcode === 'procedures_call';
}

/**
 * Recognise both the official scratch argument reporter opcodes
 * (`argument_reporter_string_number` / `argument_reporter_boolean`) and
 * the legacy in-repo aliases (`argument_reporter_string` /
 * `argument_reporter_boolean`). The official reporters store the
 * argument name in `fields.VALUE`; the legacy aliases used
 * `fields.VARIABLE`. `readArgumentReporterName` accepts both shapes.
 */
function isArgumentReporterOpcode(opcode: string): boolean {
  return (
    opcode === 'argument_reporter_string' ||
    opcode === 'argument_reporter_string_number' ||
    opcode === 'argument_reporter_boolean'
  );
}

/**
 * Locate a `procedures_prototype` block whose `mutation.proccode`
 * matches the call site's `proccode`. Scratch UI keeps procedure names
 * unique per sprite — the first match wins.
 */
function findProcedurePrototype(
  blocks: Record<string, RawBlock>,
  proccode: string,
): RawBlock | null {
  if (!proccode) return null;
  for (const candidate of Object.values(blocks)) {
    if (!candidate) continue;
    if (candidate.opcode !== 'procedures_prototype') continue;
    if (readProccode(candidate) !== proccode) continue;
    return candidate;
  }
  return null;
}

/**
 * Read the `argumentnames` field off a `procedures_prototype` block's
 * mutation. Scratch encodes it as a JSON string of `string[]`.
 */
function readArgumentNames(prototype: RawBlock): string[] {
  const mutation = prototype.mutation;
  if (!mutation || typeof mutation !== 'object') return [];
  const raw = (mutation as Record<string, unknown>)['argumentnames'];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

/**
 * Read the argument name off an `argument_reporter_string` /
 * `argument_reporter_boolean` block. The reporter's `fields.VARIABLE`
 * holds either `[name, null]` (the primitive-field shape) or
 * `{ id, name }` (a variable reference). We tolerate both shapes — the
 * spec only requires the surface name for the inliner.
 */
function readArgumentReporterName(block: RawBlock): string | null {
  const fields = block.fields;
  const variable = fields['VARIABLE'];
  if (typeof variable === 'string') return variable;
  if (Array.isArray(variable) && typeof variable[0] === 'string') {
    return variable[0];
  }
  if (variable && typeof variable === 'object') {
    const name = (variable as Record<string, unknown>)['name'];
    if (typeof name === 'string') return name;
  }
  return null;
}

/**
 * Build the `argName -> callSiteBlockId` map for a `procedure_call`
 * site. The call site carries one input per named argument, named
 * `arg0`, `arg1`, ... in declaration order. Inputs that are not
 * present (or are null) are dropped from the map; the prototype body
 * walker treats missing reporters as no-ops (the reporter block gets a
 * fresh id and survives inlined).
 */
function collectCallSiteArguments(
  callSite: RawBlock,
  argumentNames: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argumentNames.length; i += 1) {
    const inputKey = `arg${i}`;
    const raw = callSite.inputs[inputKey];
    const refId = extractBlockReference(raw);
    if (refId) {
      out.set(argumentNames[i]!, refId);
    }
  }
  return out;
}

/**
 * Allocate sprite-local fresh block ids. The `__tw_inl_<sprite>_<n>`
 * prefix is visibly distinct from any genuine scratch block id so
 * tests can grep for "no scratch collision" with confidence.
 */
function createBlockIdGenerator(target: ParsedTarget): () => string {
  let counter = 0;
  // Reserve a starting offset that's safely beyond any plausible
  // project id. Tests that synthesise ids via `mkBlock` typically start
  // at single-digit counters so 1k leaves room without making the
  // printed ids unreadable.
  const base = 1_000;
  return () => {
    counter += 1;
    return `__tw_inl_${target.id}_${(base + counter).toString(36)}`;
  };
}

function dedup(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of list) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
