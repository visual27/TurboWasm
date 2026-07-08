import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SelectField } from '@/components/ui/select';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { clampFps, clampStageHeight, clampStageWidth, clampVolume, formatInteger } from '@/utils/format';
import type { AdvancedSettings, PerformanceMode, SvgAccelerationMode } from '@/types/settings';
import { Button } from '@/components/ui/button';

/**
 * Human-readable labels + descriptions for the Performance Mode dropdown.
 * Kept here (next to the Settings dialog) rather than next to the type
 * because they are presentation strings and the type file is loaded by
 * tests / persistence code that has no opinion on UI copy.
 */
const PERFORMANCE_MODE_OPTIONS: ReadonlyArray<{
  value: PerformanceMode;
  label: string;
  description: string;
}> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'WebGPU → WASM SIMD → JavaScript',
  },
  {
    value: 'force-webgpu',
    label: 'Force WebGPU',
    description: 'WebGPU only; falls back to WASM SIMD, then JavaScript',
  },
  {
    value: 'force-wasm',
    label: 'Force WASM SIMD',
    description: 'WASM SIMD only; falls back to JavaScript',
  },
  {
    value: 'legacy-only',
    label: 'Legacy only',
    description: 'Identical to unmodified scratch-render (parity mode)',
  },
];

/**
 * UI-visible SVG acceleration modes. The 4th value
 * (`'resvg-visual-equivalence'`) is reserved for a future Stage and is
 * intentionally NOT surfaced — the Settings dialog only presents the
 * three modes the runtime can actually use.
 */
const SVG_ACCELERATION_MODE_OPTIONS: ReadonlyArray<{
  value: SvgAccelerationMode;
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Off',
    description: 'Bit-identical to TurboWarp native (Stage 1 baseline).',
  },
  {
    value: 'cache-only',
    label: 'Cache only',
    description: 'Reuses the browser-decoded ImageBitmap across setSVG calls.',
  },
  {
    value: 'mip-chain',
    label: 'MIP chain',
    description: 'Pre-decodes multiple scales; offloads to a Web Worker when available.',
  },
];

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FieldRowProps {
  id: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}

