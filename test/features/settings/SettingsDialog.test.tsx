import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_DETAILED_OPTIMIZATIONS } from '@/utils/constants';
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
      enableWasm: true,
      // §Phase 1 — `detailedOptimizations` is now persisted across
      // sessions, so we must explicitly reset it in `beforeEach` to
      // avoid the previous test's persisted value leaking through.
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
    });
  });

  it('renders a Settings title', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders the root categories in order (Detailed Settings is hidden until the row is clicked)', () => {
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
    // The TurboWasm section header reads "TurboWasm" once. The
    // Detailed Settings screen is gated behind the `settings-detailed-row`
    // ClickableFieldRow (= the navigation entry point the user clicks
    // to drill in via the view stack).
    expect(screen.getByText('TurboWasm')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-detailed')).toBeNull();
    expect(screen.getByTestId('settings-detailed-row')).toBeInTheDocument();
    expect(screen.getByText('Others')).toBeInTheDocument();
  });

  it('keeps the Back button slot in the DOM at the root but hides it visually (= canPop is false)', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const back = screen.getByTestId('settings-back');
    expect(back).toBeInTheDocument();
    // The slot is rendered with `visibility: hidden` so it preserves
    // its flex box (= `h-8 w-8`) and the dialog header height stays
    // constant when the user pushes a view onto the stack.
    expect(back.className).toContain('invisible');
    expect(back.getAttribute('aria-hidden')).toBe('true');
    expect(back.getAttribute('tabindex')).toBe('-1');
    // Interaction is suppressed so the hidden button is unreachable.
    expect((back as HTMLButtonElement).disabled).toBe(false);
    const styles = (back as HTMLButtonElement).style;
    expect(styles.pointerEvents).toBe('none');
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
    expect(within(othersSection).queryByText('Enable WASM')).toBeNull();
  });

  it('does NOT render the retired SVG Acceleration dropdown', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByLabelText('SVG acceleration mode')).toBeNull();
    expect(screen.queryByText('SVG Acceleration')).toBeNull();
    expect(screen.queryByRole('option', { name: /Cache only/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /MIP chain/i })).toBeNull();
  });

  it('does NOT render the retired Performance Mode dropdown', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByText('Performance Mode')).toBeNull();
    expect(screen.queryByLabelText('Performance mode')).toBeNull();
  });

  it('renders the TurboWasm section with the master toggle only (drill-down hides the pipeline)', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    const turboSection = screen
      .getByTestId('settings-section-turbowasm')
      .closest('section') as HTMLElement;
    expect(within(turboSection).getByText('TurboWasm Acceleration')).toBeInTheDocument();
    expect(within(turboSection).queryByText('Enable WebGPU')).toBeNull();
    expect(within(turboSection).queryByText('Enable WASM')).toBeNull();
    expect(within(turboSection).queryByText('Custom Block Inlining')).toBeNull();
  });

  it('does NOT render the retired GPU Kernels row', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByText('GPU Kernels')).toBeNull();
  });

  it('places the Enable WASM toggle immediately below Enable WebGPU inside the Pipeline sub-section', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const pipeline = screen
      .getByTestId('detailed-subsection-pipeline')
      .closest('section') as HTMLElement;
    const labels = Array.from(pipeline.querySelectorAll('label')).map(
      (el) => el.textContent ?? '',
    );
    const webgpuIdx = labels.findIndex((l) => l === 'Enable WebGPU');
    const wasmIdx = labels.findIndex((l) => l === 'Enable WASM');
    expect(webgpuIdx).toBeGreaterThanOrEqual(0);
    expect(wasmIdx).toBeGreaterThan(webgpuIdx);
  });

  it('places Custom Block Inlining immediately below Enable WASM (§Phase 5)', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const pipeline = screen
      .getByTestId('detailed-subsection-pipeline')
      .closest('section') as HTMLElement;
    const labels = Array.from(pipeline.querySelectorAll('label')).map(
      (el) => el.textContent ?? '',
    );
    const wasmIdx = labels.findIndex((l) => l === 'Enable WASM');
    const cbiIdx = labels.findIndex((l) => l === 'Custom Block Inlining');
    expect(wasmIdx).toBeGreaterThanOrEqual(0);
    expect(cbiIdx).toBeGreaterThan(wasmIdx);
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
      enableWasm: true,
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

describe('SettingsDialog — Enable WASM toggle', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
    });
  });

  it('defaults the toggle to ON', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const toggle = screen.getByLabelText('Enable WASM toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('data-state')).toBe('checked');
    expect(useSettingsStore.getState().enableWasm).toBe(true);
  });

  it('flips the toggle OFF and propagates to the store', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const toggle = screen.getByLabelText('Enable WASM toggle');
    await user.click(toggle);
    expect(useSettingsStore.getState().enableWasm).toBe(false);
  });
});

