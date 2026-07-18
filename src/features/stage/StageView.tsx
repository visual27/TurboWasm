import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlayerStore } from '@/stores/usePlayerStore';
import { useTheme } from '@/hooks/useTheme';
import {
  applySettings,
  initPlayer,
  setVolume,
  subscribePlayerState,
  __exposeForBrowserVerify,
} from '@/runtime/player';
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

export function StageView({ isFullscreen }: StageViewProps): React.JSX.Element {
  // We intentionally do NOT subscribe to `advanced` via a hook here — see the
  // settings effect below for the rationale.
  const stageWidth = useSettingsStore((s) => s.advanced.stageWidth);
  const stageHeight = useSettingsStore((s) => s.advanced.stageHeight);
  const highQualityPen = useSettingsStore((s) => s.advanced.highQualityPen);
  const volume = useSettingsStore((s) => s.volume);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const setPaused = usePlayerStore((s) => s.setPaused);
  const loadState = useProjectStore((s) => s.loadState);
  const { resolved } = useTheme();

  // When fullscreen is active AND the user has High Quality Pen enabled, let
  // the Scaffolding's `_root` fill the viewport directly. This makes
  // `Scaffolding.relayout()` (preserve-ratio mode) size the renderer canvas to
  // the viewport-fit dimensions, raising `PenSkin.renderQuality` from `dpr`
  // to `viewportFitW × dpr / nativeSize[0]` so pen stamps render at
  // significantly higher resolution. Matches TurboWarp's fullscreen behavior.
  const useFullscreenPenResize = isFullscreen && highQualityPen;

  const fsContainerRef = useRef<HTMLDivElement>(null);
  const stageMountRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef<boolean>(false);
  const previousReadyRef = useRef<boolean>(false);
  const [containerSize, setLocalContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [windowSize, setWindowSize] = useState<{ w: number; h: number }>(readWindowSize);

  // Init player on mount — canvas mount must always be in DOM so dropping a
  // file never races with init. We read the latest `advanced` snapshot
  // synchronously from the store, so this call is always up to date even
  // if the Settings dialog has been opened since the component first
  // mounted.
  useEffect(() => {
    if (!stageMountRef.current || initializedRef.current) return;
    initializedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        await initPlayer(
          stageMountRef.current as HTMLElement,
          useSettingsStore.getState().advanced,
        );
        if (cancelled) return;
        // Surface the Scaffolding renderer on `window.__turbowasm` so
        // browser smoke tests can introspect the installed TurboWasm
        // hooks (Phase 2 / 3 / 4 wiring). Production code never reads
        // this; it exists for `scripts/verify-browser.mjs`.
        __exposeForBrowserVerify();
      } catch (err) {
        initializedRef.current = false;
        // eslint-disable-next-line no-console
        console.error('[stage] init failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply settings changes. We pass the new snapshot directly into
  // applySettings instead of caching it through a ref: zustand's subscribe
  // fires synchronously inside `patchAdvanced`, which runs *before* any
  // React `useEffect` that mirrors the store into a ref. A ref-based
  // approach (the previous `useAdvancedRef` design) therefore re-applied
  // the prior advanced snapshot for one tick, dropping stage-size changes
  // and corrupting fps (mid-edit partials like `clampFps(0) = 1` would
  // win because the committed value never reached applySettings in time).
  // Subscribing with the live `state.advanced` lets us deliver the exact
  // patch the caller just wrote.
  useEffect(() => {
    const apply = (
      next: AdvancedSettings,
      enableWasm: boolean,
      prevEnableWasm: boolean,
    ): void => {
      if (!initializedRef.current) return;
      try {
        applySettings(next, enableWasm, prevEnableWasm);
        // Re-publish the diagnostic accessor after every settings change
        // so a browser-verifier observing `window.__turbowasm` sees the
        // post-apply hooks (Phase 2/3/4 hook reattachment path).
        __exposeForBrowserVerify();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[stage] apply settings failed:', err);
      }
    };
    const unsub = useSettingsStore.subscribe((state, prev) => {
      if (state.advanced !== prev.advanced || state.enableWasm !== prev.enableWasm) {
        // eslint-disable-next-line no-console
        console.log(
          `[tw-stage-size] StageView store subscribe: prev=${prev.advanced.stageWidth}x${prev.advanced.stageHeight} next=${state.advanced.stageWidth}x${state.advanced.stageHeight} enableWasmSame=${state.enableWasm === prev.enableWasm}`,
        );
        apply(state.advanced, state.enableWasm, prev.enableWasm);
      }
    });
    const initial = useSettingsStore.getState();
    apply(initial.advanced, initial.enableWasm, initial.enableWasm);
    return unsub;
  }, []);

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
  // (fullscreen, ready, stage-size, high-quality-pen) schedules at most one
  // triple-rAF relayout per frame. Three rAFs are required so the
  // browser has a chance to (1) commit the new `aspectRatio` CSS on
  // the inner ref, (2) reflow the stage-mount, and (3) settle the
  // Scaffolding `_root` size before we ask it to relayout. Two rAFs
  // is occasionally too tight: a 2nd project load that switches the
  // aspect ratio (e.g. twconfig 480x270 after a 800x600 first load)
  // would land the Scaffolding on a stale `_root` size and persist
  // the wrong GL canvas drawing buffer / `_overlays` transform
  // until the user reloaded the page. `highQualityPen` is in the deps
  // so that toggling it while in fullscreen flips the layout box
  // between 100%/100% and stageWidth/stageHeight and forces a canvas
  // resize.
  const isReady = loadState === 'ready';
  useEffect(() => {
    setScaffoldingResizeMode('preserve-ratio');
    if (!initializedRef.current) return;
    // eslint-disable-next-line no-console
    console.log(
      `[tw-stage-size] StageView relayout effect triggered: stageWidth/Height=${stageWidth}x${stageHeight} isFullscreen=${isFullscreen} isReady=${isReady} highQualityPen=${highQualityPen}`,
    );
    let raf2 = 0;
    let raf3 = 0;
    const raf1 = requestAnimationFrame(() => {
      // eslint-disable-next-line no-console
      console.log('[tw-stage-size] StageView rAF1 relayout');
      relayoutScaffolding();
      raf2 = requestAnimationFrame(() => {
        // eslint-disable-next-line no-console
        console.log('[tw-stage-size] StageView rAF2 relayout');
        relayoutScaffolding();
        raf3 = requestAnimationFrame(() => {
          // eslint-disable-next-line no-console
          console.log('[tw-stage-size] StageView rAF3 relayout');
          relayoutScaffolding();
        });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      cancelAnimationFrame(raf3);
    };
  }, [isFullscreen, isReady, stageWidth, stageHeight, highQualityPen]);

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
  // - Fullscreen + HQ-pen-off: scale up to fill the entire viewport while
  //   keeping the project's aspect ratio. The Scaffolding canvas stays at
  //   stageWidth × stageHeight CSS pixels and is enlarged via CSS transform.
  // - Fullscreen + HQ-pen-on: the Scaffolding canvas is resized to the
  //   viewport-fit dimensions directly, so no CSS transform is applied
  //   here (the `useFullscreenPenResize` branch in the render omits the
  //   `transform` inline style entirely).
  const scale = useMemo(() => {
    if (useFullscreenPenResize) {
      return 1;
    }
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
    useFullscreenPenResize,
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
        Stable DOM structure — only inline styles change between the three
        layout modes. Swapping element hierarchies caused the "stage
        disappears" bug during fullscreen transitions, so we keep the same
        skeleton everywhere and branch on inline styles instead.

        Normal: innerRef sizes to stageWidth × aspectRatio, layout box is
        stageWidth × stageHeight, transform: scale(≤1) (no visual scale).
        Fullscreen + HQ pen OFF: innerRef fills the viewport with flex
        centering, layout box stays at stageWidth × stageHeight and is
        upscaled by transform: scale(>1) to fill the viewport visually.
        Fullscreen + HQ pen ON: innerRef fills the viewport, layout box
        itself is 100% × 100% (no transform). The Scaffolding's natural
        preserve-ratio relayout then sizes the renderer canvas to the
        viewport-fit dimensions and PenSkin.renderQuality rises to
        viewportFitW × dpr / nativeSize[0].
      */}
      <div
        ref={innerRef}
        className={cn(
          'relative',
          isFullscreen ? 'flex h-full w-full items-center justify-center' : 'flex justify-center',
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
          style={useFullscreenPenResize
            ? {
                // Layout box fills innerRef (= viewport in fullscreen). The
                // Scaffolding's `_root` then inherits this size, so its
                // preserve-ratio `relayout()` computes the viewport-fit
                // canvas dimensions and `PenSkin.renderQuality` is bumped
                // to a multi-dpr multiple of `nativeSize[0]`.
                width: '100%',
                height: '100%',
              }
            : {
                // Layout box stays at stageWidth × stageHeight CSS pixels
                // and is enlarged by a CSS transform in fullscreen. No
                // transform is needed in normal mode (scale clamps to 1).
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
