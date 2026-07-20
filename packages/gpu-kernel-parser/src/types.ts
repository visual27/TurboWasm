/**
 * Shared types for the GPU compute kernel pipeline (`src/runtime/gpu-kernel/`).
 *
 * The pipeline is layered:
 *
 *   comment-parser      → parses `@compute` directive text
 *     ↓
 *   region-extractor    → walks project.json blocks to find the substack
 *     ↓                   blocks that form the body of each region
 *   block-subset        → D1 demote verdict
 *   axis-analysis       → D2 demote verdict per @repeat axis
 *   cascade-analysis    → D3 demote verdict (DAG cycles + missing @map)
 *     ↓
 *   wgsl-emitter        → produces the WGSL for the region
 *     ↓
 *   kernel-registry     → canonicalises the AST, caches the GPipeline
 *
 * These types are passed between every layer. They are *deliberately* plain
 * shapes (no scratch-vm imports) so a single unit test can drive the parser
 * without standing up the whole VM.
 *
 * Diagnostic codes mirror §9 of `gpu-kernel-spec-summary.md`. Each layer
 * prefixes its own code (`gpu.dsl_syntax_error`, `d1.region_demoted`,
 * `d2.axis_demoted`, `d3.region_cascade_demoted`, `d4.kernel_runtime_demoted`).
 * Errors that bubble all the way up flow through `useErrorLogStore` →
 * `ErrorLogPanel` with a single severity per region (default warn, demoted
 * to info once `defaultMaxLogs=5` is exceeded).
 */

export type Severity = 'info' | 'warn' | 'error';

export type DemoteStage = 'd1' | 'd2' | 'd3' | 'd4';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  regionId?: string;
  blockId?: string;
  commentOffset?: number;
  line?: number;
  column?: number;
}

/**
 * Per the spec §3.3, an `@repeat Ri:<axis>` carries one of these axis
 * values, or `sequential` (default / safe fallback). D2 demote collapses
 * a non-sequential axis to `'sequential'`.
 */
export type AxisFinal =
  | 'global_x'
  | 'global_y'
  | 'global_z'
  | 'local_x'
  | 'local_y'
  | 'local_z'
  | 'workgroup_x'
  | 'workgroup_y'
  | 'workgroup_z'
  | 'sequential';

export const ALL_AXES: readonly AxisFinal[] = [
  'global_x',
  'global_y',
  'global_z',
  'local_x',
  'local_y',
  'local_z',
  'workgroup_x',
  'workgroup_y',
  'workgroup_z',
] as const;

/**
 * Sub-keys of `inputs` we walk when collecting body blocks across the
 * D1 / D2 classifiers. Shared between `block-subset.ts` and
 * `axis-analysis.ts` so the two never silently diverge — §19.1 #4
 * (verified in this commit: both files previously held an identical
 * copy of the same three keys). `CONDITION` is included because the
 * safety guarantees of D1/D2 hold for any expression the body uses to
 * gate its execution; missing it would silently let unsafe opcodes
 * (e.g. `operator_random` inside `control_if`) slip past D1.
 */
export const HOOK_OPCODE_KEYS = ['SUBSTACK', 'SUBSTACK2', 'CONDITION'] as const;