describe('SettingsDialog — Enable WebGPU toggle (renamed from GPU Kernels)', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
    });
  });

  it('defaults the toggle to ON', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const toggle = screen.getByLabelText('Enable WebGPU toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('data-state')).toBe('checked');
    expect(useSettingsStore.getState().advanced.enableWebgpu).toBe(true);
  });

  it('flips the toggle OFF and propagates to the store', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const toggle = screen.getByLabelText('Enable WebGPU toggle');
    await user.click(toggle);
    expect(useSettingsStore.getState().advanced.enableWebgpu).toBe(false);
  });

  it('forces defaultAdvanced.enableWebgpu to true on "Set as default"', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().patchAdvanced({ enableWebgpu: false });
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-set-default'));
    const s = useSettingsStore.getState();
    expect(s.advanced.enableWebgpu).toBe(false);
    expect(s.defaultAdvanced.enableWebgpu).toBe(true);
  });
});

describe('SettingsDialog — Custom Block Inlining toggle (§Phase 5)', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
    });
  });

  it('defaults the toggle to ON', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const toggle = screen.getByLabelText(
      'Custom Block Inlining toggle',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('data-state')).toBe('checked');
    expect(useSettingsStore.getState().advanced.customBlockInliningEnabled).toBe(true);
  });

  it('flips the toggle OFF and propagates to the store', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const toggle = screen.getByLabelText('Custom Block Inlining toggle');
    await user.click(toggle);
    expect(useSettingsStore.getState().advanced.customBlockInliningEnabled).toBe(false);
  });

  it('"Set as default" preserves the OFF value (power-user toggle, not auto-forced ON)', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().patchAdvanced({ customBlockInliningEnabled: false });
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-set-default'));
    const s = useSettingsStore.getState();
    expect(s.advanced.customBlockInliningEnabled).toBe(false);
    expect(s.defaultAdvanced.customBlockInliningEnabled).toBe(false);
  });
});

describe('SettingsDialog — Nested @compute toggle (§Phase 4 BREAKING: removed)', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
    });
  });

  it('no longer renders the Nested @compute toggle', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByLabelText('Nested @compute toggle')).toBeNull();
  });

  it('the Pipeline sub-section ends with the Custom Block Inlining row', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const pipeline = screen
      .getByTestId('detailed-subsection-pipeline')
      .closest('section') as HTMLElement;
    const labels = Array.from(pipeline.querySelectorAll('label')).map(
      (el) => el.textContent ?? '',
    );
    const cbiIdx = labels.findIndex((l) => l === 'Custom Block Inlining');
    expect(cbiIdx).toBeGreaterThanOrEqual(0);
    expect(labels.at(-1)).toBe('Custom Block Inlining');
    const nestedIdx = labels.findIndex((l) => l?.startsWith('Nested @compute'));
    expect(nestedIdx).toBe(-1);
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

describe('SettingsDialog — Detailed Settings screen (view stack push/pop)', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
    });
  });

  it('does NOT render the Detailed Settings screen at the root', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByTestId('settings-section-detailed')).toBeNull();
    expect(screen.getByTestId('settings-detailed-row')).toBeInTheDocument();
  });

  it('clicking the navigation row pushes the Detailed Settings screen (= canPop becomes true, Back button appears)', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    // At the root the Back slot is in the DOM but visually hidden so
    // the header height is locked (= the visible "appears" change is
    // `visibility: hidden` → visible, not mount/unmount).
    expect(screen.getByTestId('settings-back').className).toContain('invisible');
    await user.click(screen.getByTestId('settings-detailed-row'));
    expect(screen.getByTestId('settings-section-detailed')).toBeInTheDocument();
    expect(screen.getByTestId('settings-back')).toBeInTheDocument();
    expect(screen.getByTestId('settings-back').className).not.toContain('invisible');
    // The root categories are gone (= the screen replaced the dialog
    // body, not appended inline).
    expect(screen.queryByTestId('settings-section-runtime')).toBeNull();
    expect(screen.queryByTestId('settings-section-others')).toBeNull();
  });

  it('clicking the Back button pops back to the root (= Detailed Settings screen disappears)', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    expect(screen.getByTestId('settings-section-detailed')).toBeInTheDocument();
    await user.click(screen.getByTestId('settings-back'));
    expect(screen.queryByTestId('settings-section-detailed')).toBeNull();
    // Back slot is still in the DOM but re-hidden so the header
    // height stays constant.
    expect(screen.getByTestId('settings-back').className).toContain('invisible');
    expect(screen.getByTestId('settings-section-runtime')).toBeInTheDocument();
  });

  it('renders the TurboWasm Pipeline, Compatibility Layer, and Data Structures sub-sections inside the screen', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    expect(screen.getByTestId('detailed-subsection-pipeline')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-subsection-compat-layer')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-subsection-data-structures')).toBeInTheDocument();
  });

  it('renders the Enable WebGPU / Enable WASM / Custom Block Inlining rows under the Pipeline sub-section', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    expect(screen.getByTestId('detailed-toggle-row-enable-webgpu')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-toggle-row-enable-wasm')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-toggle-row-custom-block-inlining')).toBeInTheDocument();
  });

  it('renders the three surviving wired detailed-optimization rows', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    expect(screen.getByTestId('detailed-toggle-row-compatLayer.branchInfoReuse')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-toggle-row-data.mapConversionEvaluation')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-toggle-row-data.constantFolding')).toBeInTheDocument();
  });

  it('does NOT render any of the retired cosmetic detailed-optimization rows', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    expect(
      screen.queryByTestId('detailed-toggle-row-comparison.shortCircuit'),
    ).toBeNull();
    expect(
      screen.queryByTestId('detailed-toggle-row-comparison.infinityBranchRemoval'),
    ).toBeNull();
    expect(
      screen.queryByTestId('detailed-toggle-row-edgeHat.sentinelElimination'),
    ).toBeNull();
    expect(screen.queryByTestId('detailed-toggle-row-compatLayer.closureReuse')).toBeNull();
    expect(screen.queryByTestId('detailed-toggle-row-compatLayer.procedureCache')).toBeNull();
    expect(
      screen.queryByTestId('detailed-toggle-row-compatLayer.procedureCacheThreadCompaction'),
    ).toBeNull();
    expect(
      screen.queryByTestId('detailed-toggle-row-compiler.generatorGranularityResearch'),
    ).toBeNull();
  });

  it('toggling the Branch Info Reuse switch updates the store', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    const toggle = screen.getByLabelText(
      'Branch Info Reuse toggle',
    ) as HTMLButtonElement;
    await user.click(toggle);
    expect(
      useSettingsStore.getState().detailedOptimizations['compatLayer.branchInfoReuse'],
    ).toBe(true);
  });

  it('disables the root "Detailed Settings" navigation row when the master is off', () => {
    useSettingsStore.setState({
      advanced: {
        ...DEFAULT_ADVANCED_SETTINGS,
        turboWasmAccelerationEnabled: false,
      },
    });
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(
      (screen.getByTestId('settings-detailed-row') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId('settings-section-detailed')).toBeNull();
  });
});

