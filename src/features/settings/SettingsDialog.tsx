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
import { clampFps, clampStageHeight, clampStageWidth, clampVolume } from '@/utils/format';
import type { AdvancedSettings } from '@/types/settings';
import { Button } from '@/components/ui/button';

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
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel?: string;
}

function NumberField({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  ariaLabel,
}: NumberFieldProps): React.JSX.Element {
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="h-9 w-24 text-right tabular-nums"
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
          onChange={(v) => patch({ fps: clampFps(v) })}
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
            onChange={(v) => patch({ stageWidth: clampStageWidth(v) })}
            min={1}
            max={8192}
            ariaLabel="Stage width"
          />
          <span className="text-xs text-muted-foreground">×</span>
          <NumberField
            id="stage-height"
            value={advanced.stageHeight}
            onChange={(v) => patch({ stageHeight: clampStageHeight(v) })}
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
  const onSliderChange = React.useCallback(
    (values: number[]) => {
      const v = values[0];
      if (typeof v === 'number') setVolume(clampVolume(v));
    },
    [setVolume],
  );
  const onNumberChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setVolume(clampVolume(Number(e.target.value))),
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
          <Input
            id="volume"
            type="number"
            value={volume}
            min={0}
            max={100}
            step={1}
            onChange={onNumberChange}
            className="h-9 w-16 text-right tabular-nums"
            aria-label="Volume number"
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
    </SettingsSection>
  );
});

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): React.JSX.Element {
  const advanced = useSettingsStore((s) => s.advanced);
  const patch = useSettingsStore((s) => s.patchAdvanced);
  const resetAdvanced = useSettingsStore((s) => s.resetAdvanced);
  const onResetClick = React.useCallback(() => resetAdvanced(), [resetAdvanced]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Layout:
          - Header (title) pinned to the top.
          - ScrollArea fills the rest of the dialog, holding the
            vertically-stacked SettingsSection blocks separated by
            horizontal rules.
          - Footer (Reset) pinned to the bottom.
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
        <DialogFooter className="flex-row justify-end px-8 pb-6 pt-4 sm:justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={onResetClick}
            aria-label="Reset advanced settings to defaults"
            data-testid="settings-reset"
          >
            Reset to defaults
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
