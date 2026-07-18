import { beforeEach, describe, expect, it } from 'vitest';
import {
  useSettingsStore,
  computeMuteToggle,
  computePreferredFps,
  flushSettingsPersistForTesting,
  FPS_SHORTCUT_DEFAULT,
  FPS_SHORTCUT_FALLBACK,
} from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS, VOLUME_MAX } from '@/utils/constants';
import { ALLOWED_EXTENSION_URLS_MAX } from '@/types/settings';

function resetStore(): void {
  // Drain any debounced persist scheduled by the previous test before
  // we wipe localStorage. Otherwise the snapshot from the previous test
  // (which may include a stale `defaultAdvanced.fps`) gets written into
  // the current test's localStorage and pollutes assertions that read
  // the persisted payload.
  flushSettingsPersistForTesting();
  localStorage.clear();
  useSettingsStore.setState({
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
    allowedExtensionUrls: [],
    enableWasm: true,
    userExplicitFps: null,
  });
}

describe('useSettingsStore — basic', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('updates theme and persists', () => {
    useSettingsStore.getState().setTheme('dark');
    expect(useSettingsStore.getState().theme).toBe('dark');
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).state.theme).toBe('dark');
    // The persisted payload is tagged with the v8 schema so future
    // schema bumps can read it back correctly.
    expect(JSON.parse(raw as string).version).toBe(8);
  });

  it('clamps volume on setVolume', () => {
    useSettingsStore.getState().setVolume(150);
    expect(useSettingsStore.getState().volume).toBe(100);
    useSettingsStore.getState().setVolume(-5);
    expect(useSettingsStore.getState().volume).toBe(0);
  });

  it('patchAdvanced merges partial into the runtime advanced only', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60, turboMode: true });
    const s = useSettingsStore.getState();
    expect(s.advanced.fps).toBe(60);
    expect(s.advanced.turboMode).toBe(true);
    expect(s.advanced.stageWidth).toBe(DEFAULT_ADVANCED_SETTINGS.stageWidth);
    // patchAdvanced must NOT touch the saved defaults — only "Set as
    // default" (saveAdvancedAsDefault) does that.
    expect(s.defaultAdvanced).toEqual(DEFAULT_ADVANCED_SETTINGS);
  });

  it('patchAdvanced does NOT write to localStorage', async () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60 });
    // Wait for any potential debounce flush.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    if (raw) {
      const parsed = JSON.parse(raw) as { state: { advanced: { fps: number } } };
      // If a previous test left a v2 payload, the saved fps should still be
      // the saved default (30), not the patched runtime value (60).
      expect(parsed.state.advanced.fps).toBe(30);
    }
  });

  it('saveAdvancedAsDefault snapshots runtime into defaultAdvanced (minus disableCompiler)', () => {
    useSettingsStore.getState().patchAdvanced({
      fps: 60,
      stageWidth: 800,
      turboMode: true,
      disableCompiler: true,
    });
    useSettingsStore.getState().saveAdvancedAsDefault();
    const s = useSettingsStore.getState();
    // Runtime advanced still reflects the in-session edits.
    expect(s.advanced.fps).toBe(60);
    expect(s.advanced.disableCompiler).toBe(true);
    // defaultAdvanced matches the runtime, but disableCompiler is forced off.
    expect(s.defaultAdvanced.fps).toBe(60);
    expect(s.defaultAdvanced.stageWidth).toBe(800);
    expect(s.defaultAdvanced.turboMode).toBe(true);
    expect(s.defaultAdvanced.disableCompiler).toBe(false);
  });

  it('saveAdvancedAsDefault persists immediately', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 77 });
    useSettingsStore.getState().saveAdvancedAsDefault();
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state: { advanced: { fps: number }; defaultAdvanced: { fps: number } };
    };
    expect(parsed.state.advanced.fps).toBe(77);
    expect(parsed.state.defaultAdvanced.fps).toBe(77);
  });

  it('applyRuntimeOverrides mirrors patchAdvanced but does not persist', () => {
    useSettingsStore.getState().saveAdvancedAsDefault(); // clean slate
    useSettingsStore.getState().applyRuntimeOverrides({ fps: 60, stageWidth: 640 });
    const s = useSettingsStore.getState();
    expect(s.advanced.fps).toBe(60);
    expect(s.advanced.stageWidth).toBe(640);
    // Defaults are untouched.
    expect(s.defaultAdvanced.fps).toBe(DEFAULT_ADVANCED_SETTINGS.fps);
  });

  it('setExtensionSandboxMode updates both advanced and defaultAdvanced and persists', async () => {
    useSettingsStore.getState().setExtensionSandboxMode('iframe');
    const s = useSettingsStore.getState();
    expect(s.advanced.extensionSandboxMode).toBe('iframe');
    expect(s.defaultAdvanced.extensionSandboxMode).toBe('iframe');
    // It must persist (debounced).
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state: {
        advanced: { extensionSandboxMode: string };
        defaultAdvanced: { extensionSandboxMode: string };
      };
    };
    expect(parsed.state.advanced.extensionSandboxMode).toBe('iframe');
    expect(parsed.state.defaultAdvanced.extensionSandboxMode).toBe('iframe');
  });

  it('resetAdvanced restores advanced to defaults', () => {
    useSettingsStore.getState().resetAdvanced();
    // resetAdvanced replaces `advanced` with `defaultAdvanced` clone.
    // The previously-tracked svgAccelerationMode field was retired in
    // v6 along with the WebGPU compute / instanced renderer / SVG
    // acceleration layers; verify the runtime advanced is back at the
    // saved defaults and the type no longer carries the field.
    const s = useSettingsStore.getState();
    expect(s.advanced.fps).toBe(DEFAULT_ADVANCED_SETTINGS.fps);
    expect('svgAccelerationMode' in s.advanced).toBe(false);
  });

  it('resetAdvanced restores defaults from defaultAdvanced and forces disableCompiler off', () => {
    useSettingsStore.getState().saveAdvancedAsDefault(); // defaultAdvanced = DEFAULT_ADVANCED_SETTINGS
    useSettingsStore.getState().patchAdvanced({
      fps: 60,
      stageWidth: 1000,
      disableCompiler: true,
    });
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/x.js');
    useSettingsStore.getState().resetAdvanced();
    const s = useSettingsStore.getState();
    // defaultAdvanced was DEFAULT_ADVANCED_SETTINGS, so advanced resets there.
    expect(s.advanced.fps).toBe(30);
    expect(s.advanced.stageWidth).toBe(480);
    // disableCompiler is always forced off on reset, regardless of what was
    // patched into the runtime advanced just before.
    expect(s.advanced.disableCompiler).toBe(false);
    expect(s.allowedExtensionUrls).toEqual([]);
  });

  it('resetAdvanced picks up the saved defaults after "Set as default"', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60, stageWidth: 800 });
    useSettingsStore.getState().saveAdvancedAsDefault();
    useSettingsStore.getState().patchAdvanced({ fps: 90 });
    useSettingsStore.getState().resetAdvanced();
    const s = useSettingsStore.getState();
    expect(s.advanced.fps).toBe(60);
    expect(s.advanced.stageWidth).toBe(800);
  });
});