/**
 * `@bind <name>(<slot>) ro|rw [f32|i32|byte][, scalar]`.
 *
 * `dtype` defaults to `'f32'` when the directive omits it. `slot` is the
 * GPU `@group(0) @binding(N)` index that the WGSL emitter assigns for
 * list bindings. `rw` is true for storage buffers that the body writes
 * to, false for read-only storage (which the kernel-registry can
 * dispatch concurrently).
 *
 * `storageKind` (§Phase 3, scalar uniform binding): when `'scalar'`,
 * the binding is read once at dispatch time as a single number from the
 * scratch global-variable space (`@group(1) @binding(0)` uniform
 * buffer); scalar uniforms do not consume a `slot` index (they share one
 * slot 0). `'list'` is the default for `@bind <name>(N) ...` — it
 * selects the storage-buffer path. The trailing `, scalar` suffix in
 * the DSL maps to `storageKind: 'scalar'`; the trailing `, list` suffix
 * (or omission) maps to `storageKind: 'list'` or `undefined`.
 * `undefined` and `'list'` are equivalent for canonicalisation (see
 * `kernel-registry.ts:stripDirectiveVolatile`).
 *
 * `internalName` (§Phase E): when the user writes a quoted name like
 * `@bind "my list"(0) rw f32`, the directive carries `name = 'my list'`
 * (used for runtime adapter lookups via `__getListBuffer`) and a
 * WGSL-safe `internalName = '__tw_<hash>'` (FNV-1a of `name`). The WGSL
 * emitter uses `internalName` for storage declarations and `let`
 * bindings. `internalName` is `undefined` for unquoted (identifier) names
 * because the existing `safeIdentifier` + reserved-keyword rename pass
 * already produces a valid WGSL name; the field exists only when the
 * surface-syntax name is not a valid WGSL identifier.
 */
export interface BindDirective {
  kind: 'bind';
  name: string;
  internalName?: string;
  slot: number;
  readOnly: boolean;
  dtype: 'f32' | 'i32' | 'byte';
  /**
   * §Phase 3 — `'list'` is the default storage-buffer binding; `'scalar'`
   * routes the binding through the scratch global-variable uniform path.
   * `undefined` is treated as `'list'` everywhere downstream.
   */
  storageKind?: 'list' | 'scalar';
  line: number;
  column: number;
}

/**
 * `@workgroup_size(x)` | `(x,y)` | `(x,y,z)`. The WGSL emitter lifts this
 * directly into the `@compute @workgroup_size` attribute; the runtime
 * may further clamp it to the device's
 * `maxComputeWorkgroupSizeX/Y/Z` (info-level log).
 */
export interface WorkgroupSizeDirective {
  kind: 'workgroup_size';
  x: number;
  y: number;
  z: number;
  line: number;
  column: number;
}

/**
 * `@repeat R<i>[:<axis>] = <formula>, repeatPath="<path>"`.
 *
 * `name` is e.g. `R0`. `axis` defaults to `'sequential'` (the safe
 * fallback) when omitted. `formula` is the raw text after `=` —
 * WGSL-allowed syntax per spec §5.2a (the emitter handles parsing).
 *
 * `internalName` (§Phase E+): same contract as `BindDirective.internalName`
 * — set when the user writes a quoted `@repeat` name. The emitter uses
 * `internalName` in `for` bindings and `let` references; cascade-analysis
 * still keys on `name` so canonical keys remain stable across quoting.
 *
 * `repeatPath` (§Phase 4): structural target identifier — either
 * `self` (= the kernel container that carries the `@compute` marker)
 * or a numeric path (`0`, `0.1`, `1.2.3`, ...) where each segment
 * indexes direct-child `control_repeat` siblings of the parent.
 * Non-repeat sibling blocks are not counted, so adding ordinary
 * scratch statements does not shift the path. The runtime resolver
 * (`repeat-path-resolver.ts`) maps the path onto a concrete
 * `control_repeat` block id; the resolver's output lives on
 * `ResolvedRepeatDirective.resolvedRepeatBlockId` (NOT here).
 *
 * `blockId` is the `@compute` comment anchor — in Phase 4 that is the
 * kernel container's `control_repeat` block id (the comment sits on
 * the `control_repeat` itself, not on its first substack block). It
 * is **not** a repeat target.
 *
 * `boundBlockId` (§Phase 0, nested-parallelization-00-overview §1.1):
 * optional pattern-metadata field. The user-facing DSL no longer
 * writes `blockId=` (Phase 4 replaces it with `repeatPath=`); this
 * field is reserved for the runtime-only skip-site metadata used by
 * `iteration-advance-pattern` / `indirect-access-pattern`. Distinct
 * from `resolvedRepeatBlockId` (the repeat container) and from
 * `blockId` (the comment anchor). Volatile: NOT included in canonical
 * key.
 *
 * §Phase 2 (15.3): the inline `, max=<uint>` suffix was removed in v9.
 * The dispatch cap is derived from the runtime list length (see
 * `wgsl-emitter.ts:emitRegion` and `__dispatch-kernel-sync.ts`).
 */
