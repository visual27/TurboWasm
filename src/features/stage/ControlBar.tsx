import * as React from 'react';
import { Maximize2, Minimize2, Pause, Play, Square, Volume2, VolumeX, Settings } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlayerStore } from '@/stores/usePlayerStore';
import { clampVolume } from '@/utils/format';
import { greenFlag, pause, resume, stop } from '@/runtime/player';
import { cn } from '@/lib/utils';

export type ControlBarVariant = 'standalone' | 'overlay';
export type ControlBarPosition = 'full' | 'left' | 'right';

export interface ControlBarProps {
  onOpenSettings: () => void;
  onToggleFullscreen: () => void;
  variant?: ControlBarVariant;
  /**
   * Which section(s) of the bar to render. Default is `'full'` (both halves).
   * Use `'left'` for Play / Pause-Resume / Stop / Volume, and `'right'` for
   * Settings / Fullscreen. Allows the bar to be split across a flex container
   * that is justified to the edges of the stage.
   */
  position?: ControlBarPosition;
}

function ControlBarImpl({
  onOpenSettings,
  onToggleFullscreen,
  variant = 'standalone',
  position = 'full',
}: ControlBarProps): React.JSX.Element {
  const volume = useSettingsStore((s) => s.volume);
  const setVolume = useSettingsStore((s) => s.setVolume);
  const toggleMute = useSettingsStore((s) => s.toggleMute);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isPaused = usePlayerStore((s) => s.isPaused);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);

  const muted = volume === 0;
  const showLeft = position === 'full' || position === 'left';
  const showRight = position === 'full' || position === 'right';

  const onVolumeChange = React.useCallback(
    (values: number[]) => {
      const v = values[0];
      if (typeof v === 'number') setVolume(clampVolume(v));
    },
    [setVolume],
  );

  // Stable array reference for the Radix Slider primitive so it doesn't see
  // a fresh `[volume]` array on every render.
  const volumeArr = React.useMemo(() => [volume], [volume]);

  // Pause / Resume: while paused, the button shows a Play icon and resumes
  // the project; while running, it shows a Pause icon and pauses the project.
  // We use conditional JSX instead of a dynamic component reference so the
  // icon is unambiguously rendered by React.
  const pauseResumeLabel = isPaused ? 'Resume' : 'Pause';
  const onPauseResumeClick = React.useCallback((): void => {
    if (isPaused) resume();
    else pause();
  }, [isPaused]);

  const onGreenFlagClick = React.useCallback(() => greenFlag(), []);
  const onStopClick = React.useCallback(() => stop(), []);
  const onMuteToggle = React.useCallback(() => toggleMute(), [toggleMute]);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-background/70 px-2 py-1 shadow-sm backdrop-blur-md transition-opacity duration-300',
        // Standalone: always fully visible.
        // Overlay (fullscreen): almost invisible by default, fully opaque while
        // the mouse is hovering. We deliberately do NOT use focus-within so
        // the bar fades back down once the cursor leaves — without it, clicking
        // a button would leave focus on that button and pin the bar at full
        // opacity until the user clicked outside it.
        variant === 'standalone' ? 'opacity-100' : 'opacity-25 hover:opacity-95',
      )}
    >
      {showLeft && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Start (green flag)"
                onClick={onGreenFlagClick}
                data-testid="green-flag"
                className="h-8 w-8 rounded-full"
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Start</TooltipContent>
          </Tooltip>

<Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={pauseResumeLabel}
            onClick={onPauseResumeClick}
            disabled={!isPlaying && !isPaused}
            data-testid={isPaused ? 'resume' : 'pause'}
            className="h-8 w-8 rounded-full"
          >
            {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{pauseResumeLabel}</TooltipContent>
      </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Stop"
                onClick={onStopClick}
                data-testid="stop"
                className="h-8 w-8 rounded-full"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop</TooltipContent>
          </Tooltip>

          <span className="mx-1 h-5 w-px bg-border" aria-hidden />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={muted ? 'Unmute' : 'Mute'}
                onClick={onMuteToggle}
                data-testid={muted ? 'unmute' : 'mute'}
                className="h-8 w-8 rounded-full"
              >
                {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{muted ? 'Unmute' : 'Mute'}</TooltipContent>
          </Tooltip>

          <Slider
            value={volumeArr}
            min={0}
            max={100}
            step={1}
            onValueChange={onVolumeChange}
            aria-label="Volume"
            className="w-24"
          />
          <span className="w-7 text-right text-[10px] tabular-nums text-muted-foreground">{volume}</span>
        </>
      )}

      {showLeft && showRight && <span className="mx-1 h-5 w-px bg-border" aria-hidden />}

      {showRight && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Settings"
                onClick={onOpenSettings}
                data-testid="open-settings"
                className="h-8 w-8 rounded-full"
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                onClick={onToggleFullscreen}
                data-testid="toggle-fullscreen"
                className="h-8 w-8 rounded-full"
              >
                {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

/**
 * Memoized control bar. The component subscribes to several store slices and
 * receives callbacks from `App`. Without `React.memo` every parent render
 * (e.g. each `ASSET_PROGRESS` event) would re-render every ControlBar even
 * when none of the relevant slices changed. With `React.memo` and the
 * primitive selectors inside, re-renders are scoped to actual state changes.
 */
export const ControlBar = React.memo(ControlBarImpl);