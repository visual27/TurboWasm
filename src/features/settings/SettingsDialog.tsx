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
import { useSettingsStore } from '@/stores/useSettingsStore';
import { clampFps, clampStageHeight, clampStageWidth, clampVolume, formatInteger } from '@/utils/format';
import type { AdvancedSettings } from '@/types/settings';
import { Button } from '@/components/ui/button';
import { FPS_MAX, FPS_MIN } from '@/utils/constants';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  canPop,
  createInitialStack,
  currentView,
  popView,
  pushView,
  stackToBreadcrumb,
} from '@/features/settings/navigation-state';
import type {
  SettingsViewEntry,
  SettingsViewStack,
} from '@/features/settings/types';
import { DetailedSettingsScreen } from '@/features/settings/DetailedSettingsScreen';
import { DetailedCategoryScreen } from '@/features/settings/DetailedCategoryScreen';

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

interface ClickableFieldRowProps {
  id: string;
  label: string;
  description?: string;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
  children?: React.ReactNode;
}

/**
 * Phase 0 — Foundation. FieldRow-shaped row that delegates activation
 * to `onClick` instead of a child. Used for navigation rows (e.g.
 * "Detailed Settings"). The wrapper button has `pointer-events: auto`
 * inline because Radix Dialog applies `pointer-events: none` to
 * `<body>` while open — that CSS is inherited by all descendants,
 * including the portal-mounted row, and would otherwise swallow
 * clicks. See AGENTS.md §「症状 → 見るべき場所」for the historical
 * context.
 *
 * Optional `children` are rendered just before the chevron icon so a
 * caller can decorate the trailing area (e.g. a "0/5 off" count).
 */