export interface RepeatDirective {
  kind: 'repeat';
  name: string;
  internalName?: string;
  axis: AxisFinal;
  formula: string;
  /**
   * §Phase 4 — structural repeat target. `self` for the kernel
   * container; otherwise a numeric path of sibling-repeat indices.
   * Resolved to a concrete `control_repeat` block id by
   * `repeat-path-resolver.ts` downstream of parsing.
   */
  repeatPath: string;
  /** The repeat's `control_repeat` block id, for diagnostics. */
  blockId: string;
  /**
   * Runtime-only pattern-site metadata. Not user-authored in Phase 4.
   * Volatile — excluded from canonical key.
   */
  boundBlockId?: string;
  line: number;
  column: number;
}

/**
 * `@map <var> <- <formula>[, blockId="<id>"]`. The body of the region must
 * reference this `var` via a list-write so the GPU-side accumulator can be
 * folded into a single dispatch. `formula` is the raw tail; cascade-analysis
 * builds a dependency graph from it and the WGSL emitter toposorts it into
 * `let` bindings per spec §3.7.
 *
 * `internalName` (§Phase E): mirror of `BindDirective.internalName` —
 * set when the user writes a quoted name. The emitter uses it to derive
 * the WGSL `let` binding name; cascade-analysis still keys the
 * dependency graph on `var` (case-preserving) so canonical keys remain
 * stable across quote-stripping.
 *
 * `boundBlockId` (§Phase 0, nested-parallelization-00-overview §1.1):
 * runtime-only pattern-site metadata. The user-facing DSL no longer
 * writes `blockId=` on `@map` (Phase 4 keeps the parser strict and
 * rejects it as a syntax error); this field is reserved for
 * `indirect-access-pattern` callers. Volatile: NOT included in
 * canonical key.
 */
export interface MapDirective {
  kind: 'map';
  var: string;
  internalName?: string;
  formula: string;
  /** The owning region's `control_repeat` block id, for diagnostics. */
  blockId: string;
  /**
   * Runtime-only pattern-site metadata. Not user-authored in Phase 4.
   * Volatile — excluded from canonical key.
   */
  boundBlockId?: string;
  line: number;
  column: number;
}

export type ParsedDirective =
  | BindDirective
  | WorkgroupSizeDirective
  | RepeatDirective
  | MapDirective;

/**
 * §Phase 4 — a `@repeat` directive whose `repeatPath` has been resolved
 * onto a concrete `control_repeat` block id by
 * `repeat-path-resolver.ts`. `resolvedRepeatBlockId` is the runtime
 * resolution; canonical keys must NOT include it (the user-authored
 * `repeatPath` already determines equality across save-as-new-project
 * renumberings).
 */
export interface ResolvedRepeatDirective extends RepeatDirective {
  resolvedRepeatBlockId: string;
}

/**
 * §Phase 4 — every `@repeat` inside `RegionVerdict.directives` is a
 * `ResolvedRepeatDirective`. The union still carries the same surface
 * (parser output + resolution metadata) so downstream code can keep
 * using the `ParsedDirective` shape but the runtime guarantees a
 * `resolvedRepeatBlockId` for every `@repeat`.
 */
export type ResolvedParsedDirective =
  | BindDirective
  | WorkgroupSizeDirective
  | ResolvedRepeatDirective
  | MapDirective;

/**
 * A raw scratch-vm block shape. We only carry the fields the gpu-kernel
 * pipeline actually reads. The vendored VM's `BlockContainer` has the
 * same fields but with stricter types — tests construct a parsed project
 * with this local shape.
 */
export interface RawBlock {
  id: string;
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, unknown>;
  fields: Record<string, unknown>;
  mutation?: unknown;
  topLevel?: boolean;
  x?: number;
  y?: number;
}

export interface ParsedTarget {
  id: string;
  isStage: boolean;
  blocks: Record<string, RawBlock>;
}

export interface ParsedComment {
  blockId: string;
  text: string;
}