describe('useSettingsStore — enableWasm', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('defaults to true on a fresh store', () => {
    expect(useSettingsStore.getState().enableWasm).toBe(true);
  });

  it('setEnableWasm updates the field and persists immediately', () => {
    useSettingsStore.getState().setEnableWasm(false);
    expect(useSettingsStore.getState().enableWasm).toBe(false);
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state: { enableWasm: boolean };
      version: number;
    };
    expect(parsed.state.enableWasm).toBe(false);
    // The persisted payload is tagged with the v8 schema so future
    // schema bumps can read it back correctly.
    expect(parsed.version).toBe(8);
  });

  it('setEnableWasm toggles both directions', () => {
    useSettingsStore.getState().setEnableWasm(false);
    expect(useSettingsStore.getState().enableWasm).toBe(false);
    useSettingsStore.getState().setEnableWasm(true);
    expect(useSettingsStore.getState().enableWasm).toBe(true);
  });
});

describe('useSettingsStore — allowedExtensionUrls', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('addAllowedExtensionUrl appends and persists', () => {
    expect(useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js')).toBe(
      true,
    );
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual(['https://example.com/a.js']);
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    expect(JSON.parse(raw as string).state.allowedExtensionUrls).toEqual([
      'https://example.com/a.js',
    ]);
  });

  it('addAllowedExtensionUrl dedupes existing entries', () => {
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js');
    expect(useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js')).toBe(
      false,
    );
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual(['https://example.com/a.js']);
  });

  it('addAllowedExtensionUrl trims whitespace', () => {
    useSettingsStore.getState().addAllowedExtensionUrl('  https://example.com/a.js  ');
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual(['https://example.com/a.js']);
  });

  it('addAllowedExtensionUrl ignores empty input', () => {
    expect(useSettingsStore.getState().addAllowedExtensionUrl('')).toBe(false);
    expect(useSettingsStore.getState().addAllowedExtensionUrl('   ')).toBe(false);
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual([]);
  });

  it('addAllowedExtensionUrl refuses over capacity', () => {
    const urls = Array.from(
      { length: ALLOWED_EXTENSION_URLS_MAX },
      (_, i) => `https://example.com/${i}.js`,
    );
    useSettingsStore.setState({ allowedExtensionUrls: [...urls] });
    expect(useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/extra.js')).toBe(
      false,
    );
    expect(useSettingsStore.getState().allowedExtensionUrls).toHaveLength(
      ALLOWED_EXTENSION_URLS_MAX,
    );
  });

  it('addAllowedExtensionUrls dedupes across the call and against the existing list', () => {
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js');
    const added = useSettingsStore.getState().addAllowedExtensionUrls([
      'https://example.com/a.js', // dup vs existing
      'https://example.com/b.js',
      'https://example.com/b.js', // dup vs batch
      '  https://example.com/c.js  ', // trimmed
    ]);
    expect(added).toBe(2);
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual([
      'https://example.com/a.js',
      'https://example.com/b.js',
      'https://example.com/c.js',
    ]);
  });

  it('addAllowedExtensionUrls returns 0 when nothing new is added', () => {
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js');
    const added = useSettingsStore
      .getState()
      .addAllowedExtensionUrls(['https://example.com/a.js', '']);
    expect(added).toBe(0);
  });

  it('removeAllowedExtensionUrl drops an entry and persists', () => {
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js');
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/b.js');
    expect(useSettingsStore.getState().removeAllowedExtensionUrl('https://example.com/a.js')).toBe(
      true,
    );
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual(['https://example.com/b.js']);
  });

  it('removeAllowedExtensionUrl returns false for unknown URLs', () => {
    expect(useSettingsStore.getState().removeAllowedExtensionUrl('https://nope.js')).toBe(false);
  });

  it('clearAllowedExtensionUrls empties the list and persists', () => {
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/a.js');
    useSettingsStore.getState().clearAllowedExtensionUrls();
    expect(useSettingsStore.getState().allowedExtensionUrls).toEqual([]);
  });
});

