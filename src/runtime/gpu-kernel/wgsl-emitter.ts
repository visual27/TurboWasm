import { rewriteFormula } from './formula-rewrite';
import { scratchCompatHeader } from './scratch-compat';
import { shouldSkipBlock, type SkipBlockContext } from './skip-block-filter';
import {
  createScalarUniformBindings,
  type ScalarUniformBinding,
} from './scalar-uniform-binding';
import { extractBlockReference } from './block-reference';
import { scratchBlockToWgslExpr, type ScratchBlockExprContext } from './scratch-block-expr';
import type {
  AutoTmpBinding,
  AxisFinal,
  BindDirective,
  Diagnostic,
  ExtractedRegion,
  MapDirective,
  ParsedProject,
  RawBlock,
  RegionVerdict,
  RepeatDirective,
  ResolvedRepeatDirective,
  WorkgroupSizeDirective,
} from './types';

/**
 * Structural subset of `RepeatDirective` that `renameIdentifiers` reads.
 * Defined as a local type to keep the function signature stable across
 * future field additions.
 *
 * §Phase 2 (15.3): the `MaxDirectiveLike` companion was removed
 * alongside the `@max` directive. There is no longer a quoted group
 * name to alias through `internalName` for `@max`, and the dispatch
 * cap is now derived from the runtime list length at `emitRegion` time.
 */
export type RepeatDirectiveLike = Pick<ResolvedRepeatDirective, 'name' | 'internalName'>;

/**
 * §Phase 4: the emit helper that decides parallel / sequential / no-
 * directive for a single `control_repeat` block.
 */
function targetFinalAxis(
  _block: RawBlock,
  directive: ResolvedRepeatDirective | undefined,
  context: EmitterContext,
): AxisFinal {
  if (directive) {
    return context.axisVerdicts[directive.name]?.finalAxis ?? directive.axis;
  }
  // No directive at all → sequential fallback driven by the scratch
  // `inputs.TIMES` chain. We do not try to detect "the user forgot
  // the @repeat" here; that is `repeat-path-resolver.ts`'s job
  // (D1 demote via `repeat_path_required`). The emitter just makes
  // the missing-directive case produce a runnable `for` so the
  // fallback path can compile.
  return 'sequential';
}

/**
 * Emit the body of a `control_repeat` block.
 *
 * - parallel target: no `for` wrapper; emit the `SUBSTACK` body
 *   directly (the dispatcher / dispatch dimensions carry the
 *   iteration count).
 * - sequential target: wrap the body in a WGSL `for` driven by the
 *   directive's formula (or the scratch `inputs.TIMES` chain when
 *   no directive exists).
 */
function emitResolvedRepeat(
  block: RawBlock,
  directive: ResolvedRepeatDirective | undefined,
  context: EmitterContext,
): string[] {
  const substackId = extractBlockReference(block.inputs['SUBSTACK']);
  const substackEntry = substackId ? context.blocks[substackId] : undefined;
  const bodyLines = substackEntry ? emitStatementChain(substackEntry.id, context) : [];

  const finalAxis = targetFinalAxis(block, directive, context);
  if (finalAxis === 'sequential' || finalAxis.startsWith('local_')) {
    return wrapInForLoop(block, directive, bodyLines, context);
  }
  return bodyLines;
}

/**
 * Wrap `bodyLines` in a WGSL `for` driven by either the directive's
 * formula or the scratch `inputs.TIMES` chain.
 *
 * The loop counter is renamed through the same `renameTable` as the
 * directive name (so `R0` → `R0`, quoted `R0` → `__tw_<hash>`,
 * etc.). When the directive axis is `sequential` and the directive is
 * missing, we fall back to a stable `<block>_counter` local.
 */
function wrapInForLoop(
  block: RawBlock,
  directive: ResolvedRepeatDirective | undefined,
  bodyLines: readonly string[],
  context: EmitterContext,
): string[] {
  const counterName = directive
    ? context.renameTable[directive.name] ?? directive.name
    : `__tw_counter_${shortHash(block.id)}`;
  const formula = directive
    ? emitFormula(directive.formula, directive, context)
    : emitTimesFromScratch(block, context);

  return [
    '{',
    `  var ${counterName}: u32 = 0u;`,
    `  loop {`,
    `    if (${counterName} >= u32(${formula})) { break; }`,
    ...bodyLines.map((line) => `    ${line}`),
    `    ${counterName} = ${counterName} + 1u;`,
    `  }`,
    `}`,
  ];
}

/**
 * Render a Scratch `inputs.TIMES` reporter chain as a WGSL expression
 * via `emitInput`. Used when a body-side `control_repeat` has no
 * matching `@repeat` directive.
 */
function emitTimesFromScratch(block: RawBlock, context: EmitterContext): string {
  const times = block.inputs['TIMES'];
  if (times === undefined) return '1';
  return emitInput(times, context);
}

export interface EmitInput {
  regionVerdict: RegionVerdict;
  parsedProject: ParsedProject;
  runtimeState?: { listLengths: Record<string, number> };
  /**
   * Optional device workgroup limits. When provided, `clampWorkgroupSize`
   * clamps against these instead of the conservative defaults — this
   * matches the real WebGPU device's `maxComputeWorkgroupSizeX/Y/Z` and
   * `maxComputeInvocationsPerWorkgroup`. Tests can omit this field to
   * exercise the conservative default path.
   */
  workgroupLimits?: WorkgroupLimits;
  /**
   * Phase 2: original `ExtractedRegion` (Phase 0 出力)。Phase 1 で
   * RegionVerdict 構築時に `kernelContainerBlockId` /
   * `nestedRepeatContainerBlockIds` が伝搬済みなので通常は不要。
   * テストや caller が RegionVerdict を直接構築する経路では省略される。
   *
   * RegionVerdict から取得できない場合のみ fallback として渡される。
   * (`region-verdict-pipeline.ts` 経由の正経路では使用されない。)
   */
  extractedRegion?: ExtractedRegion;
}

export interface WorkgroupSize {
  x: number;
  y: number;
  z: number;
}

export interface WorkgroupLimits {
  maxComputeWorkgroupSizeX: number;
  maxComputeWorkgroupSizeY: number;
  maxComputeWorkgroupSizeZ: number;
  maxComputeInvocationsPerWorkgroup: number;
}

export interface DispatchPlan {
  /** Dispatch workgroup count along X (ceil of extent / workgroupSize.x). */
  x: string;
  /** Dispatch workgroup count along Y. */
  y: string;
  /** Dispatch workgroup count along Z. */
  z: string;
}

export interface IdentifierRenameResult {
  renameTable: Record<string, string>;
  /** Diagnostics for collisions on either `@map` names or `@bind` names. */
  diagnostics: Diagnostic[];
  /** Subset of renameTable covering only `@bind` names. */
  bindingRenames: Record<string, string>;
}

export interface EmitResult {
  wgsl: string;
  diagnostics: Diagnostic[];
  /**
   * Structured dispatch plan — single source of truth for the runtime
   * dispatcher. `// dispatchWorkgroups(...)` inside the emitted WGSL is
   * documentary; `__dispatch-kernel-sync` reads this and computes the
   * integer dispatch extent.
   */
  dispatchPlan: DispatchPlan;
  /** Resolved (post-clamp) workgroup size for this region. */
  workgroupSize: WorkgroupSize;
  /**
   * §Phase 3 — scalar uniform bindings derived from `@bind ..., scalar`
   * directives. Empty array when the kernel has no scalar bindings.
   * The runtime dispatcher reads this to:
   *
   *   1. Allocate a `@group(1) @binding(0)` uniform buffer.
   *   2. Build the group-1 bind group.
   *   3. Refresh scalar values per dispatch via
   *      `runtime.readScalar(...)`.
   *   4. Evaluate `dispatchPlan.*` WGSL expressions against the live
   *      scalar snapshot.
   *
   * `wgslName` is the field name in the emitted `ScratchUniforms`
   * struct (= renameTable applied for quoted-name bindings).
   */
  scalarBindings: readonly ScalarUniformBinding[];
}

const DEFAULT_WORKGROUP_SIZE: WorkgroupSize = { x: 64, y: 1, z: 1 };
const DEFAULT_WORKGROUP_LIMITS: WorkgroupLimits = {
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeInvocationsPerWorkgroup: 256,
};

/** Reserved WGSL keywords + the kernel-parameter names we generate. */
const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  // WGSL keywords (subset large enough to cover anything likely to
  // collide with a user `@map` or `@bind` name).
  'alias',
  'array',
  'asm',
  'bf16',
  'bool',
  'break',
  'builtin',
  'case',
  'compute',
  'const',
  'const_assert',
  'continue',
  'continuing',
  'default',
  'discard',
  'dispatch',
  'do',
  'else',
  'enable',
  'enum',
  'f16',
  'f32',
  'f64',
  'false',
  'fn',
  'for',
  'global_invocation_id',
  'handle',
  'i8',
  'i16',
  'i32',
  'i64',
  'if',
  'let',
  'local_invocation_id',
  'loop',
  'mat',
  'override',
  'premerge',
  'regardless',
  'requires',
  'return',
  'struct',
  'switch',
  'true',
  'typedef',
  'u8',
  'u16',
  'u32',
  'u64',
  'unless',
  'using',
  'var',
  'vec',
  'void',
  'while',
  'workgroup_id',
  // Kernel parameter names generated by the emitter. User `@map`/`@bind`
  // names that collide with these would silently overwrite the WGSL
  // declaration; we force a rename instead. The legacy `gid`/`lid`/
  // `wid` (short-form kernel parameter names) are no longer emitted —
  // the emitter always uses `__tw_gid`/`__tw_lid`/`__tw_wid`, so user
  // `@map gid <- 0` etc. survive verbatim.
  '__tw_gid',
  '__tw_lid',
  '__tw_wid',
]);

const KNOWN_FORMULA_FUNCTIONS: ReadonlySet<string> = new Set([
  'select',
  'min',
  'max',
  'clamp',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'pow',
  'exp',
  'log',
  'floor',
  'ceil',
  'fract',
  'abs',
  'sqrt',
  'radians',
  'degrees',
  'mix',
  'step',
  'f32',
  'i32',
  'u32',
  'scratch_div',
  'scratch_mod',
  'scratch_index_clamp',
  'scratch_list_read_f32',
  'scratch_list_read_i32',
  'scratch_list_read_u32',
  'scratch_list_write_f32',
  'scratch_list_write_u32',
  'scratch_bool',
]);

/**
 * Reciprocal of the natural logarithm of 10. Used by the scratch
 * `operator_mathop "log"` (base-10) lowering to keep `log(10.0)` from
 * being recomputed on every invocation. Defined here so it is part of
 * the WGSL compat header and survives WGSL's `const` evaluation.
 */
