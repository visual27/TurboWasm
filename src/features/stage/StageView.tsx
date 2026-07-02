import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlayerStore } from '@/stores/usePlayerStore';
import { useTheme } from '@/hooks/useTheme';
import { applySettings, initPlayer, setVolume, subscribePlayerState } from '@/runtime/player';
import { relayoutScaffolding, setScaffoldingResizeMode } from '@/lib/scaffolding';
import { useProjectStore } from '@/stores/useProjectStore';
import type { AdvancedSettings } from '@/types/settings';
import { cn } from '@/lib/utils';

export interface StageViewProps {
  isFullscreen: boolean;
}

function readWindowSize(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 0, h: 0 };
  return { w: window.innerWidth, h: window.innerHeight };
}

// Cache of the last `advanced` snapshot seen by initPlayer / applySettings.
// We re-read this snapshot from a ref so the mount-effect and the settings
// effect can share a stable reference without re-subscribing on every render.
function useAdvancedRef(): React.MutableRefObject<AdvancedSettings> {
  const advanced = useSettingsStore((s) => s.advanced);
  const ref = useRef<AdvancedSettings>(advanced);
  useEffect(() => {
    ref.current = advanced;
  }, [advanced]);
  return ref;
}

export function StageView({ isFullscreen }: StageViewProps): React.JSX.Element {
  // Subscribe to advanced via a ref so the component does NOT re-render on
  // every advanced patch (e.g. while dragging a slider in Settings). The
  // settings effect below still receives every change via the ref.
  const advancedRef = useAdvancedRef();
  const stageWidth = useSettingsStore((s) => s.advanced.stageWidth);
  const stageHeight = useSettingsStore((s) => s.advanced.stageHeight);
  const volume = useSettingsStore((s) => s.volume);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const setPaused = usePlayerStore((s) => s.setPaused);
  const loadState = useProjectStore((s) => s.loadState);
  const { resolved } = useTheme();

  const fsContainerRef = useRef<HTMLDivElement>(null);
  const stageMountRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef<boolean>(false);
  const previousReadyRef = useRef<boolean>(false);
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
        await initPlayer(stageMountRef.current as HTMLElement, advancedRef.current);
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

  // Apply settings changes (immediate). We subscribe to advanced via a ref
  // so this component doesn't re-render; the ref is updated by the
  // `useAdvancedRef` hook above, and the manual subscription below catches
  // every change.
  useEffect(() => {
    const apply = (): void => {
      if (!initializedRef.current) return;
      try {
        applySettings(advancedRef.current);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[stage] apply settings failed:', err);
      }
    };
    // Subscribe to advanced changes via the store directly. We bypass the
    // hook subscription here so this component does not re-render on
    // advanced patches.
    const unsub = useSettingsStore.subscribe((state, prev) => {
      if (state.advanced !== prev.advanced) apply();
    });
    apply();
    return unsub;
  }, [advancedRef]);

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

  // Single coalesced relayout trigger. Any layout-affecting change
  // (fullscreen, ready, stage-size) schedules at most one double-rAF
  // relayout per frame. This replaces the three independent effects that
  // previously could schedule overlapping relayouts.
  const isReady = loadState === 'ready';
  useEffect(() => {
    setScaffoldingResizeMode('preserve-ratio');
    if (!initializedRef.current) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      relayoutScaffolding();
      raf2 = requestAnimationFrame(() => relayoutScaffolding());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isFullscreen, isReady, stageWidth, stageHeight]);

  // Mark the previous ready state for the ready → not-ready transition check
  // (kept for any future transition that needs to differ from the regular
  // coalesced relayout above).
  useEffect(() => {
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
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

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
  const scale = useMemo(() => {
    if (isFullscreen) {
      return Math.min(
        (windowSize.w || stageWidth) / stageWidth,
        (windowSize.h || stageHeight) / stageHeight,
      );
    }
    return Math.min(
      1,
      (containerSize.w || stageWidth) / stageWidth,
      (containerSize.h || stageHeight) / stageHeight,
    );
  }, [
    isFullscreen,
    windowSize.w,
    windowSize.h,
    containerSize.w,
    containerSize.h,
    stageWidth,
    stageHeight,
  ]);

  const stageBackground = resolved === 'dark' ? '#0a0a0a' : '#ffffff';
  const isHidden = !isReady && !isFullscreen;

  return (
    <div
      ref={fsContainerRef}
      data-testid="stage-container"
      className={cn(
        'relative w-full',
        isFullscreen ? 'h-full w-full' : 'flex justify-center',
        isHidden && 'hidden',
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
            ? { minWidth: stageWidth, minHeight: stageHeight }
            : {
                width: '100%',
                maxWidth: stageWidth,
                aspectRatio: `${stageWidth} / ${stageHeight}`,
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
            width: stageWidth,
            height: stageHeight,
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