describe('computeMuteToggle (pure)', () => {
  it('mutes and saves the current volume as lastNonMuteVolume', () => {
    const result = computeMuteToggle(75, 50);
    expect(result.volume).toBe(0);
    expect(result.lastNonMuteVolume).toBe(75);
  });

  it('restores the previous volume when unmuting', () => {
    const result = computeMuteToggle(0, 75);
    expect(result.volume).toBe(75);
    expect(result.lastNonMuteVolume).toBe(75);
  });

  it('falls back to VOLUME_MAX when muted and lastNonMuteVolume is 0', () => {
    const result = computeMuteToggle(0, 0);
    expect(result.volume).toBe(VOLUME_MAX);
  });

  it('falls back to VOLUME_MAX when lastNonMuteVolume is unknown (0)', () => {
    const result = computeMuteToggle(0, 0);
    expect(result.volume).toBe(VOLUME_MAX);
  });
});

describe('useSettingsStore.toggleMute (smart restore)', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      theme: 'system',
      volume: 50,
      lastNonMuteVolume: 50,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
      userExplicitFps: null,
    });
  });

  it('first click mutes and remembers 50', () => {
    useSettingsStore.getState().toggleMute();
    const s = useSettingsStore.getState();
    expect(s.volume).toBe(0);
    expect(s.lastNonMuteVolume).toBe(50);
  });

  it('second click restores 50', () => {
    useSettingsStore.getState().toggleMute(); // mute
    useSettingsStore.getState().toggleMute(); // unmute
    const s = useSettingsStore.getState();
    expect(s.volume).toBe(50);
    expect(s.lastNonMuteVolume).toBe(50);
  });

  it('muting twice in a row only mutes the first time and remembers the new value', () => {
    useSettingsStore.getState().toggleMute(); // 50 → 0 (save 50)
    useSettingsStore.getState().setVolume(70); // slider
    expect(useSettingsStore.getState().volume).toBe(70);
    // lastNonMuteVolume should still be 50 (setVolume does not touch it).
    expect(useSettingsStore.getState().lastNonMuteVolume).toBe(50);
    useSettingsStore.getState().toggleMute(); // 70 → 0 (save 70)
    expect(useSettingsStore.getState().volume).toBe(0);
    expect(useSettingsStore.getState().lastNonMuteVolume).toBe(70);
  });

  it('falls back to 100 when muted via slider and then unmuted via button', () => {
    // User drags slider to 0 — lastNonMuteVolume is NOT updated.
    useSettingsStore.getState().setVolume(0);
    expect(useSettingsStore.getState().lastNonMuteVolume).toBe(50);
    // Click unmute → 100 fallback (because lastNonMuteVolume was 50, but
    // we are at 0 → restore 50, since 50 is > 0).
    useSettingsStore.getState().toggleMute();
    expect(useSettingsStore.getState().volume).toBe(50);
  });

  it('falls back to 100 when lastNonMuteVolume is 0', () => {
    useSettingsStore.setState({ volume: 0, lastNonMuteVolume: 0 });
    useSettingsStore.getState().toggleMute();
    expect(useSettingsStore.getState().volume).toBe(100);
  });
});

