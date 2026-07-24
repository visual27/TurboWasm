import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTheme } from '@/hooks/useTheme';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

function setMatchMedia(dark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? dark : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }),
  });
}

describe('useTheme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark', 'midnight');
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark', 'midnight');
  });

  it('applies the dark class but not midnight when resolved is dark', () => {
    setMatchMedia(true);
    act(() => {
      useSettingsStore.getState().setTheme('dark');
    });
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('midnight')).toBe(false);
  });

  it('applies both dark and midnight when resolved is midnight', () => {
    act(() => {
      useSettingsStore.getState().setTheme('midnight');
    });
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('midnight');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('midnight')).toBe(true);
  });

  it('removes both dark and midnight when resolved is light', () => {
    document.documentElement.classList.add('dark', 'midnight');
    act(() => {
      useSettingsStore.getState().setTheme('light');
    });
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('midnight')).toBe(false);
  });

  it('switches from dark to midnight and back', () => {
    act(() => {
      useSettingsStore.getState().setTheme('dark');
    });
    const { result, rerender } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.classList.contains('midnight')).toBe(false);

    act(() => {
      useSettingsStore.getState().setTheme('midnight');
    });
    rerender();
    expect(result.current.resolved).toBe('midnight');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('midnight')).toBe(true);

    act(() => {
      useSettingsStore.getState().setTheme('dark');
    });
    rerender();
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('midnight')).toBe(false);
  });
});