const LOG10_RECIPROCAL_EXPR = '(1.0 / log(10.0))';

const BINARY_INPUTS: Readonly<Record<string, readonly [string, string]>> = {
  operator_add: ['NUM1', 'NUM2'],
  operator_subtract: ['NUM1', 'NUM2'],
  operator_multiply: ['NUM1', 'NUM2'],
  operator_divide: ['NUM1', 'NUM2'],
  operator_mod: ['NUM1', 'NUM2'],
  operator_gt: ['OPERAND1', 'OPERAND2'],
  operator_lt: ['OPERAND1', 'OPERAND2'],
  operator_equals: ['OPERAND1', 'OPERAND2'],
  operator_and: ['OPERAND1', 'OPERAND2'],
  operator_or: ['OPERAND1', 'OPERAND2'],
};

interface EmitterContext {
  regionId: string;
  blocks: Record<string, RawBlock>;
  bindings: BindDirective[];
  bindingNames: Map<string, string>;
  lengthNames: Map<string, string>;
  renameTable: Record<string, string>;
  /** Maps a binding directive name to its emitted WGSL symbol. */
  bindingRenameTable: Record<string, string>;
  mapNames: Set<string>;
  /** Names declared via `@bind` (case-preserving). */
  bindNames: Set<string>;
  sequentialNames: Set<string>;
  diagnostics: Diagnostic[];
  diagnosedBlocks: Set<string>;
  expressionStack: Set<string>;
  /** Phase 2: skip-set (effectivePatterns) for body emission. */
  skipContext: SkipBlockContext;
  /**
   * §Phase 4: every `@repeat` directive keyed by its
   * `resolvedRepeatBlockId`. The structured emit consults this map
   * to decide whether a target `control_repeat` runs in parallel,
   * in a structural `for`, or without a directive (= sequential
   * fallback driven by the scratch TIMES input).
   */
  repeatByBlockId: ReadonlyMap<string, ResolvedRepeatDirective>;
  /**
   * §Phase 4: per-`@repeat` axis verdicts (`sequential` /
   * parallel). Used by `emitStatement` / `emitResolvedRepeat` to
   * decide whether to emit a `for` wrapper or to thread the body
   * through as-is.
   */
  axisVerdicts: Readonly<Record<string, { finalAxis: AxisFinal }>>;
  /**
   * §Phase 6 — scratch auto-tmp bindings (topologically ordered).
   * `data_setvariableto` blocks whose target is in this set emit
   * nothing at body position (the `let` declaration was already
   * emitted above the body walk). `data_variableof` reporters
   * resolve to the emit identifier through `scratchBlockToWgslExpr`'s
   * `autoTmpEmitNames` lookup.
   */
  autoTmpBindings: readonly AutoTmpBinding[];
  /**
   * §Phase 6 — case-insensitive name lookup for auto-tmp emit
   * identifiers. Built from `autoTmpBindings`. Lower-case keys mirror
   * scratch's case-insensitive variable semantics.
   */
  autoTmpEmitNames: Readonly<Record<string, string>>;
  /**
   * §Phase 6 (extended) — SSA-uniqueness resolution table. Maps every
   * `data_variable` / `data_variableof` block id that targets an
   * auto-tmp scratch var to the resolved SSA emit name (= the
   * `let <name>_<hash>_<index>: f32 = ...;` declared for the most-
   * recent preceding write). The emitter consults this when lowering
   * expression contexts (operators, list reads) so a read between
   * two `set tmp1 ...` writes sees the latest value, mirroring
   * scratch's reference semantics.
   */
  autoTmpReads?: ReadonlyMap<string, string>;
  /**
   * §Phase 6 (extended) — per-scratch-var mutable bindings. Empty when
   * no scratch var has a `data_changevariableby` block in the body.
   * The emitter emits one `var <emitName>: f32 = <initial>;`
   * declaration per entry above the body walk, then emits
   * `<emitName> = <emitName> + <delta>;` at each `data_changevariableby`
   * body position.
   */
  autoTmpMutables?: readonly {
    name: string;
    emitName: string;
    initialInput: unknown;
    changeBlockIds: readonly string[];
  }[];
  /**
   * §Phase 6 (extended) — `data_changevariableby` block id → owning
   * mutable binding. The emitter looks up the block id at body
   * position to emit `<emitName> = <emitName> + <delta>;`.
   */
  autoTmpMutableByChangeBlockId?: ReadonlyMap<string, { emitName: string; initialInput: unknown }>;
  /**
   * §Phase 5 — surface name → `u_scratch.<wgsl_name>` field for any
   * `@bind ..., scalar` directive. Used by `emitBlockExpression` so
   * `data_variable` references inside expression contexts (e.g. as
   * the `INDEX` slot of `data_itemoflist`) resolve to the same
   * scalar uniform that `scratchBlockToWgslExpr` would produce for
   * the same reporter. Mirrors `scalarBindings[*].wgslName` so the
   * host ABI lookup stays in one place.
   */
  scalarFieldNames?: ReadonlyMap<string, string>;
}

export function clampWorkgroupSize(
  size: Readonly<WorkgroupSize>,
  limits: Readonly<WorkgroupLimits>,
): WorkgroupSize {
  const maxInvocations = positiveInteger(limits.maxComputeInvocationsPerWorkgroup);
  const x = clampDimension(size.x, limits.maxComputeWorkgroupSizeX, maxInvocations);
  const remainingAfterX = Math.max(1, Math.floor(maxInvocations / x));
  const y = clampDimension(size.y, limits.maxComputeWorkgroupSizeY, remainingAfterX);
  const remainingAfterY = Math.max(1, Math.floor(remainingAfterX / y));
  const z = clampDimension(size.z, limits.maxComputeWorkgroupSizeZ, remainingAfterY);
  return { x, y, z };
}

/**
 * Rename identifiers that collide with reserved keywords or other
 * declared names. We collapse `@map` names, `@bind` names, and the
 * emitter-internal parameter names into a single collision map so a
 * user `@bind` named `let` doesn't shadow the WGSL `let` keyword.
 *
 * The returned `bindingRenames` is the subset that covers `@bind`
 * names; the runtime bridge uses it to rewrite the `LIST` field of
 * `data_variable` blocks when they're emitted.
 */
export function renameIdentifiers(
  maps: readonly MapDirective[],
  bindings: readonly BindDirective[] = [],
  regionId = '',
  repeats: readonly RepeatDirectiveLike[] = [],
): IdentifierRenameResult {
  const renameTable: Record<string, string> = {};
  const bindingRenames: Record<string, string> = {};
  const diagnostics: Diagnostic[] = [];
  const occupied = new Set<string>();

  // Seed `occupied` with already-emitted parameter names. Without this
  // step a user `@map gid` would silently overwrite the kernel gid
  // parameter; renaming forces an explicit, observable conflict. We do
  // NOT pre-seed binding / map names here — adding them to `occupied`
  // before the rename loop would make every name look like a duplicate
  // of itself and force a rename.
  for (const reserved of ['__tw_gid', '__tw_lid', '__tw_wid']) {
    occupied.add(reserved);
  }

  // 1. @bind names first — these are referenced by `data_variable` blocks
  //    in the body, so a collision with a WGSL keyword must rename before
  //    the body is emitted.
  for (const binding of bindings) {
    if (!binding.name) continue;
    // §Phase E: quoted names (e.g. `@bind "my list"(0) rw f32`) carry an
    // `internalName` set by the parser. The surface name may contain
    // characters that are illegal in a WGSL identifier (spaces,
    // punctuation) so it must be aliased to `internalName` for every
    // formula rewrite — not just when it collides with a reserved
    // keyword. Register `name → internalName` and skip the
    // reserved-keyword collision check (which would not match anyway).
    if (binding.internalName) {
      renameTable[binding.name] = binding.internalName;
      bindingRenames[binding.name] = binding.internalName;
      occupied.add(binding.internalName);
      continue;
    }
    if (!RESERVED_IDENTIFIERS.has(binding.name)) continue;
    let salt = 0;
    let renamed = hashedIdentifier(binding.name, salt);
    while (occupied.has(renamed) || RESERVED_IDENTIFIERS.has(renamed)) {
      salt += 1;
      renamed = hashedIdentifier(binding.name, salt);
    }
    occupied.add(renamed);
    bindingRenames[binding.name] = renamed;
    renameTable[binding.name] = renamed;
    diagnostics.push({
      severity: 'warn',
      code: 'gpu.identifier_collision',
      message: `@bind name '${binding.name}' was renamed to '${renamed}' for WGSL emission`,
      regionId,
      blockId: binding.line ? binding.line.toString() : undefined,
    });
  }

  // 2. @map names — same collision logic.
  for (const map of maps) {
    if (!map.var) continue;
    // §Phase E: quoted map names carry `internalName`. Mirror the @bind
    // branch above so formula-side identifier references resolve to the
    // WGSL `let` binding name.
    if (map.internalName) {
      if (renameTable[map.var] === undefined) {
        renameTable[map.var] = map.internalName;
        occupied.add(map.internalName);
      }
      continue;
    }
    if (!RESERVED_IDENTIFIERS.has(map.var)) continue;
    if (renameTable[map.var] !== undefined) continue;
    let salt = 0;
    let renamed = hashedIdentifier(map.var, salt);
    while (occupied.has(renamed) || RESERVED_IDENTIFIERS.has(renamed)) {
      salt += 1;
      renamed = hashedIdentifier(map.var, salt);
    }
    occupied.add(renamed);
    renameTable[map.var] = renamed;
    diagnostics.push({
      severity: 'warn',
      code: 'gpu.identifier_collision',
      message: `@map var '${map.var}' was renamed to '${renamed}' for WGSL emission`,
      regionId,
      blockId: map.blockId,
      line: map.line,
    });
  }

  // 3. §Phase E+ — @repeat names. Same collision logic; quoted @repeat
  //    names (`@repeat "R0":global_x = ...`) carry `internalName` so the
  //    emitter can rewrite any `@map idx <- "R0"` reference to a valid
  //    WGSL identifier.
  //
  //    §Phase 2 (15.3): the previous `@max` group-name rename pass is
  //    removed alongside the directive. There is no longer a quoted
  //    group name to alias through `internalName` for `@max`.
  for (const repeat of repeats) {
    if (!repeat.name) continue;
    if (repeat.internalName) {
      if (renameTable[repeat.name] === undefined) {
        renameTable[repeat.name] = repeat.internalName;
        occupied.add(repeat.internalName);
      }
      continue;
    }
    if (!RESERVED_IDENTIFIERS.has(repeat.name)) continue;
    if (renameTable[repeat.name] !== undefined) continue;
    let salt = 0;
    let renamed = hashedIdentifier(repeat.name, salt);
    while (occupied.has(renamed) || RESERVED_IDENTIFIERS.has(renamed)) {
      salt += 1;
      renamed = hashedIdentifier(repeat.name, salt);
    }
    occupied.add(renamed);
    renameTable[repeat.name] = renamed;
    diagnostics.push({
      severity: 'warn',
      code: 'gpu.identifier_collision',
      message: `@repeat name '${repeat.name}' was renamed to '${renamed}' for WGSL emission`,
      regionId,
    });
  }

  return { renameTable, diagnostics, bindingRenames };
}

