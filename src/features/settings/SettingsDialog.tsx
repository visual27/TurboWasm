import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { useSettingsStore } from '@/stores/useSettingsStore';
import {
  clampFps,
  clampStageHeight,
  clampStageWidth,
  clampVolume,
  formatInteger,
} from '@/utils/format';
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
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
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

function NumberField({ id, value, onChange, min, max, step = 1, ariaLabel }: NumberFieldProps): React.JSX.Element {
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
  return (
    <Switch
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={ariaLabel}
    />
  );
}

interface RuntimeTabProps {
  advanced: AdvancedSettings;
  patch: (patch: Partial<AdvancedSettings>) => void;
}

function RuntimeTab({ advanced, patch }: RuntimeTabProps): React.JSX.Element {
  return (
    <div className="divide-y divide-border">
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
      <FieldRow id="interpolation" label="Interpolation" description="Smooth motion between frames.">
        <SwitchField
          id="interpolation"
          checked={advanced.interpolation}
          onChange={(v) => patch({ interpolation: v })}
        />
      </FieldRow>
      <FieldRow id="warpTimer" label="Warp Timer" description="Run custom blocks without screen refresh.">
        <SwitchField
          id="warpTimer"
          checked={advanced.warpTimer}
          onChange={(v) => patch({ warpTimer: v })}
        />
      </FieldRow>
    </div>
  );
}

function RenderingTab({ advanced, patch }: RuntimeTabProps): React.JSX.Element {
  return (
    <div className="divide-y divide-border">
      <FieldRow id="hq-pen" label="High Quality Pen" description="Smoother pen rendering (slower).">
        <SwitchField
          id="hq-pen"
          checked={advanced.highQualityPen}
          onChange={(v) => patch({ highQualityPen: v })}
        />
      </FieldRow>
    </div>
  );
}

function CompilerTab({ advanced, patch }: RuntimeTabProps): React.JSX.Element {
  return (
    <div className="divide-y divide-border">
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
      <FieldRow id="turbo-mode" label="Turbo Mode" description="Run without framerate limit when supported.">
        <SwitchField
          id="turbo-mode"
          checked={advanced.turboMode}
          onChange={(v) => patch({ turboMode: v })}
        />
      </FieldRow>
    </div>
  );
}

function LimitsTab({ advanced, patch }: RuntimeTabProps): React.JSX.Element {
  return (
    <div className="divide-y divide-border">
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
      <FieldRow id="remove-fencing" label="Remove Fencing" description="Allow sprites to leave the stage.">
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
    </div>
  );
}

function AppearanceTab({
  advanced,
  patch,
}: RuntimeTabProps): React.JSX.Element {
  const volume = useSettingsStore((s) => s.volume);
  const setVolume = useSettingsStore((s) => s.setVolume);
  return (
    <div className="divide-y divide-border">
      <FieldRow id="volume" label="Volume" description="Master audio volume.">
        <div className="flex items-center gap-2">
          <Slider
            value={[volume]}
            min={0}
            max={100}
            step={1}
            onValueChange={(values) => {
              const v = values[0];
              if (typeof v === 'number') setVolume(clampVolume(v));
            }}
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
            onChange={(e) => setVolume(clampVolume(Number(e.target.value)))}
            className="h-9 w-16 text-right tabular-nums"
            aria-label="Volume number"
          />
        </div>
      </FieldRow>
      <FieldRow id="stage-width" label="Stage Width" description="Stage canvas width in pixels.">
        <NumberField
          id="stage-width"
          value={advanced.stageWidth}
          onChange={(v) => patch({ stageWidth: clampStageWidth(v) })}
          min={1}
          max={8192}
          ariaLabel="Stage width"
        />
      </FieldRow>
      <FieldRow id="stage-height" label="Stage Height" description="Stage canvas height in pixels.">
        <NumberField
          id="stage-height"
          value={advanced.stageHeight}
          onChange={(v) => patch({ stageHeight: clampStageHeight(v) })}
          min={1}
          max={8192}
          ariaLabel="Stage height"
        />
      </FieldRow>
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): React.JSX.Element {
  const advanced = useSettingsStore((s) => s.advanced);
  const patch = useSettingsStore((s) => s.patchAdvanced);
  const resetAdvanced = useSettingsStore((s) => s.resetAdvanced);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Changes apply immediately. {formatInteger(Object.keys(advanced).length)} advanced fields.
          </DialogDescription>
        </DialogHeader>
        <Separator />
        <Tabs defaultValue="runtime" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="runtime">Runtime</TabsTrigger>
            <TabsTrigger value="rendering">Rendering</TabsTrigger>
            <TabsTrigger value="compiler">Compiler</TabsTrigger>
            <TabsTrigger value="limits">Limits</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
          </TabsList>
          <TabsContent value="runtime">
            <RuntimeTab advanced={advanced} patch={patch} />
          </TabsContent>
          <TabsContent value="rendering">
            <RenderingTab advanced={advanced} patch={patch} />
          </TabsContent>
          <TabsContent value="compiler">
            <CompilerTab advanced={advanced} patch={patch} />
          </TabsContent>
          <TabsContent value="limits">
            <LimitsTab advanced={advanced} patch={patch} />
          </TabsContent>
          <TabsContent value="appearance">
            <AppearanceTab advanced={advanced} patch={patch} />
          </TabsContent>
        </Tabs>
        <Separator />
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resetAdvanced()}
            aria-label="Reset advanced settings to defaults"
          >
            Reset to defaults
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}