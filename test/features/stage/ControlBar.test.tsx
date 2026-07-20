import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ControlBar } from '@/features/stage/ControlBar';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlayerStore } from '@/stores/usePlayerStore';
import { TooltipProvider } from '@/components/ui/tooltip';

function renderWithProviders(ui: React.ReactNode) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

const playerMocks = {
  play: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  greenFlag: vi.fn(),
};

vi.mock('@/runtime/player', async () => {
  const actual = await vi.importActual<typeof import('@/runtime/player')>('@/runtime/player');
  return {
    ...actual,
    play: () => playerMocks.play(),
    pause: () => playerMocks.pause(),
    resume: () => playerMocks.resume(),
    stop: () => playerMocks.stop(),
    greenFlag: () => playerMocks.greenFlag(),
  };
});

describe('ControlBar', () => {
  beforeEach(() => {
    Object.values(playerMocks).forEach((m) => m.mockClear());
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    });
    usePlayerStore.setState({
      isPlaying: false,
      isPaused: false,
      isFullscreen: false,
    });
  });

  describe('pause / resume icon rendering', () => {
    it('pause button renders an SVG icon when running', () => {
      usePlayerStore.setState({ isPlaying: true, isPaused: false });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const btn = screen.getByTestId('pause');
      const svg = btn.querySelector('svg');
      expect(svg).not.toBeNull();
    });

    it('resume button renders an SVG icon when paused', () => {
      usePlayerStore.setState({ isPlaying: false, isPaused: true });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const btn = screen.getByTestId('resume');
      const svg = btn.querySelector('svg');
      expect(svg).not.toBeNull();
    });

    it('pause/resume button always renders an icon (even when disabled)', () => {
      usePlayerStore.setState({ isPlaying: false, isPaused: false });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const btn = screen.getByTestId('pause');
      expect(btn.querySelector('svg')).not.toBeNull();
    });

    it('clicking pause invokes pause(); clicking resume invokes resume()', () => {
      usePlayerStore.setState({ isPlaying: true, isPaused: false });
      const { rerender } = render(
        <TooltipProvider delayDuration={0}>
          <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />
        </TooltipProvider>,
      );
      fireEvent.click(screen.getByTestId('pause'));
      expect(playerMocks.pause).toHaveBeenCalledTimes(1);

      usePlayerStore.setState({ isPlaying: false, isPaused: true });
      rerender(
        <TooltipProvider delayDuration={0}>
          <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />
        </TooltipProvider>,
      );
      fireEvent.click(screen.getByTestId('resume'));
      expect(playerMocks.resume).toHaveBeenCalledTimes(1);
    });
  });

  describe('full position (default)', () => {
    it('renders all expected buttons', () => {
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      expect(screen.getByTestId('green-flag')).toBeInTheDocument();
      expect(screen.getByLabelText(/Volume/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Settings/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Enter fullscreen/i)).toBeInTheDocument();
    });

    it('clicking the green flag invokes greenFlag()', () => {
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      fireEvent.click(screen.getByTestId('green-flag'));
      expect(playerMocks.greenFlag).toHaveBeenCalledTimes(1);
    });

    it('clicking Stop invokes stop()', () => {
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      fireEvent.click(screen.getByTestId('stop'));
      expect(playerMocks.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('pause / resume button', () => {
    it('shows a Pause button (aria-label) when running, calls pause() on click', () => {
      usePlayerStore.setState({ isPlaying: true, isPaused: false });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const btn = screen.getByTestId('pause');
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(playerMocks.pause).toHaveBeenCalledTimes(1);
      expect(playerMocks.resume).not.toHaveBeenCalled();
    });

    it('shows a Resume button (aria-label) when paused, calls resume() on click', () => {
      usePlayerStore.setState({ isPlaying: false, isPaused: true });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const btn = screen.getByTestId('resume');
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(playerMocks.resume).toHaveBeenCalledTimes(1);
      expect(playerMocks.pause).not.toHaveBeenCalled();
    });

    it('pause button is disabled when neither playing nor paused', () => {
      usePlayerStore.setState({ isPlaying: false, isPaused: false });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const btn = screen.getByTestId('pause');
      expect(btn).toBeDisabled();
    });
  });

  describe('position split (left / right)', () => {
    it('left position renders playback + volume, hides settings/fullscreen', () => {
      renderWithProviders(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          position="left"
        />,
      );
      expect(screen.getByTestId('green-flag')).toBeInTheDocument();
      expect(screen.getByLabelText(/Volume/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/Settings/i)).toBeNull();
      expect(screen.queryByLabelText(/Enter fullscreen/i)).toBeNull();
    });

    it('right position renders settings + fullscreen, hides playback + volume', () => {
      renderWithProviders(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          position="right"
        />,
      );
      expect(screen.queryByTestId('green-flag')).toBeNull();
      expect(screen.queryByLabelText(/Volume/i)).toBeNull();
      expect(screen.getByLabelText(/Settings/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Enter fullscreen/i)).toBeInTheDocument();
    });
  });

  describe('overlay variant styling', () => {
    it('applies opacity auto-hide + hover reveal classes', () => {
      const { container } = renderWithProviders(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          variant="overlay"
        />,
      );
      const wrap = container.firstElementChild as HTMLElement | null;
      expect(wrap).not.toBeNull();
      expect(wrap?.className).toMatch(/opacity/);
      expect(wrap?.className).toMatch(/hover:opacity/);
    });

    it('does NOT apply focus-within (so the bar fades after click)', () => {
      const { container } = renderWithProviders(
        <ControlBar
          onOpenSettings={() => undefined}
          onToggleFullscreen={() => undefined}
          variant="overlay"
        />,
      );
      const wrap = container.firstElementChild as HTMLElement | null;
      expect(wrap?.className).not.toMatch(/focus-within:opacity/);
    });

    it('standalone variant does not apply the auto-hide opacity class', () => {
      const { container } = renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const wrap = container.firstElementChild as HTMLElement | null;
      expect(wrap?.className).not.toMatch(/opacity-25/);
      expect(wrap?.className).toMatch(/opacity-100/);
    });
  });

  describe('mute / unmute button (smart restore)', () => {
    it('clicking the mute button when audible invokes toggleMute and the icon flips to VolumeX', () => {
      useSettingsStore.setState({ volume: 50, lastNonMuteVolume: 50 });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const btn = screen.getByTestId('mute');
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(useSettingsStore.getState().volume).toBe(0);
      expect(useSettingsStore.getState().lastNonMuteVolume).toBe(50);
    });

    it('clicking the unmute button restores the previous volume', () => {
      useSettingsStore.setState({ volume: 0, lastNonMuteVolume: 75 });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      const btn = screen.getByTestId('unmute');
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(useSettingsStore.getState().volume).toBe(75);
    });

    it('clicking unmute when lastNonMuteVolume is 0 falls back to 100', () => {
      useSettingsStore.setState({ volume: 0, lastNonMuteVolume: 0 });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      fireEvent.click(screen.getByTestId('unmute'));
      expect(useSettingsStore.getState().volume).toBe(100);
    });
  });

  describe('mousedown does not steal focus from the document', () => {
    // The vendored Scaffolding keydown handler in
    // `vendored/scaffolding/src/scaffolding.js` `_onkeydown` only forwards a
    // key event to the VM when `e.target === document || e.target ===
    // document.body`. If clicking a ControlBar button leaves focus on the
    // <button>, every subsequent keystroke silently fails to reach the
    // stage. To prevent that we suppress the focus shift via
    // `e.preventDefault()` on `mousedown` for every icon button. The test
    // pins that contract: any future regression that re-introduces focus on
    // click will fail here.
    const interactiveTestIds = [
      'green-flag',
      'stop',
      'pause',
      'mute',
      'open-settings',
      'toggle-fullscreen',
    ] as const;

    interactiveTestIds.forEach((testId) => {
      it(`calls preventDefault() on mousedown for the ${testId} button so it does not steal focus`, () => {
        useSettingsStore.setState({ volume: 50, lastNonMuteVolume: 50 });
        usePlayerStore.setState({ isPlaying: true, isPaused: false });
        renderWithProviders(
          <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
        );
        const btn = screen.getByTestId(testId);
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        const preventDefaultSpy = vi.spyOn(ev, 'preventDefault');
        btn.dispatchEvent(ev);
        expect(preventDefaultSpy).toHaveBeenCalled();
      });
    });

    it('still fires onClick even when mousedown.preventDefault suppresses focus', () => {
      usePlayerStore.setState({ isPlaying: true, isPaused: false });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      fireEvent.click(screen.getByTestId('green-flag'));
      expect(playerMocks.greenFlag).toHaveBeenCalledTimes(1);
    });
  });

  describe('green-flag modifier-key shortcuts', () => {
    // Helpers for clicking the flag button with a given set of modifier
    // keys. `fireEvent.click` does not expose `altKey` / `shiftKey` /
    // `ctrlKey` / `metaKey` directly, so we synthesise a `MouseEvent` with
    // the desired flags and dispatch it on the button. The browser would
    // populate these fields from the live keyboard state on a real click.
    function clickFlagWithModifiers(modifiers: {
      shiftKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      altKey?: boolean;
    }): void {
      const btn = screen.getByTestId('green-flag');
      const ev = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        shiftKey: modifiers.shiftKey ?? false,
        ctrlKey: modifiers.ctrlKey ?? false,
        metaKey: modifiers.metaKey ?? false,
        altKey: modifiers.altKey ?? false,
      });
      btn.dispatchEvent(ev);
    }

    it('Shift+Flag toggles advanced.turboMode (does NOT call greenFlag)', () => {
      useSettingsStore.setState({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, turboMode: false },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      clickFlagWithModifiers({ shiftKey: true });
      expect(useSettingsStore.getState().advanced.turboMode).toBe(true);
      expect(playerMocks.greenFlag).not.toHaveBeenCalled();
    });

    it('Ctrl+Flag invokes toggleMute (does NOT call greenFlag)', () => {
      useSettingsStore.setState({ volume: 80, lastNonMuteVolume: 80 });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      clickFlagWithModifiers({ ctrlKey: true });
      expect(useSettingsStore.getState().volume).toBe(0);
      expect(useSettingsStore.getState().lastNonMuteVolume).toBe(80);
      expect(playerMocks.greenFlag).not.toHaveBeenCalled();
    });

    it('Cmd/Meta+Flag invokes toggleMute (macOS equivalent)', () => {
      useSettingsStore.setState({ volume: 80, lastNonMuteVolume: 80 });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      clickFlagWithModifiers({ metaKey: true });
      expect(useSettingsStore.getState().volume).toBe(0);
      expect(useSettingsStore.getState().lastNonMuteVolume).toBe(80);
      expect(playerMocks.greenFlag).not.toHaveBeenCalled();
    });

    it('Alt+Flag cycles fps from 30 to the preferred value (default state → 60)', () => {
      useSettingsStore.setState({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
      });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      clickFlagWithModifiers({ altKey: true });
      expect(useSettingsStore.getState().advanced.fps).toBe(60);
      expect(playerMocks.greenFlag).not.toHaveBeenCalled();
    });

    it('Alt+Flag cycles fps back to 30 when current fps is non-30', () => {
      useSettingsStore.setState({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 60 },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
      });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      clickFlagWithModifiers({ altKey: true });
      expect(useSettingsStore.getState().advanced.fps).toBe(30);
      expect(playerMocks.greenFlag).not.toHaveBeenCalled();
    });

    it('Shift takes precedence over Alt when both are held (Turbo wins, FPS unchanged)', () => {
      useSettingsStore.setState({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30, turboMode: false },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
      });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      clickFlagWithModifiers({ shiftKey: true, altKey: true });
      expect(useSettingsStore.getState().advanced.turboMode).toBe(true);
      expect(useSettingsStore.getState().advanced.fps).toBe(30);
    });

    it('Ctrl/Cmd takes precedence over Alt when both are held (Mute wins, FPS unchanged)', () => {
      useSettingsStore.setState({
        theme: 'system',
        volume: 80,
        lastNonMuteVolume: 80,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
      });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      clickFlagWithModifiers({ ctrlKey: true, altKey: true });
      expect(useSettingsStore.getState().volume).toBe(0);
      expect(useSettingsStore.getState().advanced.fps).toBe(30);
    });

    it('a plain (unmodified) click still calls greenFlag()', () => {
      useSettingsStore.setState({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      });
      renderWithProviders(
        <ControlBar onOpenSettings={() => undefined} onToggleFullscreen={() => undefined} />,
      );
      clickFlagWithModifiers({});
      expect(playerMocks.greenFlag).toHaveBeenCalledTimes(1);
      // And none of the shortcut side-effects fired.
      expect(useSettingsStore.getState().advanced.turboMode).toBe(false);
      expect(useSettingsStore.getState().volume).toBe(100);
      expect(useSettingsStore.getState().advanced.fps).toBe(DEFAULT_ADVANCED_SETTINGS.fps);
    });
  });
});
