import * as React from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ClickableFieldRow } from './SettingsDialog';
import {
  DETAILED_CATEGORY_LABELS,
  DETAILED_CATEGORY_ORDER,
  DETAILED_OPTIMIZATIONS_BY_CATEGORY,
  DETAILED_OPTIMIZATION_DESCRIPTIONS,
  DETAILED_OPTIMIZATION_LABELS,
} from './constants';
import type {
  DetailedOptimizationId,
  DetailedOptimizationMap,
} from './types';
import type { AdvancedSettings, SemanticOptions } from '@/types/settings';

export interface DetailedSettingsScreenProps {
  masterOn: boolean;
  detailed: DetailedOptimizationMap;
  semantics: SemanticOptions;
  enableWebgpu: boolean;
  enableWasm: boolean;
  customBlockInliningEnabled: boolean;
  patchAdvanced: (patch: Partial<AdvancedSettings>) => void;
  setEnableWasm: (value: boolean) => void;
  onToggleDetailed: (id: DetailedOptimizationId, enabled: boolean) => void;
  onOpenSemantics: () => void;
}

/**
 * Phase 14 (revised) — Detailed Settings screen. Reachable from the
 * dialog root via the `Detailed Settings` navigation row (= a
 * `ClickableFieldRow` in the TurboWasm section). The dialog's view
 * stack pushes `{ kind: 'detailed' }` to mount this screen and pops
 * back to the root when the user presses the `Back` button in the
 * dialog header.
 *
 * Layout: a single h3 + three nested sub-sections (`TurboWasm
 * Pipeline` / `Compatibility Layer` / `Data Structures`) plus a
 * `Semantics` ClickableFieldRow at the bottom. The row invokes
 * `onOpenSemantics` (= the dialog pushes `{ kind: 'semantics' }`).
 *
 * Master-off behaviour: when `masterOn === false` every leaf toggle
 * (= the 3 `TurboWasm Pipeline` rows + the surviving detailed
 * optimization rows + the `Semantics` row) is disabled. The runtime
 * guard in `useSettingsStore.toggleTurboWasmMaster(false)` already
 * forces every related flag to false, so an interactive control here
 * would be a UI lie.
 */
