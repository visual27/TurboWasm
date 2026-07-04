import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useSettingsStore, flushSettingsPersistForTesting } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';
import { writeSettings } from '@/lib/persistence';

// Mock @/lib/persistence so we can observe calls without dealing with
// SafeStorage's cached reference to the real localStorage instance.
vi.mock('@/lib/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/lib/persistence')>('@/lib/persistence');
  return {
    ...actual,
    writeSettings: vi.fn(),
  };
});

const mockedWrite = vi.mocked(writeSettings);

describe('useSettingsStore persist debouncing (Phase 3-6 regression)', () => {
  beforeEach(() => {
    mockedWrite.mockClear();
    mockedWrite.mockImplementation(() => undefined);
    // Reset the store to a known state. The actual localStorage state is
    // irrelevant here 窶・writeSettings is mocked.
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    });
  });

  afterEach(() => {
    flushSettingsPersistForTesting();
  });

  it('setVolume schedules a debounced write (latest snapshot wins)', async () => {
    useSettingsStore.getState().setVolume(10);
    useSettingsStore.getState().setVolume(20);
    useSettingsStore.getState().setVolume(30);

    // The store value reflects the latest write immediately.
    expect(useSettingsStore.getState().volume).toBe(30);

    // Wait for the microtask + idle/setTimeout flush.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    // At least one write must have happened and the final payload must be
    // the latest snapshot.
    expect(mockedWrite).toHaveBeenCalled();
    const last = mockedWrite.mock.calls[mockedWrite.mock.calls.length - 1]?.[0];
    expect(last?.volume).toBe(30);
  });

  it('patchAdvanced debounces and persists the merged advanced settings', async () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60 });
    useSettingsStore.getState().patchAdvanced({ fps: 90 });
    useSettingsStore.getState().patchAdvanced({ stageWidth: 640 });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    expect(useSettingsStore.getState().advanced.fps).toBe(90);
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(640);

    expect(mockedWrite).toHaveBeenCalled();
    const last = mockedWrite.mock.calls[mockedWrite.mock.calls.length - 1]?.[0];
    expect(last?.advanced.fps).toBe(90);
    expect(last?.advanced.stageWidth).toBe(640);
  });

  it('flushSettingsPersistForTesting writes any pending snapshot synchronously', () => {
    useSettingsStore.getState().setVolume(42);
    // Don't await timers; flush synchronously.
    flushSettingsPersistForTesting();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite.mock.calls[0]?.[0]?.volume).toBe(42);
  });

  it('setTheme writes synchronously (no debounce)', () => {
    useSettingsStore.getState().setTheme('dark');
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite.mock.calls[0]?.[0]?.theme).toBe('dark');
  });

  it('resetAdvanced writes synchronously', () => {
    useSettingsStore.getState().resetAdvanced();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite.mock.calls[0]?.[0]?.advanced.fps).toBe(30);
  });
});
