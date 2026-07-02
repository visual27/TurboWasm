import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseFullscreenReturn {
  isFullscreen: boolean;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  toggle: () => Promise<void>;
  supported: boolean;
}

function fullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null;
  return document.fullscreenElement ?? null;
}

function isFullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.documentElement.requestFullscreen === 'function'
  );
}

export function useFullscreen(targetRef: React.RefObject<HTMLElement>): UseFullscreenReturn {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(() => fullscreenElement() !== null);
  const supportedRef = useRef<boolean>(isFullscreenSupported());

  useEffect(() => {
    const onChange = (): void => setIsFullscreen(fullscreenElement() !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const enter = useCallback(async () => {
    const el = targetRef.current;
    if (!el || !supportedRef.current) return;
    if (fullscreenElement()) return;
    try {
      await el.requestFullscreen();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[fullscreen] enter failed:', err);
    }
  }, [targetRef]);

  const exit = useCallback(async () => {
    if (!supportedRef.current) return;
    if (!fullscreenElement()) return;
    try {
      await document.exitFullscreen();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[fullscreen] exit failed:', err);
    }
  }, []);

  const toggle = useCallback(async () => {
    if (isFullscreen) await exit();
    else await enter();
  }, [enter, exit, isFullscreen]);

  return { isFullscreen, enter, exit, toggle, supported: supportedRef.current };
}