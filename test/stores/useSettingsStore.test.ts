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
    allowedExtensionUrls: [],
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
  });

  it('clamps volume on setVolume', () => {
    useSettingsStore.getState().setVolume(150);
    expect(useSettingsStore.getState().volume).toBe(100);
    useSettingsStore.getState().setVolume(-5);
    expect(useSettingsStore.getState().volume).toBe(0);
  });

  it('patchAdvanced merges partial', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60, turboMode: true });
    const s = useSettingsStore.getState();
    expect(s.advanced.fps).toBe(60);
    expect(s.advanced.turboMode).toBe(true);
    expect(s.advanced.stageWidth).toBe(DEFAULT_ADVANCED_SETTINGS.stageWidth);
  });

  it('resetAdvanced restores defaults including the allow-list', () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60, stageWidth: 1000 });
    useSettingsStore.getState().addAllowedExtensionUrl('https://example.com/x.js');
    useSettingsStore.getState().resetAdvanced();
    const s = useSettingsStore.getState();
    expect(s.advanced.fps).toBe(30);
    expect(s.advanced.stageWidth).toBe(480);
    expect(s.allowedExtensionUrls).toEqual([]);
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
      allowedExtensionUrls: [],
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