describe('SettingsDialog — Semantics screen (view stack push/pop)', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
    });
  });

  it('does NOT render the Semantics screen at the root', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByTestId('semantics-screen')).toBeNull();
    expect(screen.queryByTestId('settings-semantics-row')).toBeNull();
  });

  it('Semantics is reachable only via Detailed Settings → Semantics row (= two pushes)', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    // After one push: Detailed Settings visible, but Semantics row
    // must NOT yet have rendered the Semantics screen.
    await user.click(screen.getByTestId('settings-detailed-row'));
    expect(screen.getByTestId('settings-section-detailed')).toBeInTheDocument();
    expect(screen.queryByTestId('semantics-screen')).toBeNull();
    // After a second push: Semantics screen replaces the Detailed
    // Settings body, so the Detailed Settings section is no longer
    // in the DOM.
    await user.click(screen.getByTestId('settings-semantics-row'));
    expect(screen.getByTestId('semantics-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-detailed')).toBeNull();
  });

  it('Back button from Semantics pops back to Detailed Settings (= not all the way to the root)', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    await user.click(screen.getByTestId('settings-semantics-row'));
    expect(screen.getByTestId('semantics-screen')).toBeInTheDocument();
    await user.click(screen.getByTestId('settings-back'));
    // After pop: Semantics gone, Detailed Settings back, Back button
    // still present (= canPop is still true).
    expect(screen.queryByTestId('semantics-screen')).toBeNull();
    expect(screen.getByTestId('settings-section-detailed')).toBeInTheDocument();
    expect(screen.getByTestId('settings-back')).toBeInTheDocument();
  });

  it('opening a fresh dialog resets the stack to the root', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    await user.click(screen.getByTestId('settings-semantics-row'));
    expect(screen.getByTestId('semantics-screen')).toBeInTheDocument();
    // Close + reopen. The new session must start at the root (= the
    // dialog's `useEffect(() => { if (open) setStack(createInitialStack()) }, [open])`
    // invariant).
    rerender(<SettingsDialog open={false} onOpenChange={() => undefined} />);
    rerender(<SettingsDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByTestId('semantics-screen')).toBeNull();
    expect(screen.queryByTestId('settings-section-detailed')).toBeNull();
    expect(screen.getByTestId('settings-back').className).toContain('invisible');
    expect(screen.getByTestId('settings-section-runtime')).toBeInTheDocument();
  });

  it('flipping a per-flag through patchSemantic auto-flips the preset to "custom"', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByTestId('settings-detailed-row'));
    await user.click(screen.getByTestId('settings-semantics-row'));
    await user.click(screen.getByTestId('semantics-preset-custom'));
    const toggle = screen.getByLabelText('Truncated Modulo toggle') as HTMLButtonElement;
    await user.click(toggle);
    expect(useSettingsStore.getState().advanced.semantics.truncatedModulo).toBe(true);
    expect(useSettingsStore.getState().advanced.semantics.preset).toBe('custom');
  });
});