import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlayerStore } from '@/stores/usePlayerStore';
import { useTheme } from '@/hooks/useTheme';
import { applySettings, initPlayer, setVolume, subscribePlayerState } from '@/runtime/player';
import { relayoutScaffolding, setScaffoldingResizeMode } from '@/lib/scaffolding';
import { useProjectStore } from '@/stores/useProjectStore';
import { cn } from '@/lib/utils';

export interface StageViewProps {
  isFullscreen: boolean;
}

function readWindowSize(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 0, h: 0 };
  return { w: window.innerWidth, h: window.innerHeight };
}

export function StageView({ isFullscreen }: StageViewProps): React.JSX.Element {
  const advanced = useSettingsStore((s) => s.advanced);
  const volume = useSettingsStore((s) => s.volume);
  const setStageScale = usePlayerStore((s) => s.setStageScale);
  const setContainerSize = usePlayerStore((s) => s.setContainerSize);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const setPaused = usePlayerStore((s) => s.setPaused);
  const loadState = useProjectStore((s) => s.loadState);
  const { resolved } = useTheme();

  const fsContainerRef = useRef<HTMLDivElement>(null);
  const stageMountRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef<boolean>(false);
  const previousReadyRef = useRef<boolean>(false);
  const previousFullscreenRef = useRef<boolean>(false);
  const [containerSize, setLocalContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [windowSize, setWindowSize] = useState<{ w: number; h: number }>(readWindowSize);

  // Init player on mount — canvas mount must always be in DOM so dropping a
  // file never races with init.
  useEffect(() => {
    if (!stageMountRef.current || initializedRef.current) return;
    initializedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        await initPlayer(stageMountRef.current as HTMLElement, advanced);
        if (cancelled) return;
      } catch (err) {
        initializedRef.current = false;
        // eslint-disable-next-line no-console
        console.error('[stage] init failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply settings changes (immediate)
  useEffect(() => {
    if (!initializedRef.current) return;
    try {
      applySettings(advanced);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[stage] apply settings failed:', err);
    }
  }, [advanced]);

  // Apply volume
  useEffect(() => {
    if (!initializedRef.current) return;
    try {
      setVolume(volume);
    } catch {
      /* ignore */
    }
  }, [volume]);

  // Subscribe to player events
  useEffect(() => {
    const unsub = subscribePlayerState((s) => {
      setPlaying(s.isPlaying);
      setPaused(s.isPaused);
    });
    return unsub;
  }, [setPlaying, setPaused]);

  // Switch Scaffolding resize mode. We always keep `preserve-ratio` so the
  // underlying canvas preserves the project's aspect ratio. In fullscreen we
  // additionally scale the displayed frame via CSS transform to fill the
  // viewport — the renderer itself is NOT resized, which avoids the
  // "stage disappears" bug and keeps gameplay coordinates consistent.
  useEffect(() => {
    setScaffoldingResizeMode('preserve-ratio');
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      relayoutScaffolding();
      raf2 = requestAnimationFrame(() => relayoutScaffolding());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isFullscreen]);

  // When transitioning from idle → ready, force a relayout so the canvas
  // resizes correctly (the container was display:none during idle, which
  // meant Scaffolding computed dimensions as 0).
  const isReady = loadState === 'ready';
  useEffect(() => {
    if (isReady && !previousReadyRef.current && initializedRef.current) {
      requestAnimationFrame(() => relayoutScaffolding());
    }
    previousReadyRef.current = isReady;
  }, [isReady]);

  // Observe inner container size for scale-to-fit (only used in normal mode)
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setLocalContainerSize({ w: width, h: height });
      setContainerSize({ width, height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [setContainerSize]);

  // Trigger a relayout whenever fullscreen state toggles (covers Escape exit).
  useEffect(() => {
    if (previousFullscreenRef.current !== isFullscreen && initializedRef.current) {
      requestAnimationFrame(() => relayoutScaffolding());
    }
    previousFullscreenRef.current = isFullscreen;
  }, [isFullscreen]);

  // In fullscreen mode the displayed frame must scale to the actual viewport
  // size, not to the (unscaled) layout box of the inner container. Without
  // this listener, rotating the device or resizing the OS window while
  // fullscreen would leave the stage at the wrong scale.
  useEffect(() => {
    if (!isFullscreen) return;
    setWindowSize(readWindowSize());
    const onResize = (): void => setWindowSize(readWindowSize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isFullscreen]);

  // Compute scale to fit (preserve aspect ratio).
  // - Normal mode: scale down to fit the available container, never up.
  // - Fullscreen mode: scale up to fill the entire viewport while keeping
  //   the project's aspect ratio. The underlying Scaffolding canvas is NOT
  //   resized — only the displayed frame is enlarged via CSS transform.
  const scale = isFullscreen
    ? Math.min(
        (windowSize.w || advanced.stageWidth) / advanced.stageWidth,
        (windowSize.h || advanced.stageHeight) / advanced.stageHeight,
      )
    : Math.min(
        1,
        (containerSize.w || advanced.stageWidth) / advanced.stageWidth,
        (containerSize.h || advanced.stageHeight) / advanced.stageHeight,
      );
  useEffect(() => {
    setStageScale(scale);
  }, [scale, setStageScale]);

  const stageBackground = resolved === 'dark' ? '#0a0a0a' : '#ffffff';

  return (
    <div
      ref={fsContainerRef}
      data-testid="stage-container"
      className={cn(
        'relative w-full',
        isFullscreen ? 'h-full w-full' : 'flex justify-center',
        !isReady && !isFullscreen && 'hidden',
      )}
    >
      {/*
        Stable DOM structure — only inline styles change between normal and
        fullscreen. This avoids the "stage disappears" bug caused by swapping
        element hierarchies during a fullscreen transition.

        Fullscreen: innerRef fills the entire viewport with flex centering so
        that the transform-scaled canvas (whose CSS layout box stays at
        stageWidth × stageHeight) is centered, and the visual content can
        extend beyond the layout box without being clipped.

        Normal: innerRef sizes to the configured stage width and aspect ratio,
        and the canvas is centered inside.
      */}
      <div
        ref={innerRef}
        className={cn(
          'relative',
          isFullscreen
            ? 'flex h-full w-full items-center justify-center'
            : 'flex justify-center',
        )}
        style={
          isFullscreen
            ? { minWidth: advanced.stageWidth, minHeight: advanced.stageHeight }
            : {
                width: '100%',
                maxWidth: advanced.stageWidth,
                aspectRatio: `${advanced.stageWidth} / ${advanced.stageHeight}`,
              }
        }
      >
        <div
          className="relative shrink-0"
          style={{
            // In both modes, the Scaffolding canvas mount stays at its native
            // (stageWidth × stageHeight) size. The transform enlarges the
            // displayed frame to fill the available space while preserving
            // the project's aspect ratio.
            width: advanced.stageWidth,
            height: advanced.stageHeight,
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
          }}
        >
          <div
            ref={stageMountRef}
            data-testid="stage-mount"
            className={cn('absolute inset-0 overflow-hidden', !isReady && 'hidden')}
            style={{
              backgroundColor: stageBackground,
              width: '100%',
              height: '100%',
            }}
          />
        </div>
      </div>
    </div>
  );
}