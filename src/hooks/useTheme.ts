import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { Theme } from '@/types/settings';

const QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(QUERY).matches;
}

export function useTheme(): { resolved: 'dark' | 'light'; theme: Theme } {
  const theme = useSettingsStore((s) => s.theme);
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolved: 'dark' | 'light' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (resolved === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [resolved]);

  return { resolved, theme };
}