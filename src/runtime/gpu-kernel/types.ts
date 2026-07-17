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
 * `@bind <name>(<slot>) ro|rw [f32|i32|byte]`.
 *
 * `dtype` defaults to `'f32'` when the directive omits it. `slot` is the
 * GPU `@group(0) @binding(N)` index that the WGSL emitter assigns.
 * `rw` is true for storage buffers that the body writes to, false for
 * read-only storage (which the kernel-registry can dispatch concurrently).
 */
export interface BindDirective {
  kind: 'bind';
  name: string;
  slot: number;
  readOnly: boolean;
  dtype: 'f32' | 'i32' | 'byte';
  line: number;
  column: number;
}

/**
 * `@max length=<uint>` or `@max <groupName>=<uint>`.
 *
 * `groupName` is either `'length'` (dispatch buffer cap) or any other
 * identifier the emitter will lookup against an `@repeat` declaration
 * (e.g. `@max aabb_width=64` paired with `@repeat R0:global_x = aabb_width`).
 */
export interface MaxDirective {
  kind: 'max';
  groupName: string;
  value: number;
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
 * `@repeat R<i>[:<axis>] = <formula>[, max=<uint>]`.
 *
 * `name` is e.g. `R0`. `axis` defaults to `'sequential'` (the safe
 * fallback) when omitted. `formula` is the raw text after `=` —
 * WGSL-allowed syntax per spec §5.2a (the emitter handles parsing).
 */
export interface RepeatDirective {
  kind: 'repeat';
  name: string;
  axis: AxisFinal;
  formula: string;
  /**
   * Explicit per-`@repeat` cap (overrides `@max`). `undefined` means the
   * emitter falls back to `@max` then runtime list length (per spec §3.5).
   */
  max?: number;
  /** The repeat's `control_repeat` block id, for diagnostics. */
  blockId: string;
  line: number;
  column: number;
}

/**
 * `@map <var> <- <formula>`. The body of the region must reference this
 * `var` via a list-write so the GPU-side accumulator can be folded into a
 * single dispatch. `formula` is the raw tail; cascade-analysis builds a
 * dependency graph from it and the WGSL emitter toposorts it into `let`
 * bindings per spec §3.7.
 */
export interface MapDirective {
  kind: 'map';
  var: string;
  formula: string;
  /** The owning region's `control_repeat` block id, for diagnostics. */
  blockId: string;
  line: number;
  column: number;
}

export type ParsedDirective =
  | BindDirective
  | MaxDirective
  | WorkgroupSizeDirective
  | RepeatDirective
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
 */
export interface ExtractedRegion {
  regionId: string;
  blockId: string;
  spriteId: string;
  commentId: string;
  firstSubstackBlockId: string;
  /**
   * Flat list of every block id reachable from the entry substack via
   * `next` traversal. The block-subsetter then walks each block's
   * `inputs.SUBSTACK` / `inputs.SUBSTACK2` separately to find any
   * nested control blocks — a nested `@compute` here triggers D1 on the
   * outer region.
   */
  bodyBlockIds: string[];
}

/**
 * Verdict of the D1 axis analysis on a region: `valid: false` with
 * `demoteReason: 'd1'` means the whole region falls back to JS.
 */
export interface BlockSubsetVerdict {
  valid: boolean;
  demoteReason?: DemoteStage;
  diagnostics: Diagnostic[];
}

/**
 * Per-`@repeat Ri` axis verdict. `finalAxis` is `'sequential'` when D2
 * demote kicked in. Other axes may still run in parallel.
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
 */
export interface RegionVerdict {
  regionId: string;
  blockId: string;
  spriteId: string;
  directives: ParsedDirective[];
  blockSubset: BlockSubsetVerdict;
  axes: Record<string, AxisVerdict>;
  cascade: CascadeVerdict;
  diagnostics: Diagnostic[];
  /**
   * Convenience: the WGSL emitter only needs to look at this. It is the
   * list of every axis that survived D2 demote and will run in
   * parallel. Sequential axes are folded back into a for-loop in WGSL
   * (or, more simply, the kernel is just skipped and JS runs).
   */
  parallelAxes: { repeatName: string; axis: AxisFinal }[];
}
