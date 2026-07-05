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
    // irrelevant here — writeSettings is mocked.
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
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

  it('patchAdvanced does NOT persist — edits are in-memory until "Set as default"', async () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60 });
    useSettingsStore.getState().patchAdvanced({ fps: 90 });
    useSettingsStore.getState().patchAdvanced({ stageWidth: 640 });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    expect(useSettingsStore.getState().advanced.fps).toBe(90);
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(640);

    // patchAdvanced itself must not have triggered any persist. A previous
    // test might have left a debounced volume write in flight, but the
    // payload here cannot contain the patched fps / stageWidth.
    if (mockedWrite.mock.calls.length > 0) {
      for (const call of mockedWrite.mock.calls) {
        const payload = call[0];
        expect(payload.advanced.fps).toBe(30);
        expect(payload.advanced.stageWidth).toBe(480);
      }
    }
  });

  it('saveAdvancedAsDefault writes synchronously exactly once', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60, stageWidth: 800 });
    // Even after some unrelated setVolume that schedules a debounced write,
    // "Set as default" must take precedence and persist immediately.
    useSettingsStore.getState().setVolume(42);
    useSettingsStore.getState().saveAdvancedAsDefault();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const payload = mockedWrite.mock.calls[0]?.[0];
    expect(payload?.advanced.fps).toBe(60);
    expect(payload?.advanced.stageWidth).toBe(800);
    expect(payload?.defaultAdvanced.fps).toBe(60);
    expect(payload?.defaultAdvanced.stageWidth).toBe(800);
    // Volume from setVolume is in the same payload since the immediate
    // write cancelled the debounced one.
    expect(payload?.volume).toBe(42);
  });

  it('setExtensionSandboxMode writes both runtime advanced and defaultAdvanced', async () => {
    useSettingsStore.getState().setExtensionSandboxMode('iframe');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(mockedWrite).toHaveBeenCalled();
    const last = mockedWrite.mock.calls[mockedWrite.mock.calls.length - 1]?.[0];
    expect(last?.advanced.extensionSandboxMode).toBe('iframe');
    expect(last?.defaultAdvanced.extensionSandboxMode).toBe('iframe');
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

  it('resetAdvanced writes synchronously and uses defaultAdvanced as the baseline', () => {
    useSettingsStore.setState({
      defaultAdvanced: {
        ...DEFAULT_ADVANCED_SETTINGS,
        fps: 75,
        stageWidth: 1024,
      },
    });
    useSettingsStore.getState().resetAdvanced();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const payload = mockedWrite.mock.calls[0]?.[0];
    expect(payload?.advanced.fps).toBe(75);
    expect(payload?.advanced.stageWidth).toBe(1024);
  });
});