function ClickableFieldRow({
  id,
  label,
  description,
  onClick,
  disabled,
  ariaLabel,
  testId,
  children,
}: ClickableFieldRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      id={id}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      style={{ pointerEvents: 'auto' }}
      className="group flex w-full items-start justify-between gap-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex-1">
        <span className="text-sm">{label}</span>
        {description && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
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
          min={FPS_MIN}
          max={FPS_MAX}
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

const TurboWasmSection = React.memo(function TurboWasmSection({
  advanced,
  patch,
  onOpenDetailed,
}: RuntimeSectionProps & { onOpenDetailed?: () => void }): React.JSX.Element {
  const enableWasm = useSettingsStore((s) => s.enableWasm);
  const setEnableWasm = useSettingsStore((s) => s.setEnableWasm);
  // §Phase 1 — the master switch drives `toggleTurboWasmMaster(value)`
  // (= snapshot + force-all-false + clear-on-reset), not a bare
  // `patch` call. Going through the dedicated action guarantees that
  // a user who toggles the master off captures a snapshot of the
  // detailed-optimization map and restores it on the next ON. A
  // bare `patch({ turboWasmAccelerationEnabled: false })` would
  // leave the detailed toggles untouched (= UI lie: the master is
  // off but the leaf switches still render as ON).
  const toggleMaster = useSettingsStore((s) => s.toggleTurboWasmMaster);
  return (
    <SettingsSection id="turbowasm" title="TurboWasm">
      <FieldRow
        id="turbo-wasm-acceleration"
        label="TurboWasm Acceleration"
        description="Offload collision detection to a WebAssembly SIMD module. Falls back to the JS path automatically when SIMD is unavailable, when a sprite has a shape-changing visual effect (mosaic, pixelate, whirl, fisheye) active, or when the color-matching path is exercised under a color/brightness effect. When the WASM toggle below is off this master switch is ignored."
      >
        <SwitchField
          id="turbo-wasm-acceleration"
          checked={advanced.turboWasmAccelerationEnabled}
          onChange={(v) => toggleMaster(v)}
          ariaLabel="TurboWasm Acceleration toggle"
        />
      </FieldRow>
      <FieldRow
        id="enable-webgpu"
        label="Enable WebGPU"
        description="Offload @compute regions (marked in a project via the // @compute comment DSL) to WebGPU compute shaders. Falls back to the JS path when WebGPU is unavailable or when a region is unsupported (D1/D2/D3 demote). Independent of the WASM toggle above — turning this off disables the GPU compute kernel pipeline without affecting WASM SIMD collision detection."
      >
        <SwitchField
          id="enable-webgpu"
          checked={advanced.enableWebgpu}
          onChange={(v) => patch({ enableWebgpu: v })}
          ariaLabel="Enable WebGPU toggle"
        />
      </FieldRow>
      <FieldRow
        id="enable-wasm"
        label="Enable WASM"
        description="Install the WASM-SIMD collision-detection hooks on the renderer. Off clears every TurboWasm hook so the runtime behaves identically to unmodified scratch-render (the Definition-of-Done parity mode). On uses WASM SIMD when it has initialised and falls back to the JS path otherwise. Independent of the WebGPU toggle above."
      >
        <SwitchField
          id="enable-wasm"
          checked={enableWasm}
          onChange={(v) => setEnableWasm(v)}
          ariaLabel="Enable WASM toggle"
        />
      </FieldRow>
      {/* §Phase 5 — `Custom Block Inlining` opt-out for the procedure-inliner
          (gpu-kernel-dsl-phase5-spec §5.5). Off re-treats `procedure_call`
          and `argument_reporter_*` as D1-unsafe so any `@compute` region
          that uses them demotes to the JS path. On (default) the
          inliner pre-expands custom blocks so canonical keys collapse
          across call sites. Unlike the WebGPU / WASM toggles this one
          is a power-user escape hatch — `Set as default` preserves the
          current value rather than forcing it on. */}
      <FieldRow
        id="custom-block-inlining"
        label="Custom Block Inlining"
        description="When enabled, GPU compute regions can call custom blocks (pre-parse inline expansion). Disable to treat procedure_call as D1-unsafe so regions that use custom blocks fall back to the JS path instead of the GPU pipeline. Power-user toggle: 'Set as default' preserves the current value rather than forcing it on."
      >
        <SwitchField
          id="custom-block-inlining"
          checked={advanced.customBlockInliningEnabled}
          onChange={(v) => patch({ customBlockInliningEnabled: v })}
          ariaLabel="Custom Block Inlining toggle"
        />
      </FieldRow>
      {/* §Phase 4 BREAKING — the `Nested @compute (Experimental)` toggle
          was retired alongside the v9 nested-parallelization feature.
          The new loose-position DSL (`@compute` on `control_repeat`
          itself, with explicit `@repeat …, repeatPath="…"` directives)
          makes the toggle redundant; the kernel container always
          matches the marker host. */}
      {/*
        Phase 0 — Foundation. Power-user entry point into the detailed
        settings screen. The row renders as a clickable FieldRow that
        delegates navigation to the parent (so the section component
        stays storage-free). Disabled when the master toggle is off so
        a user who turned everything off can't poke toggles that have
        no observable effect anyway — the runtime guard in
        `useSettingsStore.toggleTurboWasmMaster(false)` forces every
        detailed flag to false, so an enabled row would be a UI lie.
      */}
      <ClickableFieldRow
        id="detailed-settings"
        label="Detailed Settings"
        description="Power-user experimental optimization toggles. Disabled when TurboWasm Acceleration is OFF."
        onClick={() => onOpenDetailed?.()}
        disabled={!advanced.turboWasmAccelerationEnabled}
        ariaLabel="Open detailed settings"
        testId="settings-detailed-row"
      />
    </SettingsSection>
  );
});

const OthersSection = React.memo(function OthersSection({
  advanced,
  patch,
}: RuntimeSectionProps): React.JSX.Element {
  const volume = useSettingsStore((s) => s.volume);
  const setVolume = useSettingsStore((s) => s.setVolume);
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
        description="Force the VM to interpret scripts (slower but more compatible). 'Set as default' always re-enables the compiler, so this toggle is session-only."
      >
        <SwitchField
          id="disable-compiler"
          checked={advanced.disableCompiler}
          onChange={(v) => patch({ disableCompiler: v })}
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
  const detailedOptimizations = useSettingsStore((s) => s.detailedOptimizations);
  const setDetailedOptimization = useSettingsStore((s) => s.setDetailedOptimization);
  const onResetClick = React.useCallback(() => resetAdvanced(), [resetAdvanced]);
  const onSetDefaultClick = React.useCallback(() => saveAdvancedAsDefault(), [saveAdvancedAsDefault]);

  // Phase 0 — Foundation. Push/pop navigation state for the detailed
  // settings screen. Reset to the root whenever the dialog re-opens
  // so a user who opened the dialog last week and clicked around
  // doesn't land back on the deep category they were inspecting.
  const [stack, setStack] = React.useState<SettingsViewStack>(() => createInitialStack());
  React.useEffect(() => {
    if (open) setStack(createInitialStack());
  }, [open]);
  const push = React.useCallback(
    (entry: SettingsViewEntry) => setStack((prev) => pushView(prev, entry)),
    [],
  );
  const pop = React.useCallback(() => setStack((prev) => popView(prev)), []);
  const view = currentView(stack);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Layout:
          - Header (title + back button + breadcrumb) pinned to the top.
          - ScrollArea fills the rest of the dialog, holding the
            vertically-stacked SettingsSection blocks separated by
            horizontal rules.
          - Footer (Reset / Set as default) pinned to the bottom.
        Padding on the header / footer is supplied by the section itself;
        the ScrollArea only provides vertical scrolling.
      */}
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-center gap-3 px-8 pb-3 pt-8">
          {canPop(stack) && (
            <Button
              variant="ghost"
              size="icon"
              onClick={pop}
              aria-label="Back"
              data-testid="settings-back"
              style={{ pointerEvents: 'auto' }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          <DialogTitle>Settings</DialogTitle>
          <span
            aria-hidden="true"
            className="ml-auto text-[10px] uppercase tracking-[0.25em] text-muted-foreground"
          >
            {stackToBreadcrumb(stack)}
          </span>
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
            {view.kind === 'section' && (
              <>
                <RuntimeSection advanced={advanced} patch={patch} />
                <RenderingSection advanced={advanced} patch={patch} />
                <LimitsSection advanced={advanced} patch={patch} />
                <TurboWasmSection
                  advanced={advanced}
                  patch={patch}
                  onOpenDetailed={() => push({ kind: 'detailed' })}
                />
                <OthersSection advanced={advanced} patch={patch} />
              </>
            )}
            {view.kind === 'detailed' && (
              <DetailedSettingsScreen
                masterOn={advanced.turboWasmAccelerationEnabled}
                detailed={detailedOptimizations}
                onOpenCategory={(categoryId) =>
                  push({ kind: 'detailed-category', categoryId })
                }
              />
            )}
            {view.kind === 'detailed-category' && (
              <DetailedCategoryScreen
                categoryId={view.categoryId}
                masterOn={advanced.turboWasmAccelerationEnabled}
                detailed={detailedOptimizations}
                onToggle={setDetailedOptimization}
              />
            )}
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

// Re-exported for unit tests and for downstream code that wants to
// drive the navigation stack without going through the dialog (e.g.
// a future command palette). Keep the surface minimal.
export { ClickableFieldRow };
export type { DetailedOptimizationMap } from '@/features/settings/types';