export function emitRegion(input: EmitInput): EmitResult {
  const { regionVerdict } = input;
  const diagnostics: Diagnostic[] = [];
  const maps = regionVerdict.directives.filter((item): item is MapDirective => item.kind === 'map');
  const repeats = regionVerdict.directives.filter(
    (item): item is ResolvedRepeatDirective => item.kind === 'repeat',
  );
  const bindings = regionVerdict.directives
    .filter((item): item is BindDirective => item.kind === 'bind')
    .slice()
    .sort((a, b) => a.slot - b.slot);
  const workgroupDirective = regionVerdict.directives.find(
    (item): item is WorkgroupSizeDirective => item.kind === 'workgroup_size',
  );
  const requestedWorkgroup = workgroupDirective
    ? { x: workgroupDirective.x, y: workgroupDirective.y, z: workgroupDirective.z }
    : DEFAULT_WORKGROUP_SIZE;
  const workgroupLimits = input.workgroupLimits ?? DEFAULT_WORKGROUP_LIMITS;
  const workgroupSize = clampWorkgroupSize(requestedWorkgroup, workgroupLimits);

  if (!sameWorkgroupSize(requestedWorkgroup, workgroupSize)) {
    diagnostics.push({
      severity: 'info',
      code: 'gpu.workgroup_size_clamped',
      message: `workgroup size (${requestedWorkgroup.x}, ${requestedWorkgroup.y}, ${requestedWorkgroup.z}) was clamped to (${workgroupSize.x}, ${workgroupSize.y}, ${workgroupSize.z})`,
      regionId: regionVerdict.regionId,
      blockId: regionVerdict.blockId,
    });
  }

  const renamed = renameIdentifiers(maps, bindings, regionVerdict.regionId, repeats);
  diagnostics.push(...renamed.diagnostics);
  const blocks = collectTargetBlocks(input.parsedProject, regionVerdict.spriteId);
  const bindingNames = createBindingNames(bindings);
  // Override binding rename to use the canonical hashed name when one
  // was assigned by `renameIdentifiers`.
  for (const [original, renamedName] of Object.entries(renamed.bindingRenames)) {
    bindingNames.set(original, renamedName);
  }
  const lengthNames = new Map<string, string>();
  for (const binding of bindings) {
    const storageName = bindingNames.get(binding.name) ?? binding.name;
    lengthNames.set(binding.name, safeIdentifier(`${storageName}_length`));
  }

  // §Phase 3 — Build scalar uniform bindings from `@bind ..., scalar`
  // directives. These feed `data_variableof` resolution in
  // `scratchBlockToWgslExpr` and the WGSL `ScratchUniforms` struct emit.
  const scalarBindings = createScalarUniformBindings(bindings, renamed.renameTable);
  const scalarFieldNames = new Map<string, string>();
  for (const scalar of scalarBindings) {
    scalarFieldNames.set(scalar.name, scalar.wgslName);
  }

  // Phase 2: implicit axis 収集 (kernel container + nested repeats の
  // loop count formula → Ry/Rx<N> axis)。legacy レイアウト
  // (nestedRepeatContainerBlockIds が空) では生成しない。
  //
  // §Phase 4 — implicit-axis emission was retired. Repeats now resolve
  // structurally via `repeatPathTable`, so the only axes the
  // emitter sees are the user-authored `@repeat` directives inside
  // `regionVerdict.directives`. The `axisVerdicts` map below merges
  // the resolved `finalAxis` per directive name.
  const axisVerdicts: Record<string, { finalAxis: AxisFinal }> = {
    ...regionVerdict.axes,
  };
  for (const repeat of repeats) {
    axisVerdicts[repeat.name] = {
      finalAxis: regionVerdict.axes[repeat.name]?.finalAxis ?? repeat.axis,
    };
  }
  const repeatByBlockId = new Map<string, ResolvedRepeatDirective>();
  for (const repeat of repeats) {
    repeatByBlockId.set(repeat.resolvedRepeatBlockId, repeat);
  }
  const skipContext: SkipBlockContext = {
    effectivePatterns: regionVerdict.blockSubset.effectivePatterns ?? [],
  };
  // §Phase 6 — materialise the auto-tmp binding table. The verdict
  // already topo-sorted the candidates; we trust the detector's
  // emit names (which carry SSA uniqueness when the same scratch
  // name has multiple `set` writes) and only run them through
  // `safeIdentifier` when the detector did not assign one (= legacy
  // callers that build a synthetic `AutoTmpVerdict` without going
  // through `detectAutoTmpBindings`).
  const autoTmpBindings: AutoTmpBinding[] = (regionVerdict.autoTmpVerdict?.bindings ?? []).map(
    (binding) => ({
      ...binding,
      emitName: binding.emitName && binding.emitName.length > 0
        ? binding.emitName
        : safeIdentifier(binding.name),
    }),
  );
  const autoTmpEmitNames: Record<string, string> = {};
  for (const binding of autoTmpBindings) {
    autoTmpEmitNames[binding.name.toLowerCase()] = binding.emitName;
  }
  const autoTmpReads = regionVerdict.autoTmpVerdict?.reads;
  const autoTmpMutables = regionVerdict.autoTmpVerdict?.mutables;
  const autoTmpMutableByChangeBlockId = new Map<
    string,
    { emitName: string; initialInput: unknown }
  >();
  for (const m of autoTmpMutables ?? []) {
    for (const cid of m.changeBlockIds) {
      autoTmpMutableByChangeBlockId.set(cid, {
        emitName: m.emitName,
        initialInput: m.initialInput,
      });
    }
  }
  const context: EmitterContext = {
    regionId: regionVerdict.regionId,
    blocks,
    bindings,
    bindingNames,
    lengthNames,
    renameTable: renamed.renameTable,
    bindingRenameTable: renamed.bindingRenames,
    mapNames: new Set(maps.map((map) => map.var)),
    bindNames: new Set(bindings.map((b) => b.name)),
    sequentialNames: new Set(
      repeats
        .filter((repeat) => axisVerdicts[repeat.name]?.finalAxis === 'sequential')
        .map((repeat) => repeat.name),
    ),
    diagnostics,
    diagnosedBlocks: new Set(),
    expressionStack: new Set(),
    skipContext,
    repeatByBlockId,
    axisVerdicts,
    autoTmpBindings,
    autoTmpEmitNames,
    autoTmpReads,
    autoTmpMutables,
    autoTmpMutableByChangeBlockId,
    scalarFieldNames,
  };

  const lines: string[] = [
    scratchCompatHeader(),
    '',
    emitUniforms(bindings, lengthNames, scalarFieldNames),
    '',
  ];
  for (const binding of bindings) {
    // §Phase 3 — scalar bindings share one `@group(1) @binding(0)` slot
    // (= the uniforms buffer); they do NOT consume a `@group(0)
    // @binding(N)` slot. Skip emitBinding for scalars.
    if (binding.storageKind === 'scalar') continue;
    lines.push(emitBinding(binding, bindingNames));
  }
  if (bindings.length > 0) lines.push('');

  const dispatchPlan = computeDispatchPlan(repeats, axisVerdicts, workgroupSize, {
    bindings,
    renameTable: renamed.renameTable,
    bindingRenameTable: renamed.bindingRenames,
    regionId: regionVerdict.regionId,
  });
  lines.push(`// ${formatDispatchPlan(dispatchPlan)}`);
  lines.push(
    `@compute @workgroup_size(${workgroupSize.x},${workgroupSize.y},${workgroupSize.z})`,
  );
  lines.push(`${mainSignature(regionVerdict.parallelAxes)} {`);

  const orderedMaps = orderMaps(maps, regionVerdict.cascade.topoOrder);
  // §Phase 6 — shared `ScratchBlockExprContext` for both `@map`
  // formula emission and auto-tmp `let` emission. Built once with the
  // auto-tmp emit-name table so cross-tmp references resolve.
  const scratchExprCtx = buildScratchBlockExprContextForEmit(context, scalarBindings);

  // §Phase 6 (extended) — detect fold patterns. A scratch var with a
  // `data_changevariableby` block INSIDE a parallel-axis
  // control_repeat (= `axisVerdicts` reports a non-sequential axis)
  // cannot use a `var` + increment pattern (each thread would do the
  // increment once and end up with the same value). Instead, we fold
  // the change into a `let name = <preceding_set_value> + <axisVar> *
  // <delta>` declaration and skip the change block at body position.
  //
  // The fold map is keyed by the *lower-cased scratch var name*; the
  // value carries the axis @map name (= the axis variable the body
  // can reference, e.g. `Rx`) and the per-thread delta string (e.g.
  // `Rx * 1.0`).
  const foldPatterns = detectFoldPatterns(
    blocks,
    regionVerdict,
    axisVerdicts,
    repeatByBlockId,
  );

  for (const map of orderedMaps) {
    // §Phase E: quoted `@map` names use `internalName` as the WGSL
    // `let` binding. The collision-rename pass above (renamed.renameTable)
    // already records `var → internalName` for quoted names, so falling
    // through to `renameTable[map.var]` covers both quoted and reserved
    // keyword collisions.
    const emittedName = renamed.renameTable[map.var] ?? map.var;
    const formula = emitFormula(map.formula, map, context);
    // §Phase 6 (extended) — `__tw_gid.x` is a `vec3<u32>` element of
    // type `u32`. WGSL requires explicit conversion `u32 → f32`, so
    // wrap the formula in `f32(...)` whenever it references
    // `__tw_gid` (= the kernel parameter that carries the
    // `global_invocation_id` builtin). This is what lets a user write
    // `@map R0 <- __tw_gid.x` and get a thread-indexed `let` binding.
    const wrapped = wrapGidFormula(formula);
    lines.push(`  let ${emittedName}: f32 = ${wrapped};`);
  }
  // §Phase 6 — mutable scratch-var `var` declarations. Each entry's
  // `initialInput` is the most-recent preceding `set` (or `null` for
  // 0-init). The same `var` is reused by every `data_changevariableby`
  // body block via `autoTmpMutableByChangeBlockId`; the latest SSA
  // name for the scratch name (= a `let` declared further down for a
  // re-`set`) shadows the `var` but is the same `emitName`, so the
  // increment assignment lands correctly.
  //
  // §Phase 6 (extended) — when a fold pattern targets this mutable's
  // scratch var (= the `set X = <base>` lives outside the parallel
  // axis loop and `change X by N` lives inside), append
  // `+ <axisVar> * N` to the initialiser so each thread computes its
  // own per-thread index in a single `var` declaration (= the body-
  // position increment is then skipped by `isChangeInsideParallelAxis`).
  for (const m of autoTmpMutables ?? []) {
    const fold = foldPatterns.get(m.lowered);
    if (m.initialInput === null) {
      const suffix = fold ? ` + ${fold.suffix}` : '';
      lines.push(`  var ${m.emitName}: f32 = 0.0${suffix};`);
    } else {
      const initialExpr = lowerMutableInitial(m.initialInput, context, scratchExprCtx);
      if (initialExpr === null) {
        const suffix = fold ? ` + ${fold.suffix}` : '';
        lines.push(`  var ${m.emitName}: f32 = 0.0${suffix};`);
      } else {
        const suffix = fold ? ` + ${fold.suffix}` : '';
        lines.push(`  var ${m.emitName}: f32 = ${initialExpr}${suffix};`);
      }
    }
  }
  // §Phase 6 — auto-tmp `let` declarations. The bindings are already
  // topologically ordered by `detectAutoTmpBindings`. Each binding's
  // `data_setvariableto.inputs.VALUE` shadow chain is converted to a
  // WGSL expression via the same `scratchBlockToWgslExpr` path used
  // for `@map` formula emission, with `autoTmpEmitNames` threaded
  // through `ScratchBlockExprContext` so cross-tmp references resolve.
  //
  // §Phase 6 (extended) — when a fold pattern targets this binding's
  // scratch var (= the `set X = <base>` lives outside the parallel-
  // axis loop and `change X by N` lives inside it), append
  // `+ <axisVar> * N` to the let expression so each thread computes
  // its own per-thread index in a single statement. When the same
  // scratch var has a `var` mutable (= `data_changevariableby` outside
  // any parallel axis), skip the `let` because the `var` already
  // declares the storage and the body-position increment carries
  // through.
  const mutableLowerNames = new Set((autoTmpMutables ?? []).map((m) => m.lowered));
  for (const autoTmp of autoTmpBindings) {
    if (mutableLowerNames.has(autoTmp.name.toLowerCase())) {
      // Skip — `var` declaration already covers this scratch var.
      continue;
    }
    const scratchBlock = blocks[autoTmp.blockId];
    if (!scratchBlock) continue;
    const expr = emitAutoTmpValueExpression(scratchBlock, context, scratchExprCtx);
    const fold = foldPatterns.get(autoTmp.name.toLowerCase());
    if (fold) {
      lines.push(`  let ${autoTmp.emitName}: f32 = ${expr} + ${fold.suffix};`);
    } else {
      lines.push(`  let ${autoTmp.emitName}: f32 = ${expr};`);
    }
  }

  // §Phase 4: the kernel container itself is the body entry point.
  // `emitResolvedRepeat` walks the SUBSTACK `next` chain, threading
  // through nested `control_repeat` blocks. Each repeat either
  // (a) carries a parallel `@repeat` directive whose body is emitted
  // directly, (b) carries a sequential `@repeat` directive whose
  // body is wrapped in a `for`, or (c) has no directive at all — its
  // body is also wrapped in a `for` driven by the scratch TIMES
  // input.
  const kernelContainer = blocks[regionVerdict.kernelContainerBlockId];
  if (kernelContainer) {
    const selfDirective = repeatByBlockId.get(kernelContainer.id);
    const innerLines = emitResolvedRepeat(kernelContainer, selfDirective, context);
    for (const line of innerLines) lines.push(`  ${line}`);
  } else {
    diagnostics.push({
      severity: 'error',
      code: 'gpu.emitter_unsupported_opcode',
      regionId: regionVerdict.regionId,
      blockId: regionVerdict.blockId,
      message: `kernel container block '${regionVerdict.kernelContainerBlockId}' is missing from the parsed project; region demoted to JS`,
    });
  }
  lines.push('}');

  return {
    wgsl: lines.join('\n'),
    diagnostics,
    dispatchPlan,
    workgroupSize,
    scalarBindings,
  };
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function clampDimension(value: number, deviceLimit: number, invocationLimit: number): number {
  return Math.min(positiveInteger(value), positiveInteger(deviceLimit), invocationLimit);
}

function sameWorkgroupSize(a: Readonly<WorkgroupSize>, b: Readonly<WorkgroupSize>): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function hashedIdentifier(identifier: string, salt: number): string {
  let hash = 0x811c9dc5;
  const input = salt === 0 ? identifier : `${identifier}:${salt}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `__tw_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function safeIdentifier(identifier: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) && !RESERVED_IDENTIFIERS.has(identifier)) {
    return identifier;
  }
  return hashedIdentifier(identifier, 0);
}

