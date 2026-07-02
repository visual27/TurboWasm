import { describe, expect, it, beforeEach, vi } from 'vitest';
import * as React from 'react';
import { render } from '@testing-library/react';
import { ControlBar } from '@/features/stage/ControlBar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlayerStore } from '@/stores/usePlayerStore';

// Mock the runtime/player module so the buttons' onClick handlers don't
// try to drive a real Scaffolding instance.
vi.mock('@/runtime/player', () => ({
  greenFlag: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  stop: () => undefined,
}));

function wrap(node: React.ReactNode): React.JSX.Element {
  return <TooltipProvider delayDuration={250}>{node}</TooltipProvider>;
}

describe('ControlBar React.memo (Phase 3-1 regression)', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 50,
      lastNonMuteVolume: 50,
      advanced: {
        fps: 30,
        interpolation: false,
        highQualityPen: false,
        warpTimer: false,
        infiniteClones: false,
        removeFencing: false,
        removeMiscLimits: false,
        turboMode: false,
        disableCompiler: false,
        stageWidth: 480,
        stageHeight: 360,
      },
    });
    usePlayerStore.setState({
      isPlaying: false,
      isPaused: false,
      isFullscreen: false,
      assetProgress: { finished: 0, total: 0 },
    });
  });

  it('renders the control bar with all buttons when position="full"', () => {
    const onOpenSettings = (): void => undefined;
    const onToggleFullscreen = (): void => undefined;
    const { container } = render(
      wrap(
        <ControlBar
          onOpenSettings={onOpenSettings}
          onToggleFullscreen={onToggleFullscreen}
          position="full"
        />,
      ),
    );
    expect(container.querySelector('[data-testid="green-flag"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stop"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="open-settings"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="toggle-fullscreen"]')).not.toBeNull();
  });

  it('renders only the left half when position="left"', () => {
    const { container } = render(
      wrap(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          position="left"
        />,
      ),
    );
    expect(container.querySelector('[data-testid="green-flag"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stop"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="open-settings"]')).toBeNull();
    expect(container.querySelector('[data-testid="toggle-fullscreen"]')).toBeNull();
  });

  it('renders only the right half when position="right"', () => {
    const { container } = render(
      wrap(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          position="right"
        />,
      ),
    );
    expect(container.querySelector('[data-testid="green-flag"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-settings"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="toggle-fullscreen"]')).not.toBeNull();
  });

  it('displays the current volume', () => {
    useSettingsStore.setState({ volume: 77 });
    const { container } = render(
      wrap(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          position="full"
        />,
      ),
    );
    expect(container.textContent).toContain('77');
  });

  it('toggleMute flips the mute icon when volume is 0', () => {
    useSettingsStore.setState({ volume: 0, lastNonMuteVolume: 80 });
    const { container } = render(
      wrap(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          position="full"
        />,
      ),
    );
    expect(container.querySelector('[data-testid="unmute"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mute"]')).toBeNull();
  });

  it('toggles the unmute/mute testid when the volume crosses zero', () => {
    const { container, rerender } = render(
      wrap(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          position="full"
        />,
      ),
    );
    expect(container.querySelector('[data-testid="mute"]')).not.toBeNull();
    useSettingsStore.setState({ volume: 0 });
    rerender(
      wrap(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          position="full"
        />,
      ),
    );
    expect(container.querySelector('[data-testid="unmute"]')).not.toBeNull();
  });
});