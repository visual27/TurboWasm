import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS, FPS_MAX } from '@/utils/constants';

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

  it('renders the five categories in order', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const sections = screen.getAllByTestId(/^settings-section-/);
    expect(sections.map((el) => el.getAttribute('data-testid'))).toEqual([
      'settings-section-runtime',
      'settings-section-rendering',
      'settings-section-limits',
      'settings-section-turbowasm',
      'settings-section-others',
    ]);
    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Rendering')).toBeInTheDocument();
    expect(screen.getByText('Limits')).toBeInTheDocument();
    expect(screen.getByText('TurboWasm')).toBeInTheDocument();
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

  it('renders the Others section with Volume and Disable Compiler (no TurboWasm items)', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const othersSection = screen
      .getByTestId('settings-section-others')
      .closest('section') as HTMLElement;
    expect(within(othersSection).getByText('Volume')).toBeInTheDocument();
    expect(within(othersSection).getByText('Disable Compiler')).toBeInTheDocument();
    expect(within(othersSection).queryByText('TurboWasm Acceleration')).toBeNull();
    expect(within(othersSection).queryByText('Performance Mode')).toBeNull();
  });

  it('does NOT render the retired SVG Acceleration dropdown', () => {
    // SVG acceleration (Stage 2) was removed along with the WebGPU
    // compute / instanced renderer tiers. The dialog must not surface
    // a non-functional dropdown.
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByLabelText('SVG acceleration mode')).toBeNull();
    expect(screen.queryByText('SVG Acceleration')).toBeNull();
    expect(screen.queryByRole('option', { name: /Cache only/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /MIP chain/i })).toBeNull();
  });

  it('renders the TurboWasm section with TurboWasm Acceleration and Performance Mode', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const turboSection = screen
      .getByTestId('settings-section-turbowasm')
      .closest('section') as HTMLElement;
    expect(within(turboSection).getByText('TurboWasm Acceleration')).toBeInTheDocument();
    expect(within(turboSection).getByText('Performance Mode')).toBeInTheDocument();
  });

  it('Performance Mode dropdown exposes only auto / force-wasm / legacy-only', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const trigger = screen.getByLabelText('Performance mode');
    expect(trigger).toHaveTextContent(/Auto/i);
    // The retired `force-webgpu` value must not be selectable.
    expect(screen.queryByRole('option', { name: /Force WebGPU/i })).toBeNull();
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
    expect(s.advanced.fps).toBe(60);
    expect(s.advanced.disableCompiler).toBe(true);
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

describe('SettingsDialog — TurboWasm Acceleration toggle', () => {
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

  it('defaults the toggle to ON', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const toggle = screen.getByLabelText('TurboWasm Acceleration toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('data-state')).toBe('checked');
    expect(useSettingsStore.getState().advanced.turboWasmAccelerationEnabled).toBe(true);
  });

  it('flips the toggle OFF and propagates to the store', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const toggle = screen.getByLabelText('TurboWasm Acceleration toggle');
    await user.click(toggle);
    expect(useSettingsStore.getState().advanced.turboWasmAccelerationEnabled).toBe(false);
  });

  it('forces defaultAdvanced.turboWasmAccelerationEnabled to true on "Set as default"', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().patchAdvanced({ turboWasmAccelerationEnabled: false });
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-set-default'));
    const s = useSettingsStore.getState();
    expect(s.advanced.turboWasmAccelerationEnabled).toBe(false);
    expect(s.defaultAdvanced.turboWasmAccelerationEnabled).toBe(true);
  });
});

