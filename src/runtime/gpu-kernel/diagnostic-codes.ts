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
} as const;

export type GpuDiagnosticCode =
  (typeof GPU_DIAGNOSTIC_CODES)[keyof typeof GPU_DIAGNOSTIC_CODES];