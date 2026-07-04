import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEBUG_COMMAND_PREFIX,
  executeDebugCommand,
  isDebugCommand,
} from '@/features/project-loader/debug-commands';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { STORAGE_KEYS } from '@/utils/constants';
import {
  __resetSessionDeniedUrlsForTesting,
  addSessionDeniedExtensionUrl,
} from '@/runtime/extension-security';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

function resetStore(): void {
  useSettingsStore.setState({
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    allowedExtensionUrls: [],
  });
}

describe('isDebugCommand', () => {
  it('returns true for inputs prefixed with !', () => {
    expect(isDebugCommand('!help')).toBe(true);
    expect(isDebugCommand('!reset')).toBe(true);
    expect(isDebugCommand('  !reset  ')).toBe(true);
  });

  it('returns false for plain project IDs and URLs', () => {
    expect(isDebugCommand('1197296165')).toBe(false);
    expect(isDebugCommand('https://scratch.mit.edu/projects/1334154904')).toBe(false);
    expect(isDebugCommand('')).toBe(false);
    expect(isDebugCommand('   ')).toBe(false);
  });
});

describe('executeDebugCommand — help and unknown', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    __resetSessionDeniedUrlsForTesting();
  });

  it('!help returns the help text', () => {
    const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}help`);
    expect(result.severity).toBe('info');
    expect(result.message).toMatch(/Debug commands:/);
    expect(result.message).toContain('!reset');
    expect(result.message).toContain('!dump');
  });

  it('unknown commands return a warn with a hint', () => {
    const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}nope`);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('Unknown debug command');
    expect(result.message).toContain('!help');
  });

  it('an empty command (just "!") returns a warn', () => {
    const result = executeDebugCommand(DEBUG_COMMAND_PREFIX);
    expect(result.severity).toBe('warn');
    expect(result.message).toMatch(/Empty debug command/);
  });

  it('command names are case-insensitive', () => {
    const result = executeDebugCommand('!HELP');
    expect(result.message).toMatch(/Debug commands:/);
  });
});

describe('executeDebugCommand — resets', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    __resetSessionDeniedUrlsForTesting();
  });

  it('!reset-theme sets theme back to system', () => {
    useSettingsStore.getState().setTheme('dark');
    expect(useSettingsStore.getState().theme).toBe('dark');
    const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}reset-theme`);
    expect(useSettingsStore.getState().theme).toBe('system');
    expect(result.message).toMatch(/Theme reset/);
  });

  it('!reset-volume sets volume back to 100', () => {
    useSettingsStore.getState().setVolume(0);
    expect(useSettingsStore.getState().volume).toBe(0);
    const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}reset-volume`);
    expect(useSettingsStore.getState().volume).toBe(100);
    expect(result.message).toMatch(/Volume reset/);
  });

  it('!reset-advanced restores advanced defaults and clears the allow-list', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60, infiniteClones: true });
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/x.js');
    expect(useSettingsStore.getState().advanced.fps).toBe(60);
    expect(useSettingsStore.getState().allowedExtensionUrls).toHaveLength(1);
    const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}reset-advanced`);
    expect(useSettingsStore.getState().advanced.fps).toBe(DEFAULT_ADVANCED_SETTINGS.fps);
    expect(useSettingsStore.getState().advanced.infiniteClones).toBe(
      DEFAULT_ADVANCED_SETTINGS.infiniteClones,
    );
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual([]);
    expect(result.message).toMatch(/Advanced settings/);
  });

  it('!reset (alias of !reset-settings) resets everything', () => {
    useSettingsStore.getState().setTheme('dark');
    useSettingsStore.getState().setVolume(0);
    useSettingsStore.getState().patchAdvanced({ fps: 60 });
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js');
    addSessionDeniedExtensionUrl('https://example.com/session-deny.js');
    const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}reset`);
    expect(useSettingsStore.getState().theme).toBe('system');
    expect(useSettingsStore.getState().volume).toBe(100);
    expect(useSettingsStore.getState().advanced.fps).toBe(DEFAULT_ADVANCED_SETTINGS.fps);
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual([]);
    expect(result.message).toMatch(/Reset all settings/);
  });

  it('!clear-extensions clears the allow-list but leaves advanced alone', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60 });
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js');
    expect(useSettingsStore.getState().advanced.fps).toBe(60);
    executeDebugCommand(`${DEBUG_COMMAND_PREFIX}clear-extensions`);
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual([]);
    // fps is unchanged.
    expect(useSettingsStore.getState().advanced.fps).toBe(60);
  });

  it('!clear-allowed-extensions is an alias of !clear-extensions', () => {
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js');
    executeDebugCommand(`${DEBUG_COMMAND_PREFIX}clear-allowed-extensions`);
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual([]);
  });
});

describe('executeDebugCommand — clear-storage', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    __resetSessionDeniedUrlsForTesting();
  });

  it('removes the settings key from localStorage when present', () => {
    localStorage.setItem(STORAGE_KEYS.settings, '{"state":{"theme":"dark"},"version":1}');
    expect(localStorage.getItem(STORAGE_KEYS.settings)).not.toBeNull();
    const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}clear-storage`);
    expect(localStorage.getItem(STORAGE_KEYS.settings)).toBeNull();
    expect(result.message).toMatch(/Removed settings from localStorage/);
    expect(result.message).toMatch(/Reload/);
  });

  it('reports when there is nothing to remove', () => {
    expect(localStorage.getItem(STORAGE_KEYS.settings)).toBeNull();
    const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}clear-storage`);
    expect(result.message).toMatch(/No settings key found/);
  });

  it('does not throw when localStorage access fails', () => {
    // Replace `getItem` on the Storage prototype so any code path
    // that resolves to the jsdom Storage implementation sees the
    // throw. Property assignment on the instance does not always
    // shadow the prototype method in jsdom; using `defineProperty`
    // with `configurable: true` ensures the override takes effect
    // and can be cleanly restored.
    const proto = Object.getPrototypeOf(window.localStorage);
    const original = Object.getOwnPropertyDescriptor(proto, 'getItem');
    Object.defineProperty(proto, 'getItem', {
      configurable: true,
      value: function getItem(): string | null {
        throw new Error('storage disabled');
      },
    });
    try {
      const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}clear-storage`);
      expect(result.message).toMatch(/Could not access localStorage/);
      expect(result.message).toMatch(/storage disabled/);
    } finally {
      if (original) {
        Object.defineProperty(proto, 'getItem', original);
      } else {
        delete (proto as Record<string, unknown>).getItem;
      }
    }
  });
});

describe('executeDebugCommand — dump', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    __resetSessionDeniedUrlsForTesting();
  });

  it('logs a structured object to the console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = executeDebugCommand(`${DEBUG_COMMAND_PREFIX}dump`);
      expect(result.message).toMatch(/dumped to the browser console/);
      expect(spy).toHaveBeenCalledTimes(1);
      const [tag, payload] = spy.mock.calls[0] as [string, Record<string, unknown>];
      expect(tag).toMatch(/tw-viewer debug/);
      expect(payload).toMatchObject({
        theme: 'system',
        volume: 100,
      });
      expect(payload.advanced).toBeDefined();
      expect(payload.allowedExtensionUrls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});