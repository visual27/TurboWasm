import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { Theme } from '@/types/settings';

const QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(QUERY).matches;
}

export type ResolvedTheme = 'dark' | 'light' | 'midnight';

export function useTheme(): { resolved: ResolvedTheme; theme: Theme } {
  const theme = useSettingsStore((s) => s.theme);
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolved: ResolvedTheme =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    html.classList.toggle('dark', resolved !== 'light');
    html.classList.toggle('midnight', resolved === 'midnight');
  }, [resolved]);

  return { resolved, theme };
}