describe('SettingsDialog — TurboWasm dropdowns inside a Dialog', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      performanceMode: 'auto',
    });
  });

  it('Radix Dialog locks the body with pointer-events: none (the precondition this section guards)', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(document.body.style.pointerEvents).toBe('none');
  });

  it('Popover Content applies pointer-events: auto (regression for dropdown clicks in any wrapping Dialog)', async () => {
    const { Popover, PopoverContent, PopoverTrigger } = await import(
      '@/components/ui/popover'
    );
    const Wrapper = (): React.JSX.Element => (
      <Popover open>
        <PopoverTrigger aria-label="probe trigger">trigger</PopoverTrigger>
        <PopoverContent aria-label="probe content">content</PopoverContent>
      </Popover>
    );
    render(<Wrapper />);
    const content = await screen.findByLabelText('probe content');
    expect(content.className).toMatch(/pointer-events-auto/);
    expect(content.getAttribute('style') ?? '').toMatch(/pointer-events:\s*auto/);
  });

  it('SelectField option click propagates value to the consumer', async () => {
    const { SelectField } = await import('@/components/ui/select');
    const onChange = vi.fn<(v: 'auto' | 'force-wasm') => void>();
    const user = userEvent.setup();
    render(
      <SelectField<'auto' | 'force-wasm'>
        id="probe-select"
        ariaLabel="probe select"
        value="auto"
        onChange={onChange}
        options={[
          { value: 'auto', label: 'Auto', description: 'auto description' },
          { value: 'force-wasm', label: 'Force WASM', description: 'wasm description' },
        ]}
      />,
    );
    await user.click(screen.getByLabelText('probe select'));
    await user.click(screen.getByRole('option', { name: /Force WASM/i }));
    expect(onChange).toHaveBeenCalledWith('force-wasm');
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

  it('does not write to the store while the user is still typing in FPS', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}');
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

  it('clamps out-of-range FPS on commit (1500 → FPS_MAX)', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    fpsInput.focus();
    await user.keyboard('{Backspace}1500');
    await user.keyboard('{Enter}');
    expect(useSettingsStore.getState().advanced.fps).toBe(FPS_MAX);
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

describe('SettingsDialog — Disable Compiler description mentions "Set as default" override', () => {
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

  it('hints the toggle is session-only ("Set as default" re-enables)', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    // The description below the "Disable Compiler" row tells the user
    // that "Set as default" will always re-enable the compiler. This
    // guards the docs/UI contract described in AGENTS.md.
    const othersSection = screen
      .getByTestId('settings-section-others')
      .closest('section') as HTMLElement;
    const description = within(othersSection).getByText(/Set as default/i);
    expect(description).toBeInTheDocument();
  });
});

describe('SettingsDialog — twconfig overrides propagation', () => {
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

  it('reflects runtime overrides applied after the dialog is mounted', async () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;
    const widthInput = screen.getByLabelText('Stage width') as HTMLInputElement;
    expect(fpsInput.value).toBe(String(DEFAULT_ADVANCED_SETTINGS.fps));
    expect(widthInput.value).toBe(String(DEFAULT_ADVANCED_SETTINGS.stageWidth));

    await act(async () => {
      useSettingsStore
        .getState()
        .applyRuntimeOverrides({ fps: 90, stageWidth: 999, highQualityPen: true });
    });

    expect(useSettingsStore.getState().advanced.fps).toBe(90);
    expect(fpsInput.value).toBe('90');
    expect(widthInput.value).toBe('999');
  });

  it('snaps back to saved defaults when a project without twconfig is loaded', async () => {
    useSettingsStore.getState().patchAdvanced({ fps: 60, stageWidth: 800 });
    useSettingsStore.getState().saveAdvancedAsDefault();

    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const fpsInput = screen.getByLabelText('FPS') as HTMLInputElement;

    await act(async () => {
      useSettingsStore.getState().applyRuntimeOverrides({ fps: 90 });
    });
    expect(fpsInput.value).toBe('90');

    await act(async () => {
      useSettingsStore.getState().applyRuntimeOverrides({});
    });
    expect(useSettingsStore.getState().advanced.fps).toBe(60);
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(800);
    expect(fpsInput.value).toBe('60');
    expect((screen.getByLabelText('Stage width') as HTMLInputElement).value).toBe('800');
  });
});