import { useSettingsStore } from '@/stores/useSettingsStore';
import type { SemanticOptions, SemanticPreset } from '@/types/settings';

/**
 * §Phase 7 — store-side binding used by `SettingsDialog` to wire
 * `SemanticsScreen` to `useSettingsStore` without forcing the dialog
 * component to know about the store surface. The master toggle is
 * read separately (= the dialog owns the master-on prop) so this
 * hook does not subscribe to the master field.
 *
 * §Phase 14 — the binding no longer surfaces `onClose`: the dialog
 * owns the inline-expansion boolean and wires `onClose` itself, so
 * the binding stays purely store-driven.
 */
export function useSemanticsScreenBinding(): {
  semantics: SemanticOptions;
  onPatch: (options: Partial<SemanticOptions>) => void;
  onApplyPreset: (preset: SemanticPreset) => void;
} {
  const semantics = useSettingsStore((s) => s.advanced.semantics);
  const patchSemantic = useSettingsStore((s) => s.patchSemantic);
  const applySemanticPreset = useSettingsStore((s) => s.applySemanticPreset);
  return {
    semantics,
    onPatch: patchSemantic,
    onApplyPreset: applySemanticPreset,
  };
}