function FieldRow({ id, label, description, children }: FieldRowProps): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="flex-1">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        {description && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

interface NumberFieldProps {
  id: string;
  value: number;
  /**
   * Called once, on commit (blur or Enter). Intermediate keystrokes do NOT
   * invoke this callback — the field buffers them in local state and only
   * writes the parsed value to the parent when the user finalizes the
   * input. This keeps `patchAdvanced` (and the runtime side effects that
   * hang off it, like `vm.setFramerate` / `vm.setStageSize`) from firing
   * mid-edit, which previously let partial values like `clampFps(0) = 1`
   * poison the runtime framerate.
   */
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel?: string;
  /**
   * Optional override for the input's width utility classes. Defaults to
   * `h-9 w-24 text-right tabular-nums` (the FPS / stage-size style). Pass
   * `h-9 w-16 text-right tabular-nums` for the narrower volume input.
   */
  className?: string;
}

function NumberField({
  id,
  value,
  onCommit,
  min,
  max,
  step = 1,
  ariaLabel,
  className = 'h-9 w-24 text-right tabular-nums',
}: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<string>(() => formatInteger(value));
  // Set to true when the user pressed Escape. We check this in `onBlur`
  // because rolling back via `setDraft` is asynchronous (React batches
  // the state update), so by the time the synthetic blur fires the
  // closure-captured `draft` is still the pre-rollback value. Without
  // this flag, blurring after Escape would re-commit the now-rejected
  // value (e.g. `999` → clamped to `240` for FPS) and overwrite the
  // store with the rejected input.
  const skipNextBlurCommitRef = React.useRef<boolean>(false);

  // Re-sync the draft when the external value changes (reset, twconfig merge,
  // programmatic patch, slider sync). We skip the sync only when the user
  // has actually edited the draft (i.e. typed something) — using `focused`
  // here was wrong because Radix's `Dialog` auto-focuses the first input
  // on open, which would otherwise block the dialog from ever reflecting
  // external `value` changes while a `NumberField` is the autofocus target.
  // `dirtyRef` is set by `onChange` and cleared on commit / rollback.
  const dirtyRef = React.useRef<boolean>(false);
  React.useEffect(() => {
    if (!dirtyRef.current) setDraft(formatInteger(value));
  }, [value]);

  const commit = React.useCallback((): void => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      setDraft(formatInteger(value));
      dirtyRef.current = false;
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(formatInteger(value));
      dirtyRef.current = false;
      return;
    }
    const rounded = Math.round(parsed);
    const lo = typeof min === 'number' ? min : Number.NEGATIVE_INFINITY;
    const hi = typeof max === 'number' ? max : Number.POSITIVE_INFINITY;
    const clamped = Math.min(Math.max(rounded, lo), hi);
    onCommit(clamped);
    setDraft(formatInteger(clamped));
    // The committed value now matches the store, so the draft is no
    // longer "dirty" — subsequent external `value` changes can sync
    // freely again.
    dirtyRef.current = false;
  }, [draft, value, min, max, onCommit]);

  const rollback = React.useCallback((): void => {
    setDraft(formatInteger(value));
    dirtyRef.current = false;
  }, [value]);

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      value={draft}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      onFocus={() => undefined}
      onBlur={() => {
        if (skipNextBlurCommitRef.current) {
          skipNextBlurCommitRef.current = false;
          return;
        }
        commit();
      }}
      onChange={(e) => {
        dirtyRef.current = true;
        setDraft(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          skipNextBlurCommitRef.current = true;
          rollback();
          e.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}

interface SwitchFieldProps {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}

function SwitchField({ id, checked, onChange, ariaLabel }: SwitchFieldProps): React.JSX.Element {
  return <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={ariaLabel} />;
}

interface SettingsSectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

/**
 * One category in the settings list. Renders the uppercase title, the
 * rows, and a horizontal rule beneath. The rule visually separates this
 * section from the next one; the section itself does not have its own
 * background or border.
 */
function SettingsSection({ id, title, children }: SettingsSectionProps): React.JSX.Element {
  return (
    <section aria-labelledby={`settings-section-${id}`} className="flex flex-col">
      <h3
        id={`settings-section-${id}`}
        data-testid={`settings-section-${id}`}
        className="pb-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.35em] text-muted-foreground"
      >
        {title}
      </h3>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

interface RuntimeSectionProps {
  advanced: AdvancedSettings;
  patch: (patch: Partial<AdvancedSettings>) => void;
}

const RuntimeSection = React.memo(function RuntimeSection({
  advanced,
  patch,
}: RuntimeSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="runtime" title="Runtime">
      <FieldRow id="fps" label="FPS" description="Maximum frames rendered per second.">
        <NumberField
          id="fps"
          value={advanced.fps}
          onCommit={(v) => patch({ fps: clampFps(v) })}
          min={1}
          max={240}
          ariaLabel="FPS"
        />
      </FieldRow>
      <FieldRow
        id="turbo-mode"
        label="Turbo Mode"
        description="Run without framerate limit when supported."
      >
        <SwitchField
          id="turbo-mode"
          checked={advanced.turboMode}
          onChange={(v) => patch({ turboMode: v })}
        />
      </FieldRow>
      <FieldRow
        id="interpolation"
        label="Interpolation"
        description="Smooth motion between frames."
      >
        <SwitchField
          id="interpolation"
          checked={advanced.interpolation}
          onChange={(v) => patch({ interpolation: v })}
        />
      </FieldRow>
      <FieldRow
        id="warpTimer"
        label="Warp Timer"
        description="Run custom blocks without screen refresh."
      >
        <SwitchField
          id="warpTimer"
          checked={advanced.warpTimer}
          onChange={(v) => patch({ warpTimer: v })}
        />
      </FieldRow>
    </SettingsSection>
  );
});

const RenderingSection = React.memo(function RenderingSection({
  advanced,
  patch,
}: RuntimeSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="rendering" title="Rendering">
      <FieldRow id="hq-pen" label="High Quality Pen" description="Smoother pen rendering (slower).">
        <SwitchField
          id="hq-pen"
          checked={advanced.highQualityPen}
          onChange={(v) => patch({ highQualityPen: v })}
        />
      </FieldRow>
      <FieldRow
        id="stage-size"
        label="Stage Size"
        description="Stage canvas width and height in pixels."
      >
        <div className="flex items-center gap-2">
          <NumberField
            id="stage-width"
            value={advanced.stageWidth}
            onCommit={(v) => patch({ stageWidth: clampStageWidth(v) })}
            min={1}
            max={8192}
            ariaLabel="Stage width"
          />
          <span className="text-xs text-muted-foreground">×</span>
          <NumberField
            id="stage-height"
            value={advanced.stageHeight}
            onCommit={(v) => patch({ stageHeight: clampStageHeight(v) })}
            min={1}
            max={8192}
            ariaLabel="Stage height"
          />
        </div>
      </FieldRow>
    </SettingsSection>
  );
});

const LimitsSection = React.memo(function LimitsSection({
  advanced,
  patch,
}: RuntimeSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="limits" title="Limits">
      <FieldRow
        id="infinite-clones"
        label="Infinity Clones"
        description="Remove the 300-clone limit."
      >
        <SwitchField
          id="infinite-clones"
          checked={advanced.infiniteClones}
          onChange={(v) => patch({ infiniteClones: v })}
        />
      </FieldRow>
      <FieldRow
        id="remove-fencing"
        label="Remove Fencing"
        description="Allow sprites to leave the stage."
      >
        <SwitchField
          id="remove-fencing"
          checked={advanced.removeFencing}
          onChange={(v) => patch({ removeFencing: v })}
        />
      </FieldRow>
      <FieldRow
        id="remove-misc-limits"
        label="Remove Misc Limits"
        description="Lift miscellaneous runtime limits."
      >
        <SwitchField
          id="remove-misc-limits"
          checked={advanced.removeMiscLimits}
          onChange={(v) => patch({ removeMiscLimits: v })}
        />
      </FieldRow>
    </SettingsSection>
  );
});

const OthersSection = React.memo(function OthersSection({
  advanced,
  patch,
}: RuntimeSectionProps): React.JSX.Element {
  const volume = useSettingsStore((s) => s.volume);
  const setVolume = useSettingsStore((s) => s.setVolume);
  const performanceMode = useSettingsStore((s) => s.performanceMode);
  const setPerformanceMode = useSettingsStore((s) => s.setPerformanceMode);
  const svgAccelerationMode = useSettingsStore((s) => s.svgAccelerationMode);
  const setSvgAccelerationMode = useSettingsStore((s) => s.setSvgAccelerationMode);
  const onSliderChange = React.useCallback(
    (values: number[]) => {
      const v = values[0];
      if (typeof v === 'number') setVolume(clampVolume(v));
    },
    [setVolume],
  );
  const onVolumeCommit = React.useCallback(
    (v: number) => setVolume(clampVolume(v)),
    [setVolume],
  );
  // Stable reference so Radix Slider doesn't see a fresh `[volume]` array
  // each render.
  const volumeArr = React.useMemo(() => [volume], [volume]);
  const onPerformanceModeChange = React.useCallback(
    (mode: PerformanceMode) => setPerformanceMode(mode),
    [setPerformanceMode],
  );
  const onSvgAccelerationModeChange = React.useCallback(
    (mode: SvgAccelerationMode) => setSvgAccelerationMode(mode),
    [setSvgAccelerationMode],
  );
  return (
    <SettingsSection id="others" title="Others">
      <FieldRow id="volume" label="Volume" description="Master audio volume.">
        <div className="flex items-center gap-2">
          <Slider
            value={volumeArr}
            min={0}
            max={100}
            step={1}
            onValueChange={onSliderChange}
            aria-label="Volume slider"
            className="w-32"
          />
          <NumberField
            id="volume"
            value={volume}
            onCommit={onVolumeCommit}
            min={0}
            max={100}
            step={1}
            ariaLabel="Volume number"
            className="h-9 w-16 text-right tabular-nums"
          />
        </div>
      </FieldRow>
      <FieldRow
        id="disable-compiler"
        label="Disable Compiler"
        description="Force the VM to interpret scripts (slower but more compatible)."
      >
        <SwitchField
          id="disable-compiler"
          checked={advanced.disableCompiler}
          onChange={(v) => patch({ disableCompiler: v })}
        />
      </FieldRow>
      <FieldRow
        id="turbo-wasm-acceleration"
        label="TurboWasm Acceleration"
        description="Offload collision detection to a WebAssembly SIMD module. Falls back to the JS path automatically when SIMD is unavailable, when a sprite has a shape-changing visual effect (mosaic, pixelate, whirl, fisheye) active, or when the color-matching path is exercised under a color/brightness effect. Ignored when Performance Mode is 'legacy-only'."
      >
        <SwitchField
          id="turbo-wasm-acceleration"
          checked={advanced.turboWasmAccelerationEnabled}
          onChange={(v) => patch({ turboWasmAccelerationEnabled: v })}
          ariaLabel="TurboWasm Acceleration toggle"
        />
      </FieldRow>
      <FieldRow
        id="performance-mode"
        label="Performance Mode"
        description="Selects the rendering / collision-detection backend. 'auto' picks the best available (WebGPU → WASM SIMD → JS). 'force-webgpu' / 'force-wasm' skip the higher tier when it fails to initialise. 'legacy-only' disables all TurboWasm hooks so the runtime behaves identically to unmodified scratch-render."
      >
        <SelectField<PerformanceMode>
          id="performance-mode"
          value={performanceMode}
          onChange={onPerformanceModeChange}
          options={PERFORMANCE_MODE_OPTIONS}
          ariaLabel="Performance mode"
        />
      </FieldRow>
      <FieldRow
        id="svg-acceleration-mode"
        label="SVG Acceleration"
        description="How the renderer prepares SVG textures. 'Off' uses TurboWarp native decoding bit-identically (Stage 1 baseline). 'Cache only' reuses the browser-decoded ImageBitmap across setSVG calls. 'MIP chain' pre-decodes multiple scales and offloads large SVGs to a Web Worker when available (falls back to main thread on Safari FP). All three modes are pixel-equivalent to 'Off'."
      >
        <SelectField<SvgAccelerationMode>
          id="svg-acceleration-mode"
          value={svgAccelerationMode}
          onChange={onSvgAccelerationModeChange}
          options={SVG_ACCELERATION_MODE_OPTIONS}
          ariaLabel="SVG acceleration mode"
        />
      </FieldRow>
    </SettingsSection>
  );
});

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): React.JSX.Element {
  const advanced = useSettingsStore((s) => s.advanced);
  const patch = useSettingsStore((s) => s.patchAdvanced);
  const resetAdvanced = useSettingsStore((s) => s.resetAdvanced);
  const saveAdvancedAsDefault = useSettingsStore((s) => s.saveAdvancedAsDefault);
  const onResetClick = React.useCallback(() => resetAdvanced(), [resetAdvanced]);
  const onSetDefaultClick = React.useCallback(() => saveAdvancedAsDefault(), [saveAdvancedAsDefault]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Layout:
          - Header (title) pinned to the top.
          - ScrollArea fills the rest of the dialog, holding the
            vertically-stacked SettingsSection blocks separated by
            horizontal rules.
          - Footer (Reset / Set as default) pinned to the bottom.
        Padding on the header / footer is supplied by the section itself;
        the ScrollArea only provides vertical scrolling.
      */}
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="px-8 pb-3 pt-8">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Separator />

        {/*
          Same flex pattern as the Extension Permission dialog: pair the
          Radix primitive with explicit `min-h-0 h-0 flex-1` so the
          scroll container can both shrink below its content height and
          grow to fill the parent. The Radix Viewport inside the
          ScrollArea handles vertical scrolling — we deliberately do
          NOT also put `overflow-y-auto` on the inner div, because the
          double-scrollbar pattern fights Radix's own height calculation
          and previously left both layers un-scrollable. Padding now
          lives on the inner div only.
        */}
        <ScrollArea className="min-h-0 h-0 flex-1" data-testid="settings-scroll-area">
          <div className="flex flex-col gap-7 px-8 py-6">
            <RuntimeSection advanced={advanced} patch={patch} />
            <RenderingSection advanced={advanced} patch={patch} />
            <LimitsSection advanced={advanced} patch={patch} />
            <OthersSection advanced={advanced} patch={patch} />
          </div>
        </ScrollArea>

        <Separator />
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 px-8 pb-6 pt-4 sm:justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={onResetClick}
            aria-label="Reset advanced settings to defaults"
            data-testid="settings-reset"
          >
            Reset to defaults
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onSetDefaultClick}
            aria-label="Save current advanced settings as the new defaults"
            data-testid="settings-set-default"
          >
            Set as default
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