export interface ParsedProject {
  targets: ParsedTarget[];
  comments: Record<string, ParsedComment>;
}

/**
 * A region extracted from a `control_repeat` block that carries a
 * `@compute` comment. We carry the sprite id so multiple sprites can
 * have independent regions; `bodyBlockIds` is the substack (next chain
 * + inner sub-stack traversal, but NOT recursive into another
 * `@compute` region per spec §4.5 — that becomes a D1 demote of the
 * outer region).
 *
 * §Phase 4: `blockId`, `kernelContainerBlockId`, and
 * `commentAnchorBlockId` all point at the same `control_repeat` block
 * (the kernel container) because the `@compute` marker now sits on
 * the `control_repeat` itself. `firstSubstackBlockId` is the kernel
 * container's `inputs.SUBSTACK` head — distinct from the comment
 * anchor. `nestedRepeatContainerBlockIds` was removed in Phase 4; the
 * `repeatPathTable` field replaces it as the resolver's source of
 * truth for `@repeat` target lookup.
 */
export interface ExtractedRegion {
  regionId: string;
  /**
   * Kernel container's `control_repeat` block id. Phase 4 unifies this
   * with `kernelContainerBlockId` and `commentAnchorBlockId` (the
   * `@compute` marker lives on the same block).
   */
  blockId: string;
  spriteId: string;
  commentId: string;
  /**
   * Kernel container's `inputs.SUBSTACK` head. Distinct from
   * `blockId` in Phase 4 because the body lives one level below the
   * kernel container.
   */
  firstSubstackBlockId: string;
  /**
   * Flat list of every block id reachable from the kernel container's
   * substack via `next` traversal. The block-subsetter then walks each
   * block's `inputs.SUBSTACK` / `inputs.SUBSTACK2` separately to find
   * any nested control blocks — a nested `@compute` here triggers D1
   * on the outer region.
   */
  bodyBlockIds: string[];
  /**
   * Phase 4: kernel container's `control_repeat` block id. Identical
   * to `blockId` because the `@compute` marker sits on the container
   * itself.
   */
  kernelContainerBlockId: string;
  /**
   * §Phase 4: structural repeat-path table indexed by `repeatPath`.
   * `self` always points at the kernel container. Numeric paths
   * (`'0'`, `'0.1'`, ...) point at direct-child `control_repeat`
   * siblings counted along each repeat's `SUBSTACK` `next` chain.
   * Non-repeat sibling blocks are not counted, so inserting ordinary
   * scratch statements does not shift any numeric path.
   *
   * `repeat-path-resolver.ts` reads this table to resolve each
   * `@repeat` directive's `repeatPath` onto a concrete `control_repeat`
   * block id (`ResolvedRepeatDirective.resolvedRepeatBlockId`).
   */
  repeatPathTable: Readonly<Record<string, string>>;
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.2): per-sprite region index
   * (0-based). Disambiguates region ids when a sprite carries multiple
   * `@compute` regions. In Phase 1-2 the extractor emitted at most one
   * region per sprite; from Phase 3 onward this is incremented per
   * adopted candidate.
   */
  regionIndex: number;
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.2): populated by
   * `procedure-inliner` (Phase 5). Empty array in Phase 1-4 (no
   * inlining implemented yet).
   */
  inlinedPrototypeBlockIds: readonly string[];
  /**
   * Phase 4: scratch block id that directly carries the `@compute`
   * comment marker. Always equal to `blockId` / `kernelContainerBlockId`
   * because the marker now sits on the kernel container itself; kept on
   * the type for downstream diagnostic helpers that surface a stable
   * block id even when sub-tree discovery shifts.
   */
  commentAnchorBlockId: string;
}

/**
 * Phase 1 (nested-parallelization-02-phase1 §3.1) — auto-detected or
 * explicit "iteration advance" pattern.
 *
 * body 内の `data_changevariableby(<varName>, <delta>)` block を pattern
 * 化したもの。`<varName>` は `@repeat Rx:axis = ...` の Rx か `@bind <var>`
 * に bind されている scratch 変数。
 *
 * `source`:
 *   - 'explicit': user provided `boundBlockId` in `@repeat` / `@map`
 *   - 'auto-detected': parser heuristic (Phase 1)
 *
 * `delta` は `data_changevariableby` の第 2 引数から抽出した数値。
 * `1 | -1` は本仕様書で頻出する二値で、`number` はフォールバック。
 */