/**
 * Public version of `safeIdentifier` for use by adjacent modules (e.g.
 * `formula-rewrite.ts`) that need the same collision-aware identifier
 * derivation. Returns the surface name when it is a WGSL-safe
 * identifier and not a reserved keyword; otherwise returns the
 * FNV-1a-hashed form. Used as the fallback when `renameTable` doesn't
 * yet know about a binding (e.g. when formula-rewrite runs before
 * `renameIdentifiers`).
 */
export function safeIdentifierForBinding(identifier: string): string {
  return safeIdentifier(identifier);
}

function collectTargetBlocks(project: ParsedProject, spriteId: string): Record<string, RawBlock> {
  const preferred = project.targets.find((target) => target.id === spriteId);
  if (preferred) return preferred.blocks;
  const blocks: Record<string, RawBlock> = {};
  for (const target of project.targets) Object.assign(blocks, target.blocks);
  return blocks;
}

function createBindingNames(bindings: readonly BindDirective[]): Map<string, string> {
  const names = new Map<string, string>();
  const occupied = new Set<string>();
  for (const binding of bindings) {
    // Quoted names (§Phase E) bypass the safeIdentifier round-trip —
    // `internalName` is already a valid FNV-1a-hashed WGSL identifier,
    // and the host-side `name` (which may contain spaces or punctuation)
    // is not a valid WGSL identifier. The `internalName` is also unique
    // by construction (FNV-1a of a 32-bit salt), so we can register it
    // directly without a salt loop.
    if (binding.internalName) {
      names.set(binding.name, binding.internalName);
      occupied.add(binding.internalName);
      continue;
    }
    let name = safeIdentifier(binding.name);
    let salt = 0;
    while (occupied.has(name)) {
      salt += 1;
      name = hashedIdentifier(binding.name, salt);
    }
    occupied.add(name);
    names.set(binding.name, name);
  }
  return names;
}

/**
 * Emit the uniforms struct at `@group(1) @binding(0)` to free `@group(0)`
 * for user storage bindings. Storage bindings then occupy `@group(0)
 * @binding(0) .. N`, and the user is free to use slot 0.
 *
 * §Phase 3 — scalar bindings (`storageKind === 'scalar'`) are emitted as
 * `{wgslName}: {f32|i32}` fields before the list length fields. Scalar
 * uniforms share one `@group(1) @binding(0)` slot; their values are
 * written via `__dispatch-kernel-sync.ts:packScalarUniformBuffer`.
 *
 * §Phase 4 (15.7) — explicit 16-byte stride alignment. Every 4-byte
 * scalar field is followed by an explicit `pad: vec3<u32>` (12 bytes)
 * placeholder so the WGSL struct's field layout matches the host pack
 * layout (`SCALAR_UNIFORM_HEADER_BYTES` + `SCALAR_UNIFORM_FIELD_STRIDE_BYTES`
 * per field — see `scalar-uniform-binding.ts`). Without the explicit
 * padding, WGSL would pack adjacent 4-byte fields to 4-byte offsets and
 * leave the runtime reading struct field values at the wrong offsets.
 * The `byte, scalar` dtype maps to WGSL `i32` (host ABI keeps the
 * scalar-as-`i32` mapping; the byte-array ↔ array<u32> 2-step
 * representation is for list bindings only).
 */
function emitUniforms(
  bindings: readonly BindDirective[],
  lengthNames: ReadonlyMap<string, string>,
  scalarFieldNames: ReadonlyMap<string, string> = new Map(),
): string {
  const fields: string[] = [];
  let padCounter = 0;
  const nextPadName = (): string => `__tw_pad_${padCounter++}`;
  // Scalar fields come first so that the host upload layout (16-byte
  // header + 16-byte stride) lines up with the WGSL struct field order.
  for (const binding of bindings) {
    if (binding.storageKind !== 'scalar') continue;
    const wgslName = scalarFieldNames.get(binding.name) ?? binding.name;
    // `byte` maps to `i32` for scalar context (host ABI keeps the
    // scalar-as-`i32` mapping — see `scalar-uniform-binding.ts`).
    const wgslType = binding.dtype === 'i32' || binding.dtype === 'byte' ? 'i32' : 'f32';
    fields.push(`  ${wgslName}: ${wgslType},`);
    // 12 bytes padding to round the field up to the 16-byte stride.
    fields.push(`  ${nextPadName()}: vec3<u32>,`);
  }
  // List length fields follow. The trailing underscore prefix avoids
  // collision with scalar fields when the user names both a list and a
  // scalar with the same surface name (e.g. `@bind "data"(0) rw f32` +
  // `@bind "data"(0) ro f32, scalar`).
  for (const binding of bindings) {
    if (binding.storageKind === 'scalar') continue;
    const name = lengthNames.get(binding.name) ?? safeIdentifier(`${binding.name}_length`);
    fields.push(`  ${name}: u32,`);
    // 12 bytes padding for the same 16-byte stride invariant.
    fields.push(`  ${nextPadName()}: vec3<u32>,`);
  }
  if (fields.length === 0) fields.push('  __tw_padding: u32,');
  return `struct ScratchUniforms {\n${fields.join('\n')}\n};\n@group(1) @binding(0) var<uniform> u_scratch: ScratchUniforms;`;
}

