import * as React from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SemanticOptions, SemanticPreset } from '@/types/settings';
import {
  SEMANTIC_FLAG_DESCRIPTIONS,
  SEMANTIC_FLAG_LABELS,
  SEMANTIC_FLAG_ORDER,
  SEMANTIC_PRESET_DESCRIPTIONS,
  SEMANTIC_PRESET_LABELS,
} from './constants';

export interface SemanticsScreenProps {
  masterOn: boolean;
  semantics: SemanticOptions;
  onPatch: (options: Partial<SemanticOptions>) => void;
  onApplyPreset: (preset: SemanticPreset) => void;
}

/**
 * §Phase 7 — Semantics settings panel. Reachable from the Detailed
 * Settings screen via the `Semantics` ClickableFieldRow. The dialog's
 * view stack pushes `{ kind: 'semantics' }` to mount this screen and
 * pops back to the Detailed Settings view when the user presses the
 * `Back` button in the dialog header.
 *
 * Shows the four presets (= `scratch` / `low-risk-js` / `full-js` /
 * `custom`) as a radio group at the top, then the five per-flag
 * switches below.
 *
 * Master-off behaviour: when `masterOn === false` (= the user turned
 * the TurboWasm Acceleration master toggle off) every preset button
 * and every per-flag switch is disabled — the runtime gate in
 * `settings-bridge.applyAdvancedSettings` skips `setCompilerOptions`
 * when the master is off, so flipping a switch would be a UI lie.
 * The semantics warning (= twconfig applied a non-Scratch preset)
 * stays visible regardless, since the warning was emitted at
 * project-load time and remains valid even after the master is
 * turned off.
 */
export function SemanticsScreen({
  masterOn,
  semantics,
  onPatch,
  onApplyPreset,
}: SemanticsScreenProps): React.JSX.Element {
  return (
    <section
      aria-labelledby="semantics-screen-title"
      data-testid="semantics-screen"
      className="flex flex-col"
    >
      <h3
        id="semantics-screen-title"
        className="pb-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.35em] text-muted-foreground"
      >
        Semantics
      </h3>
      <p className="pb-4 text-xs leading-relaxed text-muted-foreground">
        Choose how values behave; non-Scratch presets may change project results.
      </p>
      <PresetRow
        currentPreset={semantics.preset}
        disabled={!masterOn}
        onSelect={onApplyPreset}
      />
      <Separator className="my-4" />
      <div className="divide-y divide-border">
        {SEMANTIC_FLAG_ORDER.map((flag) => {
          if (flag === 'preset') return null;
          const checked = semantics[flag];
          const disabled = !masterOn || semantics.preset !== 'custom';
          return (
            <div
              key={flag}
              className="flex items-start justify-between gap-4 py-4"
              data-testid={`semantics-flag-row-${flag}`}
            >
              <div className="flex-1">
                <Label htmlFor={`semantics-flag-${flag}`} className="text-sm">
                  {SEMANTIC_FLAG_LABELS[flag]}
                </Label>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {SEMANTIC_FLAG_DESCRIPTIONS[flag]}
                </p>
              </div>
              <div
                className="flex shrink-0 items-center gap-2"
                style={{ pointerEvents: 'auto' }}
              >
                <Switch
                  id={`semantics-flag-${flag}`}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(value) => onPatch({ [flag]: value })}
                  aria-label={`${SEMANTIC_FLAG_LABELS[flag]} toggle`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface PresetRowProps {
  currentPreset: SemanticPreset;
  disabled: boolean;
  onSelect: (preset: SemanticPreset) => void;
}

const PRESET_ORDER: readonly SemanticPreset[] = [
  'scratch',
  'low-risk-js',
  'full-js',
  'custom',
] as const;

function PresetRow({ currentPreset, disabled, onSelect }: PresetRowProps): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="Semantic preset" className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {PRESET_ORDER.map((preset) => {
          const selected = preset === currentPreset;
          return (
            <Button
              key={preset}
              type="button"
              role="radio"
              aria-checked={selected}
              variant={selected ? 'default' : 'outline'}
              size="sm"
              disabled={disabled}
              onClick={() => onSelect(preset)}
              data-testid={`semantics-preset-${preset}`}
              style={{ pointerEvents: 'auto' }}
              className={cn(
                'min-w-[7rem]',
                selected ? '' : 'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {SEMANTIC_PRESET_LABELS[preset]}
            </Button>
          );
        })}
      </div>
      <p
        className="text-[11px] leading-relaxed text-muted-foreground"
        data-testid="semantics-preset-description"
      >
        {SEMANTIC_PRESET_DESCRIPTIONS[currentPreset]}
      </p>
    </div>
  );
}