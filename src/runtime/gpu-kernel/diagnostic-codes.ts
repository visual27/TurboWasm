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
   * Phase 0 — emitted by `region-extractor.ts`. From Phase 3 this fires
   * when a single `control_repeat` block carries multiple `@compute`
   * markers (= the rare comment-duplication case). Per-region adoption
   * is handled separately by `KERNEL_CONTAINER_COLLISION`.
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
   *
   * Phase 4 (gpu-kernel-dsl-phase4-spec §4.4): the user-facing
   * `blockId="<id>"` attribute on `@repeat` was replaced by
   * `repeatPath="<path>"`. The diagnostic stays in the catalogue as
   * a string literal but the runtime no longer emits it (the parser
   * now produces `gpu.repeat_path_required` / `gpu.repeat_path_invalid`
   * instead).
   */
  BOUND_BLOCK_REQUIRED: 'gpu.bound_block_required',
  /**
   * Phase 4 (gpu-kernel-dsl-phase4-spec §4.4): `@repeat` directive
   * omitted the required `repeatPath="<path>"` attribute. Severity
   * `error`. The owning region D1-demotes (region-verdict-pipeline
   * folds this through `PARSER_ERROR_CODES`).
   */
  REPEAT_PATH_REQUIRED: 'gpu.repeat_path_required',
  /**
   * Phase 4 (gpu-kernel-dsl-phase4-spec §4.4): `repeatPath="<path>"`
   * attribute is malformed (unquoted, empty, or fails the lexical
   * grammar). Severity `error`. The owning region D1-demotes.
   */
  REPEAT_PATH_INVALID: 'gpu.repeat_path_invalid',
  /**
   * Phase 4 (gpu-kernel-dsl-phase4-spec §4.4): `repeatPath` value does
   * not resolve to any `control_repeat` block in the region's
   * `repeatPathTable`. Severity `error`. The owning region D1-demotes.
   */
  REPEAT_PATH_NOT_FOUND: 'gpu.repeat_path_not_found',
  /**
   * Phase 4 (gpu-kernel-dsl-phase4-spec §4.4): `repeatPath` is used
   * more than once in the same region, or two paths resolve to the
   * same `control_repeat` block. Severity `error`. The owning region
   * D1-demotes.
   */
  REPEAT_PATH_DUPLICATE: 'gpu.repeat_path_duplicate',
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
  /**
   * §Phase 6 (gpu-kernel-scratch-temporary-let-binding.md §3) —
   * auto-tmp detector found a scratch `data_setvariableto` target
   * that collides with an existing `@bind` / `@map` / `@repeat`
   * directive name in the same region. Severity `error` — the
   * owning region D1-demotes via `PARSER_ERROR_CODES`.
   */
  SCRATCH_VARIABLE_COLLISION: 'gpu.scratch_variable_collision',
  /**
   * §Phase 6 — auto-tmp detector found a cycle in the scratch `let`
   * dependency DAG (= `tmp1 = tmp2 + 1; tmp2 = tmp1 + 1` style).
   * Severity `error` — the owning region D1-demotes via
   * `PARSER_ERROR_CODES`.
   */
  SCRATCH_VARIABLE_CYCLE: 'gpu.scratch_variable_cycle',
  /**
   * §Phase 6 — auto-tmp detector observed multiple `data_setvariableto`
   * writes to the same scratch variable. The detector applies
   * last-write-wins (the last write wins, earlier writes are dropped).
   * Severity `warn` — the user may have meant to use `@map` for
   * sequential binding or to surface the dynamic-semantics divergence.
   */
  SCRATCH_VARIABLE_DUPLICATE_WRITE: 'gpu.scratch_variable_duplicate_write',
  /**
   * §Phase 6 — auto-tmp detector observed a `data_changevariableby`
   * targeting a non-`@bind`/non-`@repeat` scratch variable. The
   * auto-tmp pass is single-assignment-only (WGSL `let` is
   * non-reassignable), so such targets are not promoted. The user
   * is expected to use an explicit `@map` or to inline the
   * accumulation. Severity `info`.
   */
  SCRATCH_VARIABLE_CHANGEVARBY_IGNORED: 'gpu.scratch_variable_changevariableby_ignored',
} as const;

export type GpuDiagnosticCode =
  (typeof GPU_DIAGNOSTIC_CODES)[keyof typeof GPU_DIAGNOSTIC_CODES];