function emitBinding(
  binding: BindDirective,
  bindingNames: ReadonlyMap<string, string>,
): string {
  const access = binding.readOnly ? 'read' : 'read_write';
  // `byte` is logically a host-side Uint8Array, but WGSL has no
  // host-shareable u8 storage type — we use array<u32> with one u32
  // per element and pack low-8-bits in M5 (`list-buffer-binding.ts`
  // `coerceToTypedArray` for `byte` dtype). Helpers
  // `scratch_list_read_u32` / `scratch_list_write_u32` keep host and
  // shader in sync.
  const elementType = binding.dtype === 'i32'
    ? 'i32'
    : binding.dtype === 'byte'
      ? 'u32'
      : 'f32';
  const name = bindingNames.get(binding.name) ?? binding.name;
  return `@group(0) @binding(${binding.slot}) var<storage, ${access}> ${name}: array<${elementType}>;`;
}

function mainSignature(parallelAxes: RegionVerdict['parallelAxes']): string {
  const axes = new Set(parallelAxes.map((item) => item.axis));
  // Kernel parameter names are `__tw_gid` / `__tw_lid` / `__tw_wid` so
  // user `@map` declarations can freely use `gid`/`lid`/`wid` without
  // colliding with the WGSL parameter.
  const params = ['@builtin(global_invocation_id) __tw_gid: vec3<u32>'];
  if (hasAxisPrefix(axes, 'local_')) {
    params.push('@builtin(local_invocation_id) __tw_lid: vec3<u32>');
  }
  if (hasAxisPrefix(axes, 'workgroup_')) {
    params.push('@builtin(workgroup_id) __tw_wid: vec3<u32>');
  }
  return `fn main(${params.join(', ')})`;
}

function hasAxisPrefix(axes: ReadonlySet<AxisFinal>, prefix: string): boolean {
  for (const axis of axes) {
    if (axis.startsWith(prefix)) return true;
  }
  return false;
}

function orderMaps(maps: readonly MapDirective[], topoOrder: readonly string[]): MapDirective[] {
  const byName = new Map(maps.map((map) => [map.var, map]));
  const ordered: MapDirective[] = [];
  const emitted = new Set<string>();
  for (const name of topoOrder) {
    const map = byName.get(name);
    if (!map || emitted.has(name)) continue;
    ordered.push(map);
    emitted.add(name);
  }
  for (const map of maps) {
    if (!emitted.has(map.var)) ordered.push(map);
  }
  return ordered;
}

function emitFormula(
  rawFormula: string,
  directive: MapDirective | RepeatDirective,
  context: EmitterContext,
): string {
  validateFormula(rawFormula, directive, context);
  // §Phase 3 §15.11 — quoted-reference rename runs BEFORE the
  // scratch-compat sugar pass so the lexer inside `rewriteFormula`
  // sees `"my list"` as the hashed identifier and the
  // `bindingByEmit` lookup resolves it without relying on a
  // defensive preprocess step.
  const renamedRaw = renameFormulaIdentifiers(
    rawFormula,
    context.renameTable,
    context.bindingRenameTable,
  );
  // §Phase E+ — apply general-notation sugar after identifier rewrite
  // so the rewrite pass sees only scratch-compat primitives and the
  // hashed `internalName` from quoted references.
  const rewrite = rewriteFormula(renamedRaw, {
    bindings: context.bindings,
    renameTable: context.renameTable,
    regionId: context.regionId,
    blockId: directive.blockId,
    line: directive.line,
  });
  if (rewrite.diagnostics.length > 0) context.diagnostics.push(...rewrite.diagnostics);
  let formula = rewrite.formula;
  if (formula.includes('//')) {
    formula = substituteBinaryOperator(formula, '//', (left, right) => `floor(${left} / ${right})`);
    context.diagnostics.push({
      severity: 'info',
      code: 'gpu.emitter_integer_division_substituted',
      message: `integer division in '${directiveFormulaName(directive)}' was emitted as floor(a / b)`,
      regionId: context.regionId,
      blockId: directive.blockId,
      line: directive.line,
    });
  }
  if (formula.includes('^')) {
    formula = substituteBinaryOperator(formula, '^', (left, right) => `exp(${left} * log(${right}))`);
    context.diagnostics.push({
      severity: 'warn',
      code: 'gpu.emitter_generic_pow_substituted',
      message: `generic exponentiation in '${directiveFormulaName(directive)}' was emitted with exp/log`,
      regionId: context.regionId,
      blockId: directive.blockId,
      line: directive.line,
    });
  }
  return castI32Calls(formula);
}

function directiveFormulaName(directive: MapDirective | RepeatDirective): string {
  return directive.kind === 'map' ? directive.var : directive.name;
}

/**
 * Validate a formula's syntax. We accept a permissive subset:
 *   - numeric literals (`0`, `1.5`, `-3`, `6.022e23`, `-0`)
 *   - identifiers (alphanumeric + underscore), but reject function-call
 *     syntax for unknown identifiers
 *   - operators: `+ - * / % ^ ( ) , . < > = <= >= == != && || //`
 *
 * Anything else is flagged with a `gpu.emitter_invalid_formula_token`
 * diagnostic so the user knows their DSL was malformed. Bare reserved
 * keywords (e.g. `@map let <- 0`) are caught upstream by the rename
 * pass; this validator catches function-call syntax of unknown names
 * (e.g. `@map x <- undeclared_fn(y)`).
 *
 * §Phase 3 §15.11 — quoted-string segments (`"my axis"`) are
 * skipped wholesale so their contents don't trigger
 * `gpu.emitter_invalid_formula_token`. Escape handling mirrors
 * `comment-parser.ts:parseNameToken`.
 */
function validateFormula(
  formula: string,
  directive: MapDirective | RepeatDirective,
  context: EmitterContext,
): void {
  const invalid = new Set<string>();
  let offset = 0;
  while (offset < formula.length) {
    const remaining = formula.slice(offset);
    const whitespace = remaining.match(/^\s+/);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    // Skip quoted segments verbatim so the `"` characters and any
    // punctuation inside the quoted name don't trigger the invalid-
    // token diagnostic. The escape rules match
    // `comment-parser.ts:parseNameToken` (`\"` and `\\`).
    const quoted = remaining.match(/^"(?:[^"\\]|\\.)*"/);
    if (quoted) {
      offset += quoted[0].length;
      continue;
    }
    const number = remaining.match(/^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/);
    if (number) {
      offset += number[0].length;
      continue;
    }
    const identifier = remaining.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      const token = identifier[0];
      const after = formula.slice(offset + token.length);
      if (/^\s*\(/.test(after) && !KNOWN_FORMULA_FUNCTIONS.has(token)) {
        // Also flag obvious reserved keywords that ended up in a formula
        // because the rename pass couldn't surface them (rare — usually
        // we hit them there).
        if (RESERVED_IDENTIFIERS.has(token)) {
          invalid.add(token);
        } else {
          invalid.add(token);
        }
      }
      offset += token.length;
      continue;
    }
    const operator = remaining.match(/^(?:\/\/|<=|>=|==|!=|&&|\|\||[+\-*/%^<>=!(),.[\]])/);
    if (operator) {
      offset += operator[0].length;
      continue;
    }
    invalid.add(remaining[0] ?? '');
    offset += 1;
  }

  for (const token of invalid) {
    context.diagnostics.push({
      severity: 'warn',
      code: 'gpu.emitter_invalid_formula_token',
      message: `formula '${directiveFormulaName(directive)}' contains unsupported token '${token}'`,
      regionId: context.regionId,
      blockId: directive.blockId,
      line: directive.line,
    });
  }
}

function renameFormulaIdentifiers(
  formula: string,
  renameTable: Readonly<Record<string, string>>,
  bindingRenames?: Readonly<Record<string, string>>,
): string {
  // Binding renames take priority over @map renames. Storage bindings
  // surface as `@bind <name>` declarations in the WGSL output, and any
  // formula that references the bound list — directly or transitively
  // via `data_itemoflist`'s `LIST` field — would otherwise be emitted
  // with the original (potentially reserved) WGSL keyword. Without
  // binding rewrite, `@bind let(0) rw f32` followed by a `@map idx <- 0`
  // that references `let` would emit `let <hashed>: array<f32>` as the
  // storage variable but the formula would still emit `let` verbatim,
  // shadowing the WGSL keyword inside the function body.
  //
  // §Phase E+ — also rewrite quoted-string references (`"my list"`)
  // whose content matches an entry in `renameTable`. This lets the
  // user reference a quoted @bind/@repeat by its surface name in
  // formulas. Quoted references resolve to the same `internalName` /
  // hashed emit name as the unquoted form. (§Phase 2 15.3 — `@max`
  // removed; no longer in the rename table.)
  //
  // §Phase 3 §15.11 — escape sequences inside quoted references are
  // stripped using the same `\<char>` rules as
  // `comment-parser.ts:parseNameToken` (`\"` → `"`, `\\` → `\`, any
  // other `\X` drops the backslash and keeps `X`). The renamed
  // identifier is emitted WITHOUT quotes so the lexer's
  // `bindingByEmit` lookup inside `rewriteFormula` succeeds.
  const lookup = (key: string): string | undefined => {
    if (bindingRenames && bindingRenames[key] !== undefined) return bindingRenames[key];
    return renameTable[key];
  };
  let out = formula.replace(/"((?:[^"\\]|\\.)*)"/g, (match, body: string) => {
    const unescaped = body.replace(/\\(.)/g, '$1');
    const renamed = lookup(unescaped);
    if (!renamed) return match;
    return renamed;
  });
  out = out.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (identifier) => lookup(identifier) ?? identifier);
  return out;
}

function substituteBinaryOperator(
  formula: string,
  operator: '//' | '^',
  replacement: (left: string, right: string) => string,
): string {
  const operand =
    '(?:[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*(?:\\([^()]*\\))?|(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?|\\([^()]*\\))';
  const escaped = operator === '//' ? '\\/\\/' : '\\^';
  const pattern = new RegExp(`(${operand})\\s*${escaped}\\s*(${operand})`);
  let output = formula;
  let match = pattern.exec(output);
  while (match && match[1] !== undefined && match[2] !== undefined) {
    output = `${output.slice(0, match.index)}${replacement(match[1], match[2])}${output.slice(match.index + match[0].length)}`;
    match = pattern.exec(output);
  }
  return output;
}

function castI32Calls(formula: string): string {
  const functionName = 'scratch_list_read_i32';
  let output = formula;
  let searchFrom = 0;
  while (searchFrom < output.length) {
    const start = output.indexOf(`${functionName}(`, searchFrom);
    if (start < 0) break;
    if (output.slice(Math.max(0, start - 4), start) === 'f32(') {
      searchFrom = start + functionName.length;
      continue;
    }
    const open = start + functionName.length;
    const close = findClosingParen(output, open);
    if (close < 0) break;
    const call = output.slice(start, close + 1);
    output = `${output.slice(0, start)}f32(${call})${output.slice(close + 1)}`;
    searchFrom = close + 6;
  }
  return output;
}