export interface IterationAdvancePattern {
  kind: 'iteration-advance';
  /** bound variable name (e.g. 'idx1', 'idx0', 'aabb_idx0'). */
  varName: string;
  /** increment value (typically 1). */
  delta: 1 | -1 | number;
  /** scratch block id (in body). */
  blockId: string;
  /** where this pattern came from. */
  source: 'explicit' | 'auto-detected';
  /** if explicit: the bound directive line/column. */
  directive?: {
    kind: 'repeat' | 'map';
    name: string;
    line: number;
    column: number;
  };
}

/**
 * Phase 2 (nested-parallelization-03-phase2 §3.1) — kernel container
 * もしくは body 内 nested control_repeat の loop count formula から
 * 自動生成される暗黙 axis。
 *
 * - `kernel-container` source: kernel container の `inputs.TIMES`
 *   (= `@compute` を囲む ancestor control_repeat の loop count)。
 *   既定で `name: 'Ry'`, `axis: 'global_y'`。
 * - `nested-repeat` source: candidate (= `@compute`-marked control_repeat)
 *   もしくは body 内 control_repeat の `inputs.TIMES`。
 *   既定で `name: 'Rx<N>'`, `axis: 'global_x'`。N は 0 から連番。
 *
 * 命名は Phase 2 で固定 (ユーザー命名は Phase 5 以降の検討)。canonical
 * key 計算 (`kernel-registry.ts:stripDirectiveVolatile`) には関与しない
 * (= 自動採番で命名揺れがあっても canonical 同一性を維持)。
 */
export interface ImplicitAxis {
  /** axis name (e.g. 'Ry', 'Rx0', 'Rx1'). 自動採番。 */
  name: string;
  /** axis target (e.g. 'global_y', 'global_x'). */
  axis: AxisFinal;
  /** WGSL expression for the loop count (= scratch block chain → WGSL 逆変換結果)。 */
  formula: string;
  /** Source control_repeat block id (診断用)。 */
  blockId: string;
  /** 自動生成元。 */
  source: 'kernel-container' | 'nested-repeat';
}

/**
 * Phase 1 (nested-parallelization-02-phase1 §3.2) — auto-detected or
 * explicit "indirect access" pattern.
 *
 * body 内の `data_itemoflist(LIST=L, INDEX=Rx)` (= read) を pattern 化
 * したもの。`data_replaceitemoflist` (= write) は actual parallel work
 * なので skip-set には入れず、本 helper の対象外。`access === 'read'`
 * 固定。
 *
 * `source`:
 *   - 'explicit': user provided `boundBlockId` in `@map` directive
 *   - 'auto-detected': parser heuristic (Phase 1)
 */
export interface IndirectAccessPattern {
  kind: 'indirect-access';
  /** scratch list name (e.g. 'buff_r', 'aabb_w'). */
  scratchListName: string;
  /** index expression (WGSL-side). e.g. 'idx1' (= Rx + base). */
  indexExpr: string;
  /** scratch-vm opcode. Phase 1: `data_itemoflist` 固定。 */
  opcode: 'data_itemoflist' | 'data_replaceitemoflist';
  /** scratch block id (in body). */
  blockId: string;
  /** whether this is a read or write access. Phase 1: `'read'` 固定。 */
  access: 'read' | 'write';
  source: 'explicit' | 'auto-detected';
  directive?: {
    kind: 'map';
    name: string;
    line: number;
    column: number;
  };
}

/**
 * Phase 1 — emitter が skip-set として扱うパターン union。
 * `effectivePatterns` にはこの union のいずれかが入る。
 */
export type EffectivePattern =
  | { kind: 'iteration-advance'; pattern: IterationAdvancePattern }
  | { kind: 'indirect-access'; pattern: IndirectAccessPattern };

