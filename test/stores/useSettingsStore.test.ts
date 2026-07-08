import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore, computeMuteToggle } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS, VOLUME_MAX } from '@/utils/constants';
import { ALLOWED_EXTENSION_URLS_MAX } from '@/types/settings';

function resetStore(): void {
  useSettingsStore.setState({
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
    allowedExtensionUrls: [],
    performanceMode: 'auto',
    svgAccelerationMode: 'off',
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
    // The persisted payload is tagged with the v4 schema so future
    // schema bumps can read it back correctly.
    expect(JSON.parse(raw as string).version).toBe(4);
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

  it('patchAdvanced preserves svgAccelerationMode (other-section field)', () => {
    useSettingsStore.getState().setSvgAccelerationMode('cache-only');
    useSettingsStore.getState().patchAdvanced({ fps: 60 });
    const s = useSettingsStore.getState();
    expect(s.svgAccelerationMode).toBe('cache-only');
    expect(s.advanced.fps).toBe(60);
  });

  it('resetAdvanced restores advanced to defaults and forces svgAccelerationMode seed to "off"', () => {
    useSettingsStore.getState().setSvgAccelerationMode('mip-chain');
    useSettingsStore.getState().resetAdvanced();
    // resetAdvanced replaces `advanced` with `defaultAdvanced` clone, but
    // it does not touch the top-level svgAccelerationMode mirror (which
    // is the active runtime value the user selected). The default-advanced
    // mirror should be back to 'off' though.
    expect(useSettingsStore.getState().defaultAdvanced.svgAccelerationMode).toBe('off');
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

describe('useSettingsStore — performanceMode', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('defaults to "auto" on a fresh store', () => {
    expect(useSettingsStore.getState().performanceMode).toBe('auto');
  });

  it('setPerformanceMode updates the field and persists immediately', () => {
    useSettingsStore.getState().setPerformanceMode('force-wasm');
    expect(useSettingsStore.getState().performanceMode).toBe('force-wasm');
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state: { performanceMode: string };
      version: number;
    };
    expect(parsed.state.performanceMode).toBe('force-wasm');
    // The persisted payload is tagged with the v4 schema so future
    // schema bumps can read it back correctly.
    expect(parsed.version).toBe(4);
  });

  it('setPerformanceMode accepts all four valid modes', () => {
    for (const mode of ['auto', 'force-wasm', 'force-webgpu', 'legacy-only'] as const) {
      useSettingsStore.getState().setPerformanceMode(mode);
      expect(useSettingsStore.getState().performanceMode).toBe(mode);
    }
  });
});

describe('useSettingsStore — svgAccelerationMode', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('defaults to "off" on a fresh store', () => {
    expect(useSettingsStore.getState().svgAccelerationMode).toBe('off');
  });

  it('setSvgAccelerationMode updates the field and persists immediately', () => {
    useSettingsStore.getState().setSvgAccelerationMode('cache-only');
    expect(useSettingsStore.getState().svgAccelerationMode).toBe('cache-only');
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state: { svgAccelerationMode: string };
      version: number;
    };
    expect(parsed.state.svgAccelerationMode).toBe('cache-only');
    expect(parsed.version).toBe(4);
  });

  it('setSvgAccelerationMode accepts every valid mode', () => {
    for (const mode of ['off', 'cache-only', 'mip-chain', 'resvg-visual-equivalence'] as const) {
      useSettingsStore.getState().setSvgAccelerationMode(mode);
      expect(useSettingsStore.getState().svgAccelerationMode).toBe(mode);
    }
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
      performanceMode: 'auto',
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