function findClosingParen(value: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Compute the dispatch workgroup counts as WGSL expressions. These
 * expressions are evaluated on the JS side too — the runtime dispatcher
 * uses them to size `dispatchWorkgroups(...)` after substituting
 * runtime list lengths. The textual form is emitted as a comment for
 * documentation; the structured `DispatchPlan` is the source of truth.
 *
 * For each surviving axis we emit `ceil(<formula> / <denominator>)`.
 * The denominator is the workgroup size along that axis (1 for axes
 * that don't run in parallel — those are demoted to a sequential for
 * loop in WGSL).
 *
 * Phase 2: explicit `@repeat` + implicit axis (= `combinedRepeats`) を
 * 統一的に扱う。`axisVerdicts` には explicit と implicit の両方の verdict
 * が含まれる。
 */
function computeDispatchPlan(
  repeats: readonly RepeatDirective[],
  axisVerdicts: Readonly<Record<string, { finalAxis: AxisFinal }>>,
  workgroupSize: Readonly<WorkgroupSize>,
  context: {
    bindings: readonly BindDirective[];
    renameTable: Readonly<Record<string, string>>;
    bindingRenameTable: Readonly<Record<string, string>>;
    regionId: string;
  } | null = null,
): DispatchPlan {
  const formulas: string[][] = [[], [], []];
  for (const repeat of repeats) {
    const axis = axisVerdicts[repeat.name]?.finalAxis ?? repeat.axis;
    if (axis === 'sequential' || axis.startsWith('local_')) continue;
    const dimension = axis.endsWith('_y') ? 1 : axis.endsWith('_z') ? 2 : 0;
    const denominator = dimension === 0 ? workgroupSize.x : dimension === 1 ? workgroupSize.y : workgroupSize.z;
    // §Phase 3 §15.11 — quoted-reference rename runs BEFORE the
    // scratch-compat sugar pass so the lexer inside `rewriteFormula`
    // sees hashed identifiers and the `bindingByEmit` lookup
    // resolves them. The previous order (sugar → rename) left
    // `__tw_<hash>[idx]` in the dispatch plan while the WGSL body
    // correctly used `scratch_list_read_f32(...)`, causing textual
    // drift between body and dispatch plan.
    let expanded = repeat.formula;
    if (context) {
      const renamed = renameFormulaIdentifiers(
        repeat.formula,
        context.renameTable,
        context.bindingRenameTable,
      );
      const rewrite = rewriteFormula(renamed, {
        bindings: context.bindings,
        renameTable: context.renameTable,
        regionId: context.regionId,
        blockId: repeat.blockId,
        line: repeat.line,
      });
      expanded = rewrite.formula;
    }
    const formula = axis.startsWith('workgroup_')
      ? expanded
      : `ceil(${expanded} / ${denominator})`;
    formulas[dimension]?.push(formula);
  }
  const dims: ['x' | 'y' | 'z', number][] = [
    ['x', 0],
    ['y', 1],
    ['z', 2],
  ];
  const out: DispatchPlan = { x: '1', y: '1', z: '1' };
  for (const [key, idx] of dims) {
    const values = formulas[idx] ?? [];
    if (values.length === 1) out[key] = values[0] ?? '1';
    else if (values.length > 1) out[key] = `max(${values.join(', ')})`;
  }
  return out;
}

function formatDispatchPlan(plan: DispatchPlan): string {
  return `dispatchWorkgroups(${plan.x}, ${plan.y}, ${plan.z})`;
}

function appendSequentialBody(): void {
  // §Phase 4: removed. Sequential axes are emitted as structural
  // `for` loops at the target `control_repeat` position by
  // `emitResolvedRepeat`.
}
void appendSequentialBody;

function emitStatementChain(startId: string, context: EmitterContext): string[] {
  const lines: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const currentBlock: RawBlock | undefined = context.blocks[currentId];
    if (!currentBlock) break;
    // Phase 2: skip-set に含まれる block は emit せず次の next へ。
    // effectivePatterns (= Phase 1 で収集) が指す block は iteration
    // advance / indirect access (read) として既に GPU 側で処理済み
    // (= WGSL body に再登場する必要がない)。
    if (shouldSkipBlock(currentId, context.skipContext)) {
      currentId = currentBlock.next;
      continue;
    }
    lines.push(...emitStatement(currentBlock, context));
    currentId = currentBlock.next;
  }
  return lines;
}

/**
 * §Phase 6 — convert a `data_setvariableto` `inputs.VALUE` shadow
 * chain into the WGSL expression on the right-hand side of the
 * `let <autoTmp.emitName>: f32 = <expr>;` declaration.
 *
 * `scratchBlockToWgslExpr` returns `null` for opcodes the scratch
 * reverse-translator does not cover (e.g. `operator_random`). In
 * that case we fall back to `0.0` and emit a one-shot
 * `gpu.emitter_unsupported_opcode` warn diagnostic via the shared
 * `diagnoseUnsupported` channel. The fallback matches the legacy
 * behaviour for unsupported expression slots.
 */
function emitAutoTmpValueExpression(
  block: RawBlock,
  context: EmitterContext,
  scratchExprCtx: ScratchBlockExprContext,
): string {
  const valueRef = block.inputs['VALUE'];
  const valueBlock = resolveInputBlock(valueRef, context.blocks);
  if (!valueBlock) return '0.0';
  const text = scratchBlockToWgslExpr(valueBlock, context.blocks, scratchExprCtx);
  if (text === null) {
    diagnoseUnsupported(valueBlock, context);
    return '0.0';
  }
  return text;
}

/**
 * Resolve a scratch input slot to its concrete block, walking the
 * same union of shapes `extractBlockReference` accepts. Returns
 * `undefined` when the input is empty / malformed / literal.
 */
function resolveInputBlock(input: unknown, blocks: Record<string, RawBlock>): RawBlock | undefined {
  const refId = extractBlockReference(input);
  if (!refId) return undefined;
  return blocks[refId];
}

/**
 * §Phase 6 (extended) — wrap an `@map` formula in `f32(...)` when it
 * references `__tw_gid` so the WGSL type checker accepts the `u32`
 * builtin result. Without the explicit cast WGSL rejects the implicit
 * `u32 → f32` conversion with `TypeError: cannot convert value of type
 * u32 to f32`.
 *
 * The wrap only fires when the formula actually contains a `__tw_gid`
 * reference — every other formula is passed through verbatim.
 */
function wrapGidFormula(formula: string): string {
  if (!formula.includes('__tw_gid')) return formula;
  return `f32(${formula})`;
}

/**
 * §Phase 6 (extended) — lower a mutable scratch-var initialiser to a
 * WGSL expression. Mirrors `emitAutoTmpValueExpression` but resolves
 * the `inputs.VALUE` shape directly (without `data_setvariableto`'s
 * block wrapper). Returns `null` for opcodes the scratch reverse-
 * translator does not cover so the caller can fall back to `0.0`.
 */
function lowerMutableInitial(
  valueInput: unknown,
  context: EmitterContext,
  scratchExprCtx: ScratchBlockExprContext,
): string | null {
  const valueBlock = resolveInputBlock(valueInput, context.blocks);
  if (!valueBlock) return null;
  return scratchBlockToWgslExpr(valueBlock, context.blocks, scratchExprCtx);
}

interface FoldPattern {
  /** Lower-cased scratch var name being folded. */
  loweredName: string;
  /** WGSL expression appended to the auto-tmp `let` declaration. */
  suffix: string;
}

/**
 * §Phase 6 (extended) — detect fold patterns in the kernel body.
 *
 * For each `data_changevariableby` block, walk the parent chain to see
 * whether it lives inside a control_repeat whose directive (if any)
 * maps to a parallel axis. If so, the change block must fold into the
 * preceding `set` block (= `let X = <base> + <axisVar> * N`) instead of
 * running sequentially on each thread.
 *
 * Returns a map keyed by lower-cased scratch var name → fold suffix
 * (the `<axisVar> * N` portion that the emitter appends to the
 * auto-tmp `let` declaration).
 *
 * The detector only emits ONE fold per scratch var; multiple change
 * blocks for the same name are flattened into a single suffix (with
 * the deltas summed) — this matches scratch's sequential semantics
 * inside the parallel loop.
 */
function detectFoldPatterns(
  blocks: Record<string, RawBlock>,
  regionVerdict: RegionVerdict,
  axisVerdicts: Readonly<Record<string, { finalAxis: AxisFinal }>>,
  repeatByBlockId: ReadonlyMap<string, ResolvedRepeatDirective>,
): Map<string, FoldPattern> {
  const out = new Map<string, FoldPattern>();

  // Build a reverse map: any control_repeat block id → its resolved
  // directive's axisVar (= the @map variable name). Sequential axes
  // don't qualify.
  const repeatToAxisVar = new Map<string, string>();
  for (const [blockId, directive] of repeatByBlockId.entries()) {
    const axisName = directive.name;
    const finalAxis = axisVerdicts[axisName]?.finalAxis ?? directive.axis;
    if (finalAxis === 'sequential' || finalAxis.startsWith('local_')) continue;
    repeatToAxisVar.set(blockId, axisName);
  }

  // Collect every `data_changevariableby` block in the body (including
  // those inside nested control_repeat substack trees — the bodyIds
  // reachable from any block in the project via parent/next walks).
  for (const block of Object.values(blocks)) {
    if (block.opcode !== 'data_changevariableby') continue;

    // Walk the parent chain. The first control_repeat we encounter
    // is the innermost loop (= the loop the change runs in). If that
    // loop has a parallel axis, this change is foldable.
    let parentId: string | null = block.parent;
    let enclosingParallelRepeatId: string | null = null;
    let depth = 0;
    while (parentId && depth < 32) {
      if (repeatToAxisVar.has(parentId)) {
        enclosingParallelRepeatId = parentId;
        break;
      }
      const parentBlock: RawBlock | undefined = blocks[parentId];
      parentId = parentBlock?.parent ?? null;
      depth += 1;
    }
    if (!enclosingParallelRepeatId) continue;

    const axisVar = repeatToAxisVar.get(enclosingParallelRepeatId);
    if (!axisVar) continue;
    const axisVarRename = context_renameAxisVar(axisVar, regionVerdict);

    const varName = readChangeVarName(block);
    if (!varName) continue;

    // Extract the delta as a numeric literal (or fallback to 1 for
    // scratch's `change X by 1` style with literal-1 shadow). We
    // only support literal-numeric deltas here — anything else would
    // need a per-axis formula and is left to the WGSL-side increment
    // path.
    const delta = readLiteralNumber(block.inputs['VALUE'], blocks);
    if (delta === null) continue;

    const lowered = varName.toLowerCase();
    const existing = out.get(lowered);
    const foldSuffix = `${axisVarRename} * ${formatF32(delta)}`;
    if (existing) {
      // Multiple change blocks for the same name → sum the deltas.
      out.set(lowered, {
        loweredName: lowered,
        suffix: `${existing.suffix} + ${foldSuffix}`,
      });
    } else {
      out.set(lowered, { loweredName: lowered, suffix: foldSuffix });
    }
  }

  return out;
}