/**
 * Verdict of the D1 axis analysis on a region: `valid: false` with
 * `demoteReason: 'd1'` means the whole region falls back to JS.
 *
 * `effectivePatterns` (Phase 1) は emitter の skip-set となるパターン
 * 集合。`buildBlockSubsetVerdict` 経由でのみ populate され、既存
 * `classifyBlockSubset` 経路では空配列 (or undefined) を返す。optional
 * なのは既存 test の `BlockSubsetVerdict` リテラルを破壊しないため。
 */
export interface BlockSubsetVerdict {
  valid: boolean;
  demoteReason?: DemoteStage;
  diagnostics: Diagnostic[];
  /** Phase 1: effective patterns (explicit + auto-detected, write を除く). */
  effectivePatterns?: EffectivePattern[];
}

/**
 * Per-`@repeat Ri` axis verdict. `finalAxis` is `'sequential'` when D2
 * demote kicked in. Other axes may still run in parallel.
 *
 * `diagnostics` is **reserved for per-axis warnings** — currently empty
 * by design. Region-level diagnostics flow through
 * `AxisAnalysisResult.diagnostics` so a single demote surfaces once at
 * the region level rather than once per axis. The field is kept on the
 * interface so a future per-axis warning (e.g. "this axis ran sequential
 * because of X") has a place to live without churning the type.
 */
export interface AxisVerdict {
  /** The axis declared by `@repeat Ri:<axis>`. */
  requestedAxis: AxisFinal;
  /** The axis we will dispatch on after D2 demote (sequential = JS loop). */
  finalAxis: AxisFinal;
  demoteReason?: DemoteStage;
  diagnostics: Diagnostic[];
}

/**
 * Verdict of the D3 cascade analysis on a region: `valid: false` with
 * `demoteReason: 'd3'` means the whole region falls back to JS.
 */
export interface CascadeVerdict {
  valid: boolean;
  demoteReason?: DemoteStage;
  diagnostics: Diagnostic[];
  /** Topologically ordered list of `@map` `let` names (post-cycle-removal). */
  topoOrder: string[];
}

/**
 * The full verdict for one region. The runtime consults this in M5
 * (kernel-registry) to decide whether to build a pipeline.
 *
 * §Phase 4: `nestedRepeatContainerBlockIds` and `implicitAxes` were
 * removed. Repeats are resolved structurally via
 * `ResolvedRepeatDirective.resolvedRepeatBlockId`; the emitter
 * consults the `repeatByBlockId` map to decide whether a target
 * `control_repeat` runs in parallel, sequential `for`, or is left
 * implicit (= `@repeat` directive missing).
 */
export interface RegionVerdict {
  regionId: string;
  blockId: string;
  spriteId: string;
  /**
   * §Phase 4: every `@repeat` here is a `ResolvedRepeatDirective` with
   * `resolvedRepeatBlockId` populated. The union lets downstream code
   * keep using `ParsedDirective`-style discriminants while the runtime
   * guarantees a resolved block id for repeat lookup.
   */
  directives: ResolvedParsedDirective[];
  blockSubset: BlockSubsetVerdict;
  axes: Record<string, AxisVerdict>;
  cascade: CascadeVerdict;
  diagnostics: Diagnostic[];
  /**
   * Convenience: the WGSL emitter only needs to look at this. It is the
   * list of every axis that survived D2 demote and will run in
   * parallel. Sequential axes are folded back into a `for` loop in
   * WGSL at the structural position of the target `control_repeat`.
   */
  parallelAxes: { repeatName: string; axis: AxisFinal }[];
  /**
   * Phase 4: kernel container's `control_repeat` block id. Always
   * identical to `blockId` because the `@compute` marker sits on the
   * container itself. Kept on the verdict for downstream helpers that
   * need to distinguish the kernel container from the comment anchor
   * when sub-tree discovery shifts.
   */
  kernelContainerBlockId: string;
  /**
   * Phase 4: kernel container's `inputs.SUBSTACK` head. The emitter
   * uses this as the body entry point (NOT the `@compute` marker
   * block).
   */
  firstSubstackBlockId: string;
}
