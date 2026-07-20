/**
 * Centralised diagnostic code constants for the GPU compute kernel
 * pipeline (`src/runtime/gpu-kernel/`).
 *
 * §nested-parallelization-00-overview.md §6.1 — single source of truth for
 * `Diagnostic.code` strings emitted by every layer of the pipeline. AGENTS.md
 * 「エラー表示ポリシー」 通り、`useErrorLogStore` → `ErrorLogPanel` へ流れる。
 *
 * Historical / existing codes remain as raw string literals in their
 * emitting call sites — we do not refactor those here. New codes land in
 * this file so that the catalogue is greppable.
 */

export const GPU_DIAGNOSTIC_CODES = {
  /** Existing. Emitted by `comment-parser.ts` for malformed directives. */
  DSL_SYNTAX_ERROR: 'gpu.dsl_syntax_error',
  /**
   * Phase 0 — reserved for Phase 1. `boundBlockId` named a scratch block
   * that does not exist in the region body.
   */
  BOUND_BLOCK_NOT_FOUND: 'gpu.bound_block_not_found',
  /**
   * Phase 0 — emitted by `region-extractor.ts`. Multiple `@compute`
   * markers found inside a single sprite; only the first candidate is
   * kept and the rest are recorded in `ExtractedRegion.duplicateComputeBlockIds`.
   */
  MULTIPLE_COMPUTE_REGIONS: 'gpu.multiple_compute_regions',
  /**
   * Phase 1 — reserved. `IterationAdvancePattern` / `IndirectAccessPattern`
   * auto-detected from body chain. Surfaced only in debug builds.
   */
  AXIS_AUTO_DETECTED: 'gpu.axis_auto_detected',
  /**
   * Phase 2 — emitted by `implicit-axis.ts` when `scratchBlockToWgslExpr`
   * returns `null` for an implicit axis (kernel container or nested
   * control_repeat with an unsupported loop count formula). The axis is
   * pushed with `formula: ''` so `axis-analysis.ts` can demote it to
   * `sequential`. Severity `warn`.
   */
  IMPLICIT_AXIS_UNSUPPORTED: 'gpu.implicit_axis_unsupported',
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.1) — reserved for Phase 3.
   * Two `@compute` regions end up sharing a kernel container
   * (`control_repeat`) block. Severity `warn`.
   */
  KERNEL_CONTAINER_COLLISION: 'gpu.kernel_container_collision',
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.1) — reserved for Phase 3.
   * Two `@bind` directives inside the same region claim the same
   * `@group(0) @binding(N)` slot index → D1 demote. Severity `error`.
   */
  BIND_SLOT_COLLISION: 'gpu.bind_slot_collision',
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.1) — reserved for Phase 3.
   * The aggregate buffer memory for a single region's storage bindings
   * exceeds 80% of the GPU device's `maxBufferSize`. Severity `warn`.
   */
  REGIONAL_BUFFER_MEMORY_PRESSURE: 'gpu.regional_buffer_memory_pressure',
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.1) — reserved for Phase 4.
   * `@compute` comment sits on the legacy "first substack entry block"
   * position rather than the new "on `control_repeat` itself" loose
   * position. Severity `warn` (fixed by spec).
   */
  LEGACY_COMPUTE_COMMENT_POSITION: 'gpu.legacy_compute_comment_position',
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.1) — reserved for Phase 4.
   * A `@repeat` directive with a parallel axis omitted the required
   * `boundBlockId="<id>"` attribute → D1 demote. Severity `error`.
   */
  BOUND_BLOCK_REQUIRED: 'gpu.bound_block_required',
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.1) — reserved for Phase 5.
   * `procedure-inliner` exceeded `MAX_INLINING_DEPTH` (16) or detected
   * a cycle in the prototype visit set. Severity `error`.
   */
  PROCEDURE_RECURSION_UNSUPPORTED: 'gpu.procedure_recursion_unsupported',
  /**
   * Phase 1 (gpu-kernel-dsl-phase1-spec §1.1) — reserved for Phase 5.
   * A `procedure_call` referenced a prototype block id that does not
   * exist in the sprite. Severity `error`.
   */
  PROCEDURE_PROTOTYPE_NOT_FOUND: 'gpu.procedure_prototype_not_found',
} as const;

export type GpuDiagnosticCode =
  (typeof GPU_DIAGNOSTIC_CODES)[keyof typeof GPU_DIAGNOSTIC_CODES];