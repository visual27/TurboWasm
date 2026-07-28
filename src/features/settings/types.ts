import type { AdvancedSettings } from '@/types/settings';

/**
 * Phase 0 — Foundation.
 *
 * Detailed optimization toggle identifiers. Phase 0 introduces the
 * data model + UI surface only; the underlying optimization work
 * (compare-equal short-circuit, edge-hat sentinel elimination, etc.)
 * is owned by Phase 1+ in `patches/scratch-vm-symbols.md`.
 *
 * The IDs are namespaced so future categories can be added without
 * renaming existing ones — a renaming would invalidate the `// TurboWasm:`
 * marker registry (P0-5) and the in-memory snapshot the master toggle
 * relies on (P0-3).
 */
export type DetailedCategoryId =
  | 'compat-layer'
  | 'edge-detection'
  | 'comparison'
  | 'data-structures'
  | 'compiler';

export type DetailedOptimizationId =
  // Compatibility Layer
  | 'compatLayer.closureReuse'
  | 'compatLayer.procedureCache'
  | 'compatLayer.branchInfoReuse'
  | 'compatLayer.procedureCacheThreadCompaction'
  // Edge Detection
  | 'edgeHat.sentinelElimination'
  // Comparison
  | 'comparison.shortCircuit'
  | 'comparison.infinityBranchRemoval'
  // Data Structures
  | 'data.mapConversionEvaluation'
  | 'data.constantFolding'
  // Compiler
  | 'compiler.generatorGranularityResearch';

/**
 * Per-toggle UI state. `availableInMaster` distinguishes shipped
 * toggles from "research" rows that are visible but disabled until
 * the underlying optimization lands in a future Phase. Phase 0 ships
 * every ID with `availableInMaster: true` so the detailed screen
 * renders the full matrix; Phase 1+ can flip individual IDs to
 * `false` as their patches stabilize.
 */
export interface DetailedOptimizationState {
  id: DetailedOptimizationId;
  enabled: boolean;
  availableInMaster: boolean;
}

export type DetailedOptimizationMap = Readonly<Record<DetailedOptimizationId, boolean>>;

/**
 * SettingsDialog view state (Phase 0 §P0-2-A).
 *
 * Phase 0 keeps the existing single-Dialog layout — push/pop replaces
 * the contents rather than spawning a nested Dialog (which would fight
 * Radix's `pointer-events: none` body lock). `stack` is always
 * non-empty; the bottom entry is the section picker that the master
 * SettingsDialog manages.
 */
export type SettingsViewEntry =
  | { kind: 'section'; section: 'turboWasm' }
  | { kind: 'detailed' }
  | { kind: 'detailed-category'; categoryId: DetailedCategoryId }
  | { kind: 'semantics' };

export type SettingsViewStack = readonly SettingsViewEntry[];

/**
 * Master-toggle polarity. Mirrors `advanced.turboWasmAccelerationEnabled`
 * but is exposed as a separate getter so the UI does not need to know
 * the field lives on `AdvancedSettings`. Phase 0 keeps this derived
 * (no independent state) so the existing "Set as default" forced-true
 * invariant on `advanced.turboWasmAccelerationEnabled` is the single
 * source of truth.
 */
export interface DetailedMasterSnapshot {
  advanced: AdvancedSettings;
  enableWasm: boolean;
  detailed: DetailedOptimizationMap;
}