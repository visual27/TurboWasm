import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailedSettingsScreen } from '@/features/settings/DetailedSettingsScreen';
import { useSettingsStore } from '@/stores/useSettingsStore';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_DETAILED_OPTIMIZATIONS,
  DEFAULT_SEMANTIC_OPTIONS,
} from '@/utils/constants';

function resetStore(): void {
  useSettingsStore.setState({
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
    allowedExtensionUrls: [],
    enableWasm: true,
    userExplicitFps: null,
    detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
    beforeTurboWasmMasterOffSnapshot: null,
  });
}

describe('DetailedSettingsScreen (Phase 14)', () => {
  beforeEach(() => {
    resetStore();
  });

  function renderScreen(
    overrides: Partial<React.ComponentProps<typeof DetailedSettingsScreen>> = {},
  ): void {
    render(
      <DetailedSettingsScreen
        masterOn={true}
        detailed={{ ...DEFAULT_DETAILED_OPTIMIZATIONS }}
        semantics={{ ...DEFAULT_SEMANTIC_OPTIONS }}
        enableWebgpu={true}
        enableWasm={true}
        customBlockInliningEnabled={true}
        patchAdvanced={() => undefined}
        setEnableWasm={() => undefined}
        onToggleDetailed={() => undefined}
        onOpenSemantics={() => undefined}
        {...overrides}
      />,
    );
  }

  it('renders the TurboWasm Pipeline, Compatibility Layer, Data Structures sub-sections', () => {
    renderScreen();
    expect(screen.getByTestId('detailed-subsection-pipeline')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-subsection-compat-layer')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-subsection-data-structures')).toBeInTheDocument();
  });

  it('renders the three pipeline toggles + the three wired detailed optimizations', () => {
    renderScreen();
    // TurboWasm Pipeline (3 rows).
    expect(screen.getByTestId('detailed-toggle-row-enable-webgpu')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-toggle-row-enable-wasm')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-toggle-row-custom-block-inlining')).toBeInTheDocument();
    // Compatibility Layer (1 row).
    expect(screen.getByTestId('detailed-toggle-row-compatLayer.branchInfoReuse')).toBeInTheDocument();
    // Data Structures (2 rows).
    expect(screen.getByTestId('detailed-toggle-row-data.mapConversionEvaluation')).toBeInTheDocument();
    expect(screen.getByTestId('detailed-toggle-row-data.constantFolding')).toBeInTheDocument();
  });

  it('does NOT render the retired cosmetic detailed-optimization IDs', () => {
    renderScreen();
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
    expect(screen.queryByTestId('detailed-toggle-row-compiler.generatorGranularityResearch')).toBeNull();
  });

  it('renders a Semantics row at the bottom with the active preset badge', () => {
    renderScreen({ semantics: { ...DEFAULT_SEMANTIC_OPTIONS, preset: 'full-js' } });
    const semanticsRow = screen.getByTestId('settings-semantics-row');
    expect(semanticsRow).toBeInTheDocument();
    expect(semanticsRow.textContent).toMatch(/full-js/i);
  });

  it('invokes onOpenSemantics when the Semantics row is clicked', async () => {
    const user = userEvent.setup();
    const onOpenSemantics = vi.fn();
    renderScreen({ onOpenSemantics });
    await user.click(screen.getByTestId('settings-semantics-row'));
    expect(onOpenSemantics).toHaveBeenCalledTimes(1);
  });

  it('invokes onToggleDetailed with the optimization id when a Switch is flipped', async () => {
    const user = userEvent.setup();
    const onToggleDetailed = vi.fn();
    renderScreen({ onToggleDetailed });
    const toggle = screen.getByLabelText(
      'Branch Info Reuse toggle',
    ) as HTMLButtonElement;
    await user.click(toggle);
    expect(onToggleDetailed).toHaveBeenCalledWith('compatLayer.branchInfoReuse', true);
  });

  it('disables every row when the master toggle is off', () => {
    renderScreen({ masterOn: false });
    expect(
      (screen.getByLabelText('Enable WebGPU toggle') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText('Enable WASM toggle') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText('Custom Block Inlining toggle') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText('Branch Info Reuse toggle') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText('Map Conversion Evaluation toggle') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText('Constant Folding toggle') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText('Open semantics settings') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows a "master off" hint when the master toggle is off', () => {
    renderScreen({ masterOn: false });
    expect(screen.getByText(/Master off/i)).toBeInTheDocument();
  });

  it('shows a "master on" hint when the master toggle is on', () => {
    renderScreen({ masterOn: true });
    expect(screen.getByText(/Master on/i)).toBeInTheDocument();
  });

  it('renders a Close button when onClose is provided (= the dialog-mounted style)', () => {
    const onClose = vi.fn();
    renderScreen({ onClose });
    expect(screen.getByTestId('detailed-close')).toBeInTheDocument();
  });

  it('invokes onClose when the Close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderScreen({ onClose });
    await user.click(screen.getByTestId('detailed-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT render a Close button when onClose is absent (= legacy mount style)', () => {
    renderScreen();
    expect(screen.queryByTestId('detailed-close')).toBeNull();
  });
});