import * as React from 'react';
import { TopBar } from '@/components/layout/TopBar';
import { ErrorLogPanel } from '@/features/error-log/ErrorLogPanel';
import { DropScreen } from '@/features/idle/DropScreen';
import { StageView } from '@/features/stage/StageView';
import { ControlBar } from '@/features/stage/ControlBar';
import { ProjectMetadataPanel } from '@/features/stage/ProjectMetadataPanel';
import { ProjectIdInput } from '@/features/stage/ProjectIdInput';
import { LoadingProgress } from '@/features/stage/LoadingProgress';
import { useProjectStore } from '@/stores/useProjectStore';
import { usePlayerStore } from '@/stores/usePlayerStore';
import { useSettingsStore, flushSettingsPersistForTesting } from '@/stores/useSettingsStore';
import { useProjectLoader } from '@/features/project-loader/useProjectLoader';
import { isAllowedFileName } from '@/lib/validation';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTheme } from '@/hooks/useTheme';
import { useProjectUrlSync } from '@/hooks/useProjectUrlSync';
import { cn } from '@/lib/utils';

// Lazy-load the two dialogs so their bodies (and the Radix primitives they
// pull in) ship as separate chunks and don't bloat the initial bundle.
// fallback={null} is fine because the dialog itself only renders while
// `open` is true — the brief Suspense boundary on first open is invisible.
const SettingsDialog = React.lazy(() =>
  import('@/features/settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })),
);
const CreditsDialog = React.lazy(() =>
  import('@/features/credits/CreditsDialog').then((m) => ({ default: m.CreditsDialog })),
);

export function App(): React.JSX.Element {
  const loadState = useProjectStore((s) => s.loadState);
  const source = useProjectStore((s) => s.source);
  const metadata = useProjectStore((s) => s.metadata);
  const advanced = useSettingsStore((s) => s.advanced);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);

  const { loadFile, loadById } = useProjectLoader();
  const push = useErrorLogStore((s) => s.push);
  useTheme();
  useProjectUrlSync({ loadById });

  const [settingsOpen, setSettingsOpen] = React.useState<boolean>(false);
  const [creditsOpen, setCreditsOpen] = React.useState<boolean>(false);
  // isFullscreen is owned exclusively by the store; we read it directly
  // here so we don't need a separate useState mirror.
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);

  const fsContainerRef = React.useRef<HTMLDivElement>(null);

  // Global drag-and-drop: entire viewport is a drop zone (per §4.1).
  const dragCounter = React.useRef<number>(0);
  const [dragOver, setDragOver] = React.useState<boolean>(false);

  React.useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounter.current += 1;
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragOver(false);
    };
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = async (e: DragEvent): Promise<void> => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file) return;
      if (!isAllowedFileName(file.name)) {
        push('error', `"${file.name}" is not a .sb3 / .sb2 / .sb file.`);
        return;
      }
      await loadFile(file);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [loadFile, push]);

  // Sync DOM fullscreen state with the player store (single source of truth).
  React.useEffect(() => {
    const onChange = (): void => {
      setFullscreen(document.fullscreenElement === fsContainerRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [setFullscreen]);

  // Flush any debounced settings write before the page is hidden so the
  // user's last change (e.g. dragging a volume slider right before closing
  // the tab) is not lost.
  React.useEffect(() => {
    const flush = (): void => flushSettingsPersistForTesting();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  const handleToggleFullscreen = React.useCallback(async (): Promise<void> => {
    const el = fsContainerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Opening the Settings dialog while the document is in fullscreen would
  // render the dialog BEHIND the fullscreen layer (browser top-layer
  // promotion). Exit fullscreen first so the dialog renders normally.
  const handleOpenSettings = React.useCallback(async (): Promise<void> => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* ignore */
      }
    }
    setSettingsOpen(true);
  }, []);

  const isReady = loadState === 'ready';

  return (
    <TooltipProvider delayDuration={250}>
      <div className="relative flex min-h-full flex-col bg-background text-foreground">
        <TopBar onOpenCredits={() => setCreditsOpen(true)} />
        <main className="flex flex-1 flex-col items-center justify-start gap-4 px-6 pt-4 pb-10">
          {/*
            StageView is ALWAYS rendered so initPlayer runs on mount even when
            idle. When idle, StageView itself applies `hidden` so the canvas is
            not visible but the Scaffolding instance remains ready in the DOM,
            making file loads race-free.

            Normal mode: the ControlBar is split into a left half (Play,
            Pause/Resume, Stop, Volume slider) and a right half (Settings,
            Fullscreen), justified to the edges of the stage via flex
            justify-between. Fullscreen mode: the entire ControlBar is
            centered as an overlay at the top of the stage.
          */}
          {!isFullscreen && isReady && (
            <div
              className="flex w-full items-center justify-between"
              style={{ maxWidth: advanced.stageWidth }}
            >
              <ControlBar
                onOpenSettings={() => void handleOpenSettings()}
                onToggleFullscreen={() => void handleToggleFullscreen()}
                position="left"
              />
              <ControlBar
                onOpenSettings={() => void handleOpenSettings()}
                onToggleFullscreen={() => void handleToggleFullscreen()}
                position="right"
              />
            </div>
          )}

          <div
            ref={fsContainerRef}
            data-testid="stage-container"
            className={cn(
              'flex w-full items-center justify-center',
              isFullscreen && 'h-full w-full bg-background',
            )}
          >
            {/* Border wrapper: hugs the stage edges in normal mode and fills
                the entire viewport in fullscreen mode. We deliberately keep
                the corners square (`rounded-none`) so the frame matches a
                Scratch-style stage. overflow-hidden is only applied in normal
                mode so the fullscreen transform-scaled canvas is not clipped
                to its own layout box. */}
            <div
              className={cn(
                'flex items-center justify-center border border-border/40',
                isFullscreen
                  ? 'h-full w-full border-0 overflow-visible'
                  : 'overflow-hidden',
              )}
            >
              <StageView isFullscreen={isFullscreen} />
            </div>
            {isReady && isFullscreen && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
                <div className="pointer-events-auto">
                  <ControlBar
                    onOpenSettings={() => void handleOpenSettings()}
                    onToggleFullscreen={() => void handleToggleFullscreen()}
                    variant="overlay"
                  />
                </div>
              </div>
            )}
            {/*
              Loading progress overlay — covers the stage area (inside the
              border wrapper) whenever a project load is in flight, so the
              user sees a TurboWarp-style "Loading assets… X / Y" indicator
              instead of the old frozen frame. LoadingProgress subscribes
              directly to usePlayerStore.assetProgress so this App does not
              need to re-render on every ASSET_PROGRESS event.
            */}
            {loadState === 'loading' && <LoadingProgress />}
          </div>

          {/*
            DropScreen is only shown when the project is in the 'idle' state.
            It must NOT be shown during 'loading' or 'error' — otherwise
            re-uploading a new file while one is already running causes a
            brief flash of the initial drop screen. During loading, the
            stage view (and the ControlBar / project-id input below it) stay
            visible so the transition is seamless.
          */}
          {loadState === 'idle' && <DropScreen />}
          {/*
            The project-ID input is always available below the stage so that
            a user can queue a new project from anywhere — not only from the
            initial drop screen. The width matches the stage frame so the
            visual line-up is preserved.
          */}
          {loadState !== 'idle' && <ProjectIdInput />}
          {isReady && source === 'id' && metadata && <ProjectMetadataPanel metadata={metadata} />}
        </main>
        <div className="px-6 pb-6">
          <ErrorLogPanel />
        </div>
        {dragOver && (
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-foreground/5 backdrop-blur-sm"
          >
            <span className="rounded-full border border-foreground/30 bg-background/80 px-6 py-3 text-sm font-medium tracking-wide">
              Drop SB3 File
            </span>
          </div>
        )}
        <React.Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
          <CreditsDialog open={creditsOpen} onOpenChange={setCreditsOpen} />
        </React.Suspense>
      </div>
    </TooltipProvider>
  );
}