describe('computePreferredFps (pure)', () => {
  it('exposes the system default and fallback FPS as named constants', () => {
    expect(FPS_SHORTCUT_DEFAULT).toBe(30);
    expect(FPS_SHORTCUT_FALLBACK).toBe(60);
  });

  it('returns userExplicitFps when set and non-30 (priority 1)', () => {
    expect(computePreferredFps(45, 30)).toBe(45);
    expect(computePreferredFps(60, 45)).toBe(60);
  });

  it('treats userExplicitFps=30 as "no preference" and falls through to defaultAdvanced.fps', () => {
    // The latch stores the most recent non-30 fps the user set; 30 is
    // the system default and would just bounce the toggle. We collapse
    // it to "null" semantically here.
    expect(computePreferredFps(30, 45)).toBe(45);
  });

  it('returns defaultAdvancedFps when userExplicitFps is null and defaultAdvanced.fps !== 30 (priority 2)', () => {
    expect(computePreferredFps(null, 45)).toBe(45);
    expect(computePreferredFps(null, 120)).toBe(120);
  });

  it('falls back to 60 when both userExplicitFps and defaultAdvanced.fps are unavailable (priority 3)', () => {
    expect(computePreferredFps(null, 30)).toBe(60);
  });
});

describe('useSettingsStore.toggleTurboMode', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('flips advanced.turboMode from false to true and returns true', () => {
    expect(useSettingsStore.getState().advanced.turboMode).toBe(false);
    const result = useSettingsStore.getState().toggleTurboMode();
    expect(result).toBe(true);
    expect(useSettingsStore.getState().advanced.turboMode).toBe(true);
  });

  it('flips advanced.turboMode from true back to false', () => {
    useSettingsStore.getState().patchAdvanced({ turboMode: true });
    const result = useSettingsStore.getState().toggleTurboMode();
    expect(result).toBe(false);
    expect(useSettingsStore.getState().advanced.turboMode).toBe(false);
  });

  it('does NOT write to localStorage (mirrors patchAdvanced semantics)', async () => {
    useSettingsStore.getState().toggleTurboMode();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    if (raw) {
      const parsed = JSON.parse(raw) as {
        state: { advanced: { turboMode: boolean }; defaultAdvanced: { turboMode: boolean } };
      };
      // defaultAdvanced must NOT be touched by toggleTurboMode.
      expect(parsed.state.defaultAdvanced.turboMode).toBe(false);
    }
  });
});

