import { STORAGE_KEYS } from '@/utils/constants';
import { useSettingsStore } from '@/stores/useSettingsStore';
import {
  clearSessionDeniedExtensionUrls,
} from '@/runtime/extension-security';

/**
 * Debug-only commands entered in the project-ID input. Each command
 * starts with `!` and performs a maintenance action on the persisted /
 * in-memory settings. These exist so a developer or QA tester can
 * reset state from the UI without opening DevTools, navigating to
 * Application → Local Storage, and manually deleting keys.
 *
 * The prefix is `!` so the commands cannot collide with valid numeric
 * project IDs (which must be 4–20 digits) or any future Scratch /
 * TurboWarp URL we might support — none of those start with `!`.
 *
 * Available commands:
 *
 *  - `!help`                          — list available commands.
 *  - `!reset` / `!reset-settings`     — reset theme + volume + advanced +
 *                                       performance mode + SVG
 *                                       acceleration + extension
 *                                       allow-list + session deny list to
 *                                       defaults.
 *  - `!reset-advanced`                — reset just the advanced settings +
 *                                       extension allow-list +
 *                                       performance mode + SVG
 *                                       acceleration.
 *  - `!reset-performance`             — reset the performance mode
 *                                       to `auto`.
 *  - `!reset-svg`                     — reset the SVG acceleration mode
 *                                       to `off` (Stage 1 baseline).
 *  - `!reset-theme`                   — reset the theme to `system`.
 *  - `!reset-volume`                  — reset the master volume to 100.
 *  - `!clear-extensions` /            — clear the persistent extension
 *      `!clear-allowed-extensions`      allow-list only.
 *  - `!clear-storage`                 — remove the settings key from
 *                                       localStorage. The page still has
 *                                       the in-memory copy; reload to see
 *                                       fresh defaults on next launch.
 *  - `!dump`                          — log the current settings to the
 *                                       browser console.
 */
export const DEBUG_COMMAND_PREFIX = '!';

export function isDebugCommand(input: string): boolean {
  return input.trim().startsWith(DEBUG_COMMAND_PREFIX);
}

interface DebugCommandResult {
  message: string;
  severity: 'info' | 'warn';
}

/**
 * Run a debug command and return the message that should be pushed to
 * the error log. The function never throws — every code path produces
 * a human-readable string so the caller can pass it straight through.
 */
export function executeDebugCommand(rawInput: string): DebugCommandResult {
  const trimmed = rawInput.trim();
  const command = trimmed.slice(DEBUG_COMMAND_PREFIX.length).toLowerCase();

  if (command.length === 0) {
    return {
      severity: 'warn',
      message: 'Empty debug command. Type !help for a list.',
    };
  }

  switch (command) {
    case 'help':
      return { severity: 'info', message: formatHelp() };
    case 'reset':
    case 'reset-settings':
      return { severity: 'info', message: resetAll() };
    case 'reset-advanced':
      useSettingsStore.getState().resetAdvanced();
      useSettingsStore.getState().setPerformanceMode('auto');
      useSettingsStore.getState().setSvgAccelerationMode('off');
      return {
        severity: 'info',
        message: 'Advanced settings + extension allow-list + performance mode + SVG acceleration reset to defaults.',
      };
    case 'reset-performance':
      useSettingsStore.getState().setPerformanceMode('auto');
      return { severity: 'info', message: 'Performance mode reset to auto.' };
    case 'reset-svg':
      useSettingsStore.getState().setSvgAccelerationMode('off');
      return { severity: 'info', message: 'SVG acceleration mode reset to off (Stage 1 baseline).' };
    case 'reset-theme':
      useSettingsStore.getState().setTheme('system');
      return { severity: 'info', message: 'Theme reset to system.' };
    case 'reset-volume':
      useSettingsStore.getState().setVolume(100);
      return { severity: 'info', message: 'Volume reset to 100.' };
    case 'clear-extensions':
    case 'clear-allowed-extensions':
      useSettingsStore.getState().clearAllowedExtensionUrls();
      return { severity: 'info', message: 'Persistent extension allow-list cleared.' };
    case 'clear-storage':
      return { severity: 'info', message: clearLocalStorage() };
    case 'dump':
      dumpSettings();
      return {
        severity: 'info',
        message: 'Current settings dumped to the browser console (open DevTools to view).',
      };
    default:
      return {
        severity: 'warn',
        message: `Unknown debug command: !${command}. Type !help for a list.`,
      };
  }
}

function resetAll(): string {
  const store = useSettingsStore.getState();
  // Theme + volume go through their setters so the changes are
  // persisted immediately. resetAdvanced() also clears the
  // persistent extension allow-list (see useSettingsStore).
  store.setTheme('system');
  store.setVolume(100);
  store.resetAdvanced();
  store.setPerformanceMode('auto');
  store.setSvgAccelerationMode('off');
  // The session-only deny list lives in a module-level Set outside
  // the store, so we clear it directly. This is the only place where
  // the debug command reaches outside the settings store.
  clearSessionDeniedExtensionUrls();
  return 'Reset all settings to defaults (theme, volume, advanced, performance mode, SVG acceleration, extension allow-list, session deny list).';
}

function clearLocalStorage(): string {
  try {
    // Access localStorage through `window` to match the rest of the
    // app (`src/lib/persistence.ts`) and to play nicely with jsdom,
    // where the bare `localStorage` global and `window.localStorage`
    // can be subtly different objects.
    const storage =
      typeof window !== 'undefined' ? window.localStorage : undefined;
    if (!storage) {
      return 'localStorage is not available in this environment.';
    }
    const hadKey = storage.getItem(STORAGE_KEYS.settings) !== null;
    storage.removeItem(STORAGE_KEYS.settings);
    return hadKey
      ? 'Removed settings from localStorage. Reload the page to start with fresh defaults.'
      : 'No settings key found in localStorage. Nothing to remove.';
  } catch (err) {
    return `Could not access localStorage: ${errorMessage(err)}`;
  }
}

function dumpSettings(): void {
  const state = useSettingsStore.getState();
  const payload = {
    theme: state.theme,
    volume: state.volume,
    lastNonMuteVolume: state.lastNonMuteVolume,
    advanced: state.advanced,
    allowedExtensionUrls: state.allowedExtensionUrls,
    performanceMode: state.performanceMode,
    svgAccelerationMode: state.svgAccelerationMode,
  };
  // The DevTools console renders objects with collapsible fields,
  // which is what we want for a multi-line settings dump.
  // eslint-disable-next-line no-console
  console.log('[tw-viewer debug] current settings:', payload);
}

function formatHelp(): string {
  return [
    'Debug commands:',
    '  !reset                 — reset theme, volume, advanced, performance mode, SVG acceleration, extension allow-list, session deny list',
    '  !reset-advanced        — reset advanced settings + extension allow-list + performance mode + SVG acceleration',
    '  !reset-performance     — reset performance mode to auto',
    '  !reset-svg             — reset SVG acceleration mode to off (Stage 1 baseline)',
    '  !reset-theme           — reset theme to system',
    '  !reset-volume          — reset master volume to 100',
    '  !clear-extensions      — clear the persistent extension allow-list',
    '  !clear-storage         — remove the settings key from localStorage',
    '  !dump                  — dump current settings to the browser console',
  ].join('\n');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}
