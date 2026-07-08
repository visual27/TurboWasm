import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { App } from '@/App';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

vi.mock('@/features/project-loader/ProjectIdInput', () => ({
  ProjectIdInput: () => <div data-testid="project-id-input-stub" />,
}));

vi.mock('@/features/settings/SettingsDialog', () => ({
  SettingsDialog: () => <div data-testid="settings-dialog-stub" />,
}));

vi.mock('@/features/error-log/ErrorLogPanel', () => ({
  ErrorLogPanel: () => <div data-testid="error-log-panel-stub" />,
}));

vi.mock('@/features/project-metadata/ProjectMetadataPanel', () => ({
  ProjectMetadataPanel: () => <div data-testid="project-metadata-stub" />,
}));

vi.mock('@/runtime/player', async () => {
  const actual =
    await vi.importActual<typeof import('@/runtime/player')>('@/runtime/player');
  return {
    ...actual,
    initPlayer: vi.fn().mockResolvedValue(undefined),
    setVolume: vi.fn(),
    subscribePlayerState: vi.fn(() => () => undefined),
    applySettings: vi.fn(),
  };
});

describe('App — stage border wrapper sizing', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
    });
  });

  // Regression: the previous `flex items-center justify-center` wrapper
  // combined with the child StageView's `w-full` produced a circular
  // sizing dependency — the child wanted to be 100% of the wrapper while
  // the wrapper sized to fit the child. On `twconfig` stage-size
  // changes the border stayed pinned at the previous width for one
  // frame, visibly mismatching the freshly-resized stage. Switching to
  // `inline-flex` resolves the dependency because inline-level flex
  // containers size to their content's intrinsic dimensions.

  it('uses inline-flex (not flex) on the border wrapper in normal mode', () => {
    render(<App />);
    const border = document.querySelector(
      'div.inline-flex.items-center.justify-center.border',
    ) as HTMLElement | null;
    expect(border).not.toBeNull();
    // Verify the className is what we expect. jsdom does not resolve
    // Tailwind classes to computed `display` values, so the className
    // check is the actual contract being asserted.
    expect(border?.className).toContain('inline-flex');
    expect(border?.className).toContain('border');
  });

  it('does NOT add `!flex` to the wrapper in normal mode (only in fullscreen)', () => {
    render(<App />);
    const border = document.querySelector(
      'div.inline-flex.items-center.justify-center.border',
    ) as HTMLElement | null;
    expect(border).not.toBeNull();
    expect(border?.className).not.toContain('!flex');
    expect(border?.className).not.toContain('h-full');
    expect(border?.className).not.toContain('w-full');
  });

  it('keeps the border wrapper stable across stage-size changes (no remount)', () => {
    // The original bug also manifested as: a twconfig stage-size change
    // caused the wrapper to briefly hold the old width while the canvas
    // inside it jumped to the new one. With `inline-flex` the wrapper
    // has no width of its own to be stale, so the canvas dimensions
    // drive the border on the same frame. We assert that the wrapper
    // element is not remounted by a settings change.
    const { rerender } = render(<App />);
    const before = document.querySelector(
      'div.inline-flex.items-center.justify-center.border',
    ) as HTMLElement;
    // Simulate a twconfig-style stage-size change: 480x360 -> 640x480.
    useSettingsStore.getState().patchAdvanced({
      stageWidth: 640,
      stageHeight: 480,
    });
    rerender(<App />);
    const after = document.querySelector(
      'div.inline-flex.items-center.justify-center.border',
    ) as HTMLElement;
    // Same DOM node — the wrapper is not torn down and re-mounted on
    // settings change (no `key` prop is set on the wrapper).
    expect(after).toBe(before);
    // Sanity: the store actually picked up the new value.
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(640);
  });
});
