import type { AdvancedSettings } from '@/types/settings';

/**
 * Phase 0 — Foundation.
 *
 * Detailed optimization toggle identifiers. After the v14 settings-dialog
 * refactor (= navigation-state retired + Settings accordion restructured),
 * only the IDs that are actually wired into a runtime gate survive in
 * the `DetailedOptimizationMap`. The Phase 1 cosmetic IDs
 * (= `comparison.shortCircuit` / `comparison.infinityBranchRemoval` /
 * `edgeHat.sentinelElimination`) are unconditionally applied by the
 * vendored runtime patch and never read from the map, so removing the
 * UI toggles does not affect runtime behaviour — but the toggle keys
 * are also dropped so a stale localStorage payload does not carry a
 * dangling key. The Phase 2 cosmetic IDs (= `compatLayer.closureReuse`
 * / `compatLayer.procedureCache`), the unwired
 * `compatLayer.procedureCacheThreadCompaction`, and the research-only
 * `compiler.generatorGranularityResearch` row all fall under the same
 * "no runtime gate" rationale. See
 * `scripts/patches/scratch-vm-symbols.md` for the marker-by-marker
 * rationale and `src/lib/persistence.ts:migrateV13ToV14` for the
 * localStorage silent drop.
 *
 * The remaining IDs map 1:1 to `runtime.setCompilerOptions` keys:
 * `data.constantFolding` → `constantFoldingEnabled` (Phase 3),
 * `compatLayer.branchInfoReuse` → `branchInfoPoolEnabled` (Phase 4A),
 * `data.mapConversionEvaluation` → `mapConversionEnabled` (Phase 4B).
 */
export type DetailedCategoryId = 'compat-layer' | 'data-structures';

export type DetailedOptimizationId =
  // Compatibility Layer
  | 'compatLayer.branchInfoReuse'
  // Data Structures
  | 'data.mapConversionEvaluation'
  | 'data.constantFolding';

/**
 * Per-toggle UI state. Kept for backward-compatibility with downstream
 * consumers that may have used the type; the SettingsDialog no longer
 * renders individual toggle rows beyond the three wired IDs that map
 * directly onto `setCompilerOptions` keys.
 */
export interface DetailedOptimizationState {
  id: DetailedOptimizationId;
  enabled: boolean;
  availableInMaster: boolean;
}

export type DetailedOptimizationMap = Readonly<Record<DetailedOptimizationId, boolean>>;

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