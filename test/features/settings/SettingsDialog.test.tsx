import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { useSettingsStore } from '@/stores/useSettingsStore';

describe('SettingsDialog — layout', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
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
        extensionSandboxMode: 'worker',
      },
      allowedExtensionUrls: [],
    });
  });

  it('renders a Settings title', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders the four categories in order', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const sections = screen.getAllByTestId(/^settings-section-/);
    expect(sections.map((el) => el.getAttribute('data-testid'))).toEqual([
      'settings-section-runtime',
      'settings-section-rendering',
      'settings-section-limits',
      'settings-section-others',
    ]);
    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Rendering')).toBeInTheDocument();
    expect(screen.getByText('Limits')).toBeInTheDocument();
    expect(screen.getByText('Others')).toBeInTheDocument();
  });

  it('renders the Runtime rows in the requested order', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const labels = screen.getAllByText(
      /^(FPS|Turbo Mode|Interpolation|Warp Timer|High Quality Pen|Stage Size|Infinity Clones|Remove Fencing|Remove Misc Limits|Volume|Disable Compiler)$/,
    );
    const runtimeLabels = labels
      .map((el) => el.textContent ?? '')
      .filter((t) => ['FPS', 'Turbo Mode', 'Interpolation', 'Warp Timer'].includes(t));
    expect(runtimeLabels).toEqual(['FPS', 'Turbo Mode', 'Interpolation', 'Warp Timer']);
  });

  it('renders the Rendering section with High Quality Pen and Stage Size', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByText('High Quality Pen')).toBeInTheDocument();
    expect(screen.getByText('Stage Size')).toBeInTheDocument();
  });

  it('renders the Limits section with all three rows', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByText('Infinity Clones')).toBeInTheDocument();
    expect(screen.getByText('Remove Fencing')).toBeInTheDocument();
    expect(screen.getByText('Remove Misc Limits')).toBeInTheDocument();
  });

  it('renders the Others section with Volume and Disable Compiler', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByText('Volume')).toBeInTheDocument();
    expect(screen.getByText('Disable Compiler')).toBeInTheDocument();
  });

  it('does NOT render an Extensions tab', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByRole('tab', { name: 'Extensions' })).toBeNull();
    expect(screen.queryByLabelText('Allow project extensions')).toBeNull();
  });

  it('places the scroll area between the title and the footer', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByTestId('settings-scroll-area')).toBeInTheDocument();
    expect(screen.getByTestId('settings-reset')).toBeInTheDocument();
  });

  it('resetAdvanced restores defaults', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().patchAdvanced({ fps: 60, stageWidth: 800 });
    expect(useSettingsStore.getState().advanced.fps).toBe(60);
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-reset'));
    expect(useSettingsStore.getState().advanced.fps).toBe(30);
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(480);
  });
});