export function DetailedSettingsScreen({
  masterOn,
  detailed,
  semantics,
  enableWebgpu,
  enableWasm,
  customBlockInliningEnabled,
  patchAdvanced,
  setEnableWasm,
  onToggleDetailed,
  onOpenSemantics,
}: DetailedSettingsScreenProps): React.JSX.Element {
  const disabled = !masterOn;
  return (
    <section
      aria-labelledby="settings-section-detailed"
      data-testid="settings-section-detailed"
      className="flex flex-col"
    >
      <h3
        id="settings-section-detailed"
        className="pb-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.35em] text-muted-foreground"
      >
        Detailed Settings
      </h3>

      <Subsection id="pipeline" title="TurboWasm Pipeline">
        <FieldRow
          id="enable-webgpu"
          label="Enable WebGPU"
          description="Offload @compute regions (marked in a project via the // @compute comment DSL) to WebGPU compute shaders. Falls back to the JS path when WebGPU is unavailable or when a region is unsupported (D1/D2/D3 demote). Independent of the WASM toggle below — turning this off disables the GPU compute kernel pipeline without affecting WASM SIMD collision detection."
          disabled={disabled}
          checked={enableWebgpu}
          onChange={(v) => patchAdvanced({ enableWebgpu: v })}
          ariaLabel="Enable WebGPU toggle"
          testId="detailed-toggle-row-enable-webgpu"
        />
        <FieldRow
          id="enable-wasm"
          label="Enable WASM"
          description="Install the WASM-SIMD collision-detection hooks on the renderer. Off clears every TurboWasm hook so the runtime behaves identically to unmodified scratch-render (the Definition-of-Done parity mode). On uses WASM SIMD when it has initialised and falls back to the JS path otherwise. Independent of the WebGPU toggle above."
          disabled={disabled}
          checked={enableWasm}
          onChange={(v) => setEnableWasm(v)}
          ariaLabel="Enable WASM toggle"
          testId="detailed-toggle-row-enable-wasm"
        />
        <FieldRow
          id="custom-block-inlining"
          label="Custom Block Inlining"
          description="When enabled, GPU compute regions can call custom blocks (pre-parse inline expansion). Disable to treat procedure_call as D1-unsafe so regions that use custom blocks fall back to the JS path instead of the GPU pipeline. Power-user toggle: 'Set as default' preserves the current value rather than forcing it on."
          disabled={disabled}
          checked={customBlockInliningEnabled}
          onChange={(v) => patchAdvanced({ customBlockInliningEnabled: v })}
          ariaLabel="Custom Block Inlining toggle"
          testId="detailed-toggle-row-custom-block-inlining"
        />
      </Subsection>

      {DETAILED_CATEGORY_ORDER.map((categoryId) => (
        <Subsection
          key={categoryId}
          id={categoryId}
          title={DETAILED_CATEGORY_LABELS[categoryId]}
        >
          {DETAILED_OPTIMIZATIONS_BY_CATEGORY[categoryId].map((optimizationId) => (
            <DetailedOptimizationRow
              key={optimizationId}
              id={optimizationId}
              disabled={disabled}
              checked={detailed[optimizationId]}
              onChange={(v) => onToggleDetailed(optimizationId, v)}
            />
          ))}
        </Subsection>
      ))}

      <ClickableFieldRow
        id="semantics-settings"
        label="Semantics"
        description={`Comparison / modulo / NaN / truthy semantics. Active preset: ${semantics.preset}. Disabled when TurboWasm Acceleration is OFF.`}
        onClick={onOpenSemantics}
        disabled={disabled}
        ariaLabel="Open semantics settings"
        testId="settings-semantics-row"
      >
        <span
          aria-hidden="true"
          className="text-xs uppercase tracking-[0.2em] text-muted-foreground"
        >
          {semantics.preset}
        </span>
      </ClickableFieldRow>
    </section>
  );
}

interface SubsectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

/**
 * Nested sub-section inside the "Detailed Settings" category. Renders
 * a smaller uppercase title + a divide-y stack of rows. Visually
 * distinct from the outer `SettingsSection` (= it sits one indent
 * level deeper) so the user can tell the section headings apart at a
 * glance.
 */
function Subsection({ id, title, children }: SubsectionProps): React.JSX.Element {
  return (
    <section
      aria-labelledby={`detailed-subsection-${id}`}
      data-testid={`detailed-subsection-${id}`}
      className="flex flex-col pb-2"
    >
      <h4
        id={`detailed-subsection-${id}`}
        className="pb-2 pt-3 text-[10px] font-semibold uppercase tracking-[0.3em] text-muted-foreground/90"
      >
        {title}
      </h4>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

interface FieldRowProps {
  id: string;
  label: string;
  description: string;
  disabled: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  testId: string;
}

function FieldRow({
  id,
  label,
  description,
  disabled,
  checked,
  onChange,
  ariaLabel,
  testId,
}: FieldRowProps): React.JSX.Element {
  return (
    <div
      className="flex items-start justify-between gap-4 py-4"
      data-testid={testId}
    >
      <div className="flex-1">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div
        className="flex shrink-0 items-center gap-2"
        style={{ pointerEvents: 'auto' }}
      >
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-label={ariaLabel}
        />
      </div>
    </div>
  );
}

interface DetailedOptimizationRowProps {
  id: DetailedOptimizationId;
  disabled: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function DetailedOptimizationRow({
  id,
  disabled,
  checked,
  onChange,
}: DetailedOptimizationRowProps): React.JSX.Element {
  return (
    <FieldRow
      id={`detailed-toggle-${id}`}
      label={DETAILED_OPTIMIZATION_LABELS[id]}
      description={DETAILED_OPTIMIZATION_DESCRIPTIONS[id]}
      disabled={disabled}
      checked={checked}
      onChange={onChange}
      ariaLabel={`${DETAILED_OPTIMIZATION_LABELS[id]} toggle`}
      testId={`detailed-toggle-row-${id}`}
    />
  );
}