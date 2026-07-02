import { beforeEach, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '@/lib/persistence';
import { STORAGE_KEYS, DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

describe('persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when storage empty', () => {
    const settings = readSettings();
    expect(settings).toMatchObject({
      theme: 'system',
      volume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    });
  });

  it('round-trips through storage', () => {
    writeSettings({
      theme: 'dark',
      volume: 42,
      lastNonMuteVolume: 42,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 60, stageWidth: 800 },
    });
    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.volume).toBe(42);
    expect(settings.lastNonMuteVolume).toBe(42);
    expect(settings.advanced.fps).toBe(60);
    expect(settings.advanced.stageWidth).toBe(800);
  });

  it('clamps out-of-range values when reading', () => {
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        state: {
          theme: 'invalid',
          volume: 500,
          advanced: { fps: 9999, stageWidth: -1, stageHeight: NaN },
        },
        version: 1,
      }),
    );
    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.volume).toBe(100);
    expect(settings.advanced.fps).toBe(240);
    expect(settings.advanced.stageWidth).toBe(1);
    expect(settings.advanced.stageHeight).toBeGreaterThanOrEqual(1);
  });

  it('returns defaults when version mismatch', () => {
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({ state: { theme: 'dark', volume: 50, advanced: {} }, version: 99 }),
    );
    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.volume).toBe(100);
  });

  it('returns defaults on malformed JSON', () => {
    localStorage.setItem(STORAGE_KEYS.settings, 'not-json');
    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.volume).toBe(100);
  });
});