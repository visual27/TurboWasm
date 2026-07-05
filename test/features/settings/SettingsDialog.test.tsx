import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

describe('SettingsDialog — layout', () => {
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
    expect(screen.getByTestId('settings-set-default')).toBeInTheDocument();
  });

  it('resetAdvanced restores defaults from defaultAdvanced', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().patchAdvanced({ fps: 60, stageWidth: 800 });
    expect(useSettingsStore.getState().advanced.fps).toBe(60);
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-reset'));
    expect(useSettingsStore.getState().advanced.fps).toBe(30);
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(480);
  });

  it('"Set as default" promotes the runtime advanced into defaultAdvanced (minus disableCompiler)', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().patchAdvanced({
      fps: 60,
      stageWidth: 800,
      turboMode: true,
      disableCompiler: true,
    });
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-set-default'));
    const s = useSettingsStore.getState();
    // Runtime advanced keeps the in-session edits.
    expect(s.advanced.fps).toBe(60);
    expect(s.advanced.disableCompiler).toBe(true);
    // defaultAdvanced is the runtime snapshot with disableCompiler forced off.
    expect(s.defaultAdvanced.fps).toBe(60);
    expect(s.defaultAdvanced.stageWidth).toBe(800);
    expect(s.defaultAdvanced.turboMode).toBe(true);
    expect(s.defaultAdvanced.disableCompiler).toBe(false);
  });

  it('"Set as default" then "Reset to defaults" restores the saved defaults', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().patchAdvanced({ fps: 60, stageWidth: 800 });
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-set-default'));
    useSettingsStore.getState().patchAdvanced({ fps: 90 });
    await user.click(screen.getByTestId('settings-reset'));
    const s = useSettingsStore.getState();
    expect(s.advanced.fps).toBe(60);
    expect(s.advanced.stageWidth).toBe(800);
  });
});

describe('SettingsDialog — NumberField commit semantics', () => {
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

  // The NumberField is now a controlled draft that only commits on blur or
  // Enter. These tests pin that contract so future changes (e.g. wiring up
  // a controlled form library) cannot regress it.

  it('does not write to the store while the user is still typing in FPS', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}');
    // The input is now empty, but we haven't blurred or pressed Enter, so
    // the store must NOT have been updated with a partial value.
    expect(useSettingsStore.getState().advanced.fps).toBe(30);
    expect(fpsInput.value).toBe('');
  });

  it('commits FPS to the store on Enter', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}6');
    await user.keyboard('{Enter}');
    expect(useSettingsStore.getState().advanced.fps).toBe(6);
  });

  it('commits FPS to the store on blur', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}4');
    fpsInput.blur();
    expect(useSettingsStore.getState().advanced.fps).toBe(4);
  });

  it('rounds non-integer FPS on commit', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}25.7');
    await user.keyboard('{Enter}');
    expect(useSettingsStore.getState().advanced.fps).toBe(26);
    expect((screen.getByLabelText('FPS') as HTMLInputElement).value).toBe('26');
  });

  it('clamps out-of-range FPS on commit (500 → 240)', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}500');
    await user.keyboard('{Enter}');
    expect(useSettingsStore.getState().advanced.fps).toBe(240);
  });

  it('rolls back to the external value on Escape without committing', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}999');
    await user.keyboard('{Escape}');
    expect(useSettingsStore.getState().advanced.fps).toBe(30);
    expect((screen.getByLabelText('FPS') as HTMLInputElement).value).toBe('30');
  });

  it('rolls back to the external value when committing an empty string', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}');
    await user.keyboard('{Enter}');
    expect(useSettingsStore.getState().advanced.fps).toBe(30);
    expect((screen.getByLabelText('FPS') as HTMLInputElement).value).toBe('30');
  });

  it('rolls back when commit text is not parseable as a number', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}');
    await user.keyboard('abc');
    await user.keyboard('{Enter}');
    expect(useSettingsStore.getState().advanced.fps).toBe(30);
  });

  it('commits stageWidth on Tab and reflects in the store', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const widthInput = screen.getByLabelText('Stage width') as HTMLInputElement;
    widthInput.focus();
    // `user.clear()` empties the field in one shot so we don't have to
    // count how many `{Backspace}` presses we need for the default "480"
    // value. The alternative (`{Backspace}800`) would have left "488" in
    // the input.
    await user.clear(widthInput);
    await user.keyboard('800');
    await user.keyboard('{Tab}');
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(800);
  });

  it('commits stageHeight on Tab and clamps out-of-range', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const heightInput = screen.getByLabelText('Stage height') as HTMLInputElement;
    heightInput.focus();
    await user.keyboard('{Backspace}99999');
    await user.keyboard('{Tab}');
    expect(useSettingsStore.getState().advanced.stageHeight).toBe(8192);
  });

  it('commits Volume on Enter and clamps out-of-range', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const volumeInput = screen.getByLabelText('Volume number') as HTMLInputElement;
    volumeInput.focus();
    await user.keyboard('{Backspace}250');
    await user.keyboard('{Enter}');
    expect(useSettingsStore.getState().volume).toBe(100);
  });
});
