import type { AdvancedSettings } from '@/types/settings';

/**
 * Phase 0 — Foundation.
 *
 * Detailed optimization toggle identifiers. After the v14 settings-dialog
 * refactor only the IDs that are actually wired into a runtime gate
 * (= `setCompilerOptions` key in `src/runtime/settings-bridge.ts`)
 * survive in the `DetailedOptimizationMap`. The previously exposed
 * categories `edge-detection` / `comparison` / `compiler` were removed
 * because every ID they contained was cosmetic (= no vendored runtime
 * gate, see `scripts/patches/scratch-vm-symbols.md`).
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
 * Phase 14 (revised) — SettingsDialog view stack. The dialog maintains
 * a tiny history stack and swaps its body when the user drills into a
 * sub-screen (`Detailed Settings`, `Semantics`). Push replaces the
 * dialog body rather than spawning a nested Dialog (which would fight
 * Radix's `pointer-events: none` body lock). The stack is always
 * non-empty; the bottom entry is the section picker that the master
 * SettingsDialog manages.
 */
export type SettingsViewEntry =
  | { kind: 'section' }
  | { kind: 'detailed' }
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