function context_renameAxisVar(axisVar: string, regionVerdict: RegionVerdict): string {
  for (const d of regionVerdict.directives) {
    if (d.kind === 'map' && d.var === axisVar) return d.var;
  }
  return axisVar;
}

function readChangeVarName(block: RawBlock): string | null {
  const field = block.fields['VARIABLE'];
  if (!field) return null;
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    for (const item of field) {
      if (typeof item === 'string') return item;
    }
  }
  if (field && typeof field === 'object') {
    const obj = field as Record<string, unknown>;
    if (typeof obj['name'] === 'string') return obj['name'];
    if (typeof obj['id'] === 'string') return obj['id'];
  }
  return null;
}

function readLiteralNumber(input: unknown, blocks?: Record<string, RawBlock>): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }
  if (Array.isArray(input) && input.length >= 2) {
    const tail = input[1];
    if (Array.isArray(tail) && tail.length >= 2) {
      const opcode = tail[0];
      const literal = tail[1];
      if ((opcode === 'math_number' || opcode === 'math_integer') && typeof literal === 'string') {
        const n = Number(literal);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  if (typeof input === 'string') {
    const n = Number(input);
    if (Number.isFinite(n)) return n;
  }
  // Block reference: resolve via the project's block map and read the
  // literal payload from `fields.NUM` (= `math_number` / `math_integer`
  // shape). Two indirection levels (one for the input wrapper, one
  // for the block fields) cover both `[shadowKind, 'blockId']` and
  // `{ id: 'blockId' }` reference shapes.
  if (blocks) {
    const refId = extractBlockReference(input);
    if (refId && blocks[refId]) {
      const block = blocks[refId];
      if (block && (block.opcode === 'math_number' || block.opcode === 'math_integer')) {
        const numField = block.fields['NUM'];
        // Accept both `[number, null]` (= freshly-built fixture / hand-
        // written test) and `[string, null]` (= scratch-vm serialised).
        if (Array.isArray(numField)) {
          const raw = numField[0];
          const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
          if (Number.isFinite(n)) return n;
        }
      }
    }
  }
  return null;
}

/**
 * §Phase 6 (extended) — returns true when the change block sits inside
 * a control_repeat whose directive is registered as a parallel axis
 * (= the `axisVerdicts` map resolves the axis name to a non-sequential
 * final axis). Used by the fold path to skip the change block at
 * body position.
 */
function isChangeInsideParallelAxis(block: RawBlock, context: EmitterContext): boolean {
  let parentId: string | null = block.parent;
  let depth = 0;
  while (parentId && depth < 32) {
    if (context.repeatByBlockId.has(parentId)) {
      const directive = context.repeatByBlockId.get(parentId);
      if (!directive) return false;
      const finalAxis =
        context.axisVerdicts[directive.name]?.finalAxis ?? directive.axis;
      if (finalAxis !== 'sequential' && !finalAxis.startsWith('local_')) return true;
      return false;
    }
    const parentBlock: RawBlock | undefined = context.blocks[parentId];
    parentId = parentBlock?.parent ?? null;
    depth += 1;
  }
  return false;
}

/**
 * Build a `ScratchBlockExprContext` that mirrors the emitter's
 * current rename + scalar binding state, augmented with the auto-tmp
 * emit-name table so `data_variableof` references resolve to the
 * synthesised `let` identifier.
 */
function buildScratchBlockExprContextForEmit(
  context: EmitterContext,
  scalarBindings: readonly ScalarUniformBinding[],
): ScratchBlockExprContext {
  const bindingNameBySurface = new Map<string, string>();
  for (const binding of context.bindings) {
    bindingNameBySurface.set(binding.name, context.renameTable[binding.name] ?? binding.name);
  }
  return {
    bindingNameBySurface,
    scalarBindings,
    renameTable: context.renameTable,
    autoTmpEmitNames: context.autoTmpEmitNames,
  };
}

function emitStatement(block: RawBlock, context: EmitterContext): string[] {
  if (block.opcode === 'data_setvariableto') {
    // §Phase 6 — when this `data_setvariableto` is the source of an
    // auto-tmp binding, the WGSL `let` declaration has already been
    // emitted at the top of the kernel body (above the `for` / repeat
    // walk). The body position emits nothing so the actual `let`
    // ordering is preserved (= dependency comes before consumer).
    return [];
  }
  if (block.opcode === 'data_changevariableby') {
    // §Phase 6 (extended) — mutable scratch var (`change <name> by
    // <delta>`) lowers to `<emitName> = <emitName> + <delta>;` using
    // the latest SSA emit name resolved by the auto-tmp detector. The
    // matching `var` declaration lives at the top of the body so the
    // increment assignment lands on the right storage.
    //
    // When the change block lives INSIDE a parallel axis loop AND
    // its scratch var has a preceding `set` (= the fold pattern), the
    // increment is rolled into the `let` declaration at the top of
    // the kernel body and the change block is skipped here. Each
    // thread then computes its own per-thread index in a single
    // expression (`let X = <base> + Rx * N`) instead of every thread
    // doing the same increment.
    const mutable = context.autoTmpMutableByChangeBlockId?.get(block.id);
    if (!mutable) {
      diagnoseUnsupported(block, context);
      return [];
    }
    // The detector passes fold info via `autoTmpMutables[*].changeBlockIds`.
    // When the change is folded (parent chain reaches a parallel
    // control_repeat AND a preceding `set` exists), skip the body
    // position increment. The body's `let` declaration already carries
    // the `+ <axisVar> * N` suffix.
    if (isChangeInsideParallelAxis(block, context)) return [];
    const deltaExpr = emitInput(block.inputs['VALUE'], context);
    return [`${mutable.emitName} = ${mutable.emitName} + (${deltaExpr});`];
  }
  if (block.opcode === 'data_replaceitemoflist') {
    const statement = emitListWrite(block, context);
    return statement ? [statement] : [];
  }
  if (block.opcode === 'control_repeat') {
    // §Phase 4: thread the body of every nested control_repeat through
    // the same `emitResolvedRepeat` helper. A parallel target drops the
    // wrapper; a sequential target emits a structural `for`.
    return emitResolvedRepeat(block, context.repeatByBlockId.get(block.id), context);
  }
  if (
    BINARY_INPUTS[block.opcode] ||
    block.opcode === 'operator_not' ||
    block.opcode === 'operator_mathop' ||
    block.opcode === 'data_itemoflist'
  ) {
    return [`let __tw_expr_${shortHash(block.id)}: f32 = ${emitBlockExpression(block, context, block.id)};`];
  }
  diagnoseUnsupported(block, context);
  return [];
}

function emitBlockExpression(block: RawBlock, context: EmitterContext, currentBlockId?: string): string {
  if (context.expressionStack.has(block.id)) {
    diagnoseUnsupported(block, context);
    return '0.0';
  }
  context.expressionStack.add(block.id);
  const expression = emitBlockExpressionInner(block, context, currentBlockId);
  context.expressionStack.delete(block.id);
  return expression;
}

function emitBlockExpressionInner(
  block: RawBlock,
  context: EmitterContext,
  currentBlockId?: string,
): string {
  const binaryInputs = BINARY_INPUTS[block.opcode];
  if (binaryInputs) {
    const left = emitInput(block.inputs[binaryInputs[0]], context, currentBlockId);
    const right = emitInput(block.inputs[binaryInputs[1]], context, currentBlockId);
    switch (block.opcode) {
      case 'operator_add':
        return `(${left} + ${right})`;
      case 'operator_subtract':
        return `(${left} - ${right})`;
      case 'operator_multiply':
        return `(${left} * ${right})`;
      case 'operator_divide':
        return `scratch_div(${left}, ${right})`;
      case 'operator_mod':
        return `scratch_mod(${left}, ${right})`;
      case 'operator_gt':
        return `select(0.0, 1.0, ${left} >= ${right})`;
      case 'operator_lt':
        return `select(0.0, 1.0, ${left} <= ${right})`;
      case 'operator_equals':
        return `select(0.0, 1.0, ${left} == ${right})`;
      case 'operator_and':
        return `select(0.0, 1.0, scratch_bool(${left}) * scratch_bool(${right}) != 0.0)`;
      case 'operator_or':
        return `select(0.0, 1.0, max(scratch_bool(${left}), scratch_bool(${right})) != 0.0)`;
      default:
        break;
    }
  }
  if (block.opcode === 'operator_not') {
    const operand = emitInput(block.inputs['OPERAND'], context, currentBlockId);
    return `select(1.0, 0.0, scratch_bool(${operand}) != 0.0)`;
  }
  if (block.opcode === 'operator_mathop') {
    return emitMathop(block, context);
  }
  if (block.opcode === 'data_itemoflist') return emitListRead(block, context);
  if (isNumberReporter(block.opcode)) return emitNumberField(block);
  if (block.opcode === 'data_variable') {
    const variable = fieldName(block.fields['VARIABLE']);
    if (variable) {
      // §Phase 5: `@map` alias takes priority (scratch-side variable
      // alias for an axis / dispatch coordinate).
      if (context.mapNames.has(variable)) {
        const name = context.renameTable[variable] ?? variable;
        return context.sequentialNames.has(variable) ? `f32(${name})` : name;
      }
      // §Phase 6 (extended) — SSA-uniqueness resolution. The
      // `autoTmpReads` map is keyed by the `data_variable` block id
      // (= the reader block, NOT the caller block), so the lookup
      // uses `block.id` directly. The detector walked the body and
      // pinned each read to the latest preceding write of the same
      // scratch var; we resolve to that emit name verbatim. Falls
      // through to the legacy single-binding map when no SSA entry
      // exists (= no writes for this name).
      if (context.autoTmpReads) {
        const ssaEmit = context.autoTmpReads.get(block.id);
        if (ssaEmit) return ssaEmit;
      }
      // §Phase 6 — auto-tmp `let` binding wins next so a scratch tmp
      // referenced inside a `data_itemoflist` index or a
      // `operator_multiply` operand resolves to the synthesised
      // identifier. Without this, an auto-tmp'd scratch var inside
      // any nested expression would fall through to
      // `diagnoseUnsupported` and silently degrade to `0.0`.
      const autoTmpEmit = context.autoTmpEmitNames?.[variable.toLowerCase()];
      if (autoTmpEmit) return autoTmpEmit;
      // §Phase 3 — `@bind ..., scalar` routing. The runtime adapter
      // reads the value through `u_scratch.<wgsl_name>` at dispatch
      // time, so a direct reference here mirrors the scalarBindings
      // path used by `scratchBlockToWgslExpr`.
      const scalarField = context.scalarFieldNames?.get(variable);
      if (scalarField) return `u_scratch.${scalarField}`;
    }
  }
  diagnoseUnsupported(block, context);
  return '0.0';
}

function emitInput(input: unknown, context: EmitterContext, currentBlockId?: string): string {
  const reference = blockReference(input, context.blocks);
  if (reference) {
    const block = context.blocks[reference];
    if (block) return emitBlockExpression(block, context, currentBlockId);
  }
  const literal = inputLiteral(input, context.blocks);
  if (typeof literal === 'number') return formatF32(literal);
  if (typeof literal === 'string') {
    const numeric = Number(literal);
    if (literal.trim().length > 0 && !Number.isNaN(numeric)) return formatF32(numeric);
    const renamed = context.renameTable[literal];
    if (renamed) return renamed;
    if (context.mapNames.has(literal)) return literal;
  }
  return '0.0';
}

/**
 * §Phase 1: split block-id extraction from `blocks`-map lookup.
 *
 * `extractBlockReference` resolves any of the documented SB3 raw shapes
 * to a candidate block id (string or null). `blockReference` then
 * validates that the id actually exists in the project's `blocks` map
 * before returning it — keeping the emitter's "block exists" invariant
 * intact while routing shape acceptance through the shared helper.
 */
function blockReference(
  input: unknown,
  blocks: Readonly<Record<string, RawBlock>>,
): string | null {
  const candidate = extractBlockReference(input);
  if (candidate && blocks[candidate]) return candidate;
  return null;
}

function inputLiteral(
  input: unknown,
  blocks: Readonly<Record<string, RawBlock>>,
): string | number | null {
  if (typeof input === 'number') return input;
  if (typeof input === 'string') return blocks[input] ? null : input;
  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const literal = inputLiteral(input[index], blocks);
      if (literal !== null) return literal;
    }
    return null;
  }
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  for (const key of ['value', 'text']) {
    const literal = inputLiteral(value[key], blocks);
    if (literal !== null) return literal;
  }
  return null;
}