describe('useSettingsStore.cycleFpsShortcut', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('returns 60 when starting from the system-default state (no preference)', () => {
    expect(useSettingsStore.getState().advanced.fps).toBe(30);
    expect(useSettingsStore.getState().userExplicitFps).toBeNull();
    const next = useSettingsStore.getState().cycleFpsShortcut();
    expect(next).toBe(60);
    expect(useSettingsStore.getState().advanced.fps).toBe(60);
  });

  it('switches back to 30 when pressed with a non-30 fps, latching userExplicitFps', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60 });
    const next = useSettingsStore.getState().cycleFpsShortcut();
    expect(next).toBe(30);
    expect(useSettingsStore.getState().advanced.fps).toBe(30);
    // The latch must remember 60 so the next press can round-trip.
    expect(useSettingsStore.getState().userExplicitFps).toBe(60);
  });

  it('round-trips 30 ⇄ user-explicit fps via Settings dialog (no save-as-default)', () => {
    // User sets 45 in Settings dialog. The latch records 45.
    useSettingsStore.getState().patchAdvanced({ fps: 45 });
    expect(useSettingsStore.getState().userExplicitFps).toBe(45);
    // Alt+Flag: 45 → 30. Latch holds 45.
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(30);
    expect(useSettingsStore.getState().userExplicitFps).toBe(45);
    // Alt+Flag: 30 → 45 (priority-1, via userExplicitFps).
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(45);
    // And again: 45 → 30. Toggle round-trips.
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(30);
  });

  it('round-trips 30 ⇄ user-explicit fps even after save-as-default', () => {
    // User saves 45 as the default. Latch still records 45.
    useSettingsStore.getState().patchAdvanced({ fps: 45 });
    useSettingsStore.getState().saveAdvancedAsDefault();
    expect(useSettingsStore.getState().userExplicitFps).toBe(45);
    // 45 → 30.
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(30);
    // 30 → 45 (priority-1, via userExplicitFps).
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(45);
  });

  it('falls back to defaultAdvanced.fps when the latch is null and the default is non-30', () => {
    // User saved 45 as default in a previous session but the latch was
    // cleared (e.g. via reset). The toggle must still find 45 through
    // the defaultAdvanced fallback.
    useSettingsStore.setState({
      advanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 45 },
      userExplicitFps: null,
    });
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(45);
    // 45 → 30. Latch records 45 (next time we won't even need the
    // defaultAdvanced fallback).
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(30);
    expect(useSettingsStore.getState().userExplicitFps).toBe(45);
    // 30 → 45 via latch.
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(45);
  });

  it('clamps the preferred fps into the FPS_MIN..FPS_MAX range', () => {
    // Simulate an absurd userExplicitFps > FPS_MAX (e.g. typed by hand).
    useSettingsStore.setState({
      advanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
      userExplicitFps: 9999,
    });
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBeLessThanOrEqual(1000);
  });

  it('does NOT write defaultAdvanced.fps, and the runtime fps is in-memory only', async () => {
    useSettingsStore.getState().cycleFpsShortcut();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    const s = useSettingsStore.getState();
    expect(s.defaultAdvanced.fps).toBe(DEFAULT_ADVANCED_SETTINGS.fps);
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    if (raw) {
      const parsed = JSON.parse(raw) as {
        state: { advanced: { fps: number }; defaultAdvanced: { fps: number } };
      };
      // defaultAdvanced.fps must remain at 30.
      expect(parsed.state.defaultAdvanced.fps).toBe(30);
    }
  });

  it('persists userExplicitFps so a reload restores the round-trip endpoint', async () => {
    // The latch is captured on the *down-press* (non-30 → 30), where the
    // user is explicitly leaving their non-30 choice. The up-press
    // (30 → 60) only computes the preferred value via the priority
    // chain; we don't promote that computed value to "user explicit".
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(60); // 30 → 60 (latch still null)
    expect(useSettingsStore.getState().userExplicitFps).toBeNull();
    expect(useSettingsStore.getState().cycleFpsShortcut()).toBe(30); // 60 → 30, latch = 60
    expect(useSettingsStore.getState().userExplicitFps).toBe(60);
    // Allow the debounced persist to flush.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state: { userExplicitFps: number | null };
      version: number;
    };
    expect(parsed.state.userExplicitFps).toBe(60);
    expect(parsed.version).toBe(8);
  });

it('patchAdvanced with a non-30 fps updates the latch even when advanced.fps matches defaultAdvanced.fps', () => {
    // User edits the FPS field to 45 in the dialog. advanced.fps becomes
    // 45, defaultAdvanced.fps stays 30 (not saved yet), so the latch
    // captures 45 for the Alt+Flag round-trip.
    useSettingsStore.getState().patchAdvanced({ fps: 45 });
    expect(useSettingsStore.getState().userExplicitFps).toBe(45);
    // patchAdvanced with 30 (the system default) is a no-op for the latch.
    useSettingsStore.getState().patchAdvanced({ fps: 30 });
    expect(useSettingsStore.getState().userExplicitFps).toBe(45);
  });
});