/**
 * Phase 2: Lower a scratch `operator_mathop` reporter to a WGSL builtin
 * expression. The scratch input shape is `inputs.NUM` (single unary
 * input); the operator menu string lives in `fields.OPERATOR`.
 *
 * Mappings follow scratch-vm's `Scratch3OperatorsBlocks.mathop`
 * (`vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_operators.js`):
 *
 *   | scratch menu   | WGSL                                          |
 *   | -------------- | --------------------------------------------- |
 *   | abs            | `abs(x)`                                      |
 *   | floor          | `floor(x)`                                    |
 *   | ceiling        | `ceil(x)`                                     |
 *   | sqrt           | `sqrt(x)`                                     |
 *   | sin / cos / tan| `sin/cos/tan(radians(x))` (degrees → radians) |
 *   | asin/acos/atan | `degrees(asin/acos/atan(x))` (radians → deg) |
 *   | ln             | `log(x)` (natural logarithm)                 |
 *   | log            | `log(x) * (1.0 / log(10.0))` (base-10)        |
 *   | e ^            | `exp(x)`                                      |
 *   | 10 ^           | `pow(10.0, x)`                                |
 *
 * `atan2`, `mod`, `round` are separate scratch opcodes (not part of
 * `operator_mathop`) and intentionally remain out of scope here.
 *
 * Unrecognised operators fall back to `0.0` and emit
 * `gpu.emitter_unsupported_opcode` so the user can see what the parser
 * missed.
 */
function emitMathop(block: RawBlock, context: EmitterContext): string {
  const operator = fieldName(block.fields['OPERATOR'])?.toLowerCase() ?? '';
  const input = emitInput(block.inputs['NUM'], context);
  switch (operator) {
    case 'abs':
      return `abs(${input})`;
    case 'floor':
      return `floor(${input})`;
    case 'ceiling':
      return `ceil(${input})`;
    case 'sqrt':
      return `sqrt(${input})`;
    case 'sin':
      return `sin(radians(${input}))`;
    case 'cos':
      return `cos(radians(${input}))`;
    case 'tan':
      return `tan(radians(${input}))`;
    case 'asin':
      return `degrees(asin(${input}))`;
    case 'acos':
      return `degrees(acos(${input}))`;
    case 'atan':
      return `degrees(atan(${input}))`;
    case 'ln':
      return `log(${input})`;
    case 'log':
      // WGSL has no `log10` builtin; use `log(x) / log(10)` with the
      // divisor precomputed as `1 / log(10)` so it folds in the
      // shader-constant phase. Identical observable behaviour to
      // `Math.log10(x)` within f32 precision.
      return `(log(${input}) * ${LOG10_RECIPROCAL_EXPR})`;
    case 'e ^':
      return `exp(${input})`;
    case '10 ^':
      return `pow(10.0, ${input})`;
    default:
      diagnoseUnsupported(block, context);
      return '0.0';
  }
}

function emitListRead(block: RawBlock, context: EmitterContext): string {
  const binding = bindingForList(block, context);
  if (!binding) {
    diagnoseUnsupported(block, context);
    return 'scratch_div(0.0, 0.0)';
  }
  const index = emitInput(block.inputs['INDEX'], context);
  const storageName = context.bindingNames.get(binding.name) ?? binding.name;
  const lengthName = context.lengthNames.get(binding.name) ?? `${storageName}_length`;
  const checkedIndex = `scratch_index_clamp(${index}, u_scratch.${lengthName})`;
  if (binding.dtype === 'f32') {
    return `scratch_list_read_f32(&${storageName}, ${checkedIndex}, u_scratch.${lengthName})`;
  }
  if (binding.dtype === 'i32') {
    return `f32(scratch_list_read_i32(&${storageName}, ${checkedIndex}, u_scratch.${lengthName}))`;
  }
  if (binding.dtype === 'byte') {
    // Each host byte maps to one u32 in the storage buffer (low 8 bits
    // hold the value). Returning the u32 directly is convenient because
    // most callers want an integer; downstream arithmetic will coerce.
    return `f32(scratch_list_read_u32(&${storageName}, ${checkedIndex}, u_scratch.${lengthName}))`;
  }
  diagnoseUnsupported(block, context);
  return 'scratch_div(0.0, 0.0)';
}

function emitListWrite(block: RawBlock, context: EmitterContext): string | null {
  const binding = bindingForList(block, context);
  if (!binding || binding.readOnly) {
    diagnoseUnsupported(block, context);
    return null;
  }
  const index = emitInput(block.inputs['INDEX'], context);
  const value = emitInput(block.inputs['ITEM'], context);
  const storageName = context.bindingNames.get(binding.name) ?? binding.name;
  const lengthName = context.lengthNames.get(binding.name) ?? `${storageName}_length`;
  const checkedIndex = `scratch_index_clamp(${index}, u_scratch.${lengthName})`;
  if (binding.dtype === 'f32') {
    return `scratch_list_write_f32(&${storageName}, ${checkedIndex}, u_scratch.${lengthName}, ${value});`;
  }
  if (binding.dtype === 'i32') {
    return `scratch_list_write_i32(&${storageName}, ${checkedIndex}, u_scratch.${lengthName}, i32(${value}));`;
  }
  if (binding.dtype === 'byte') {
    return `scratch_list_write_u32(&${storageName}, ${checkedIndex}, u_scratch.${lengthName}, u32(${value}));`;
  }
  diagnoseUnsupported(block, context);
  return null;
}

function bindingForList(block: RawBlock, context: EmitterContext): BindDirective | undefined {
  const listName = fieldName(block.fields['LIST']);
  if (listName) {
    // Exact name match first; this is what the runtime bridge uses to
    // resolve a scratch-vm `data_itemoflist` field into a binding.
    const exact = context.bindings.find((binding) => binding.name === listName);
    if (exact) return exact;
  }
  return context.bindings.length === 1 ? context.bindings[0] : undefined;
}

function fieldName(field: unknown): string | null {
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    const first = field[0];
    return typeof first === 'string' ? first : null;
  }
  if (!field || typeof field !== 'object') return null;
  const value = field as Record<string, unknown>;
  // Prefer `id` first: scratch-vm stores variable references as
  // `{ id, name }`, and the runtime bridge keys bindings by their
  // canonical id (`__getListBuffer` looks up by lower-cased name on the
  // runtime side, but the in-emitter shape uses the id from
  // `fields.LIST.id`). Fall back to `name` for tests / hand-built
  // shapes that omit `id`.
  for (const key of ['value', 'id', 'name']) {
    if (typeof value[key] === 'string') return value[key] as string;
  }
  return null;
}

function isNumberReporter(opcode: string): boolean {
  return (
    opcode === 'math_number' ||
    opcode === 'math_integer' ||
    opcode === 'math_whole_number' ||
    opcode === 'math_positive_number' ||
    opcode === 'math_angle'
  );
}

function emitNumberField(block: RawBlock): string {
  // `math_number` and friends store the literal as either `[number, null]`
  // (the shape scratch-vm writes) or `[string, null]` (hand-built test
  // blocks). Accept both so a freshly-generated SB3 fixture parses to the
  // right value without an intermediate string round-trip.
  const field = block.fields['NUM'];
  const value = Array.isArray(field) ? field[0] : field;
  if (typeof value === 'number') {
    return Number.isNaN(value) ? '0.0' : formatF32(value);
  }
  if (typeof value === 'string') {
    const number = Number(value);
    return Number.isNaN(number) ? '0.0' : formatF32(number);
  }
  return '0.0';
}

function formatF32(value: number): string {
  if (Number.isNaN(value)) return 'scratch_div(0.0, 0.0)';
  if (value === Number.POSITIVE_INFINITY) return 'scratch_div(1.0, 0.0)';
  if (value === Number.NEGATIVE_INFINITY) return 'scratch_div(-1.0, 0.0)';
  if (Object.is(value, -0)) return '-0.0';
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function diagnoseUnsupported(block: RawBlock, context: EmitterContext): void {
  if (context.diagnosedBlocks.has(block.id)) return;
  context.diagnosedBlocks.add(block.id);
  context.diagnostics.push({
    severity: 'warn',
    code: 'gpu.emitter_unsupported_opcode',
    message: `opcode '${block.opcode}' is not supported by the WGSL emitter`,
    regionId: context.regionId,
    blockId: block.id,
  });
}

function shortHash(value: string): string {
  return hashedIdentifier(value, 0).slice(-8);
}
