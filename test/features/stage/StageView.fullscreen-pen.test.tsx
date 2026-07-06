import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { StageView } from '@/features/stage/StageView';
import { useProjectStore } from '@/stores/useProjectStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

// Mock the player module to capture initPlayer calls without actually loading Scaffolding.
// The settings-bridge's runtime calls (`applySettings`) are also stubbed so the
// Zustand subscribe in StageView runs without trying to drive a real VM.
const initPlayerMock = vi.fn().mockResolvedValue({
  vm: {
    runtime: {
      setCompilerOptions: () => undefined,
      setRuntimeOptions: () => undefined,
      frameLoop: { setFramerate: () => undefined, setInterpolation: () => undefined },
    },
    setTurboMode: () => undefined,
    setStageSize: () => undefined,
    renderer: { setUseHighQualityRender: () => undefined },
  },
  renderer: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

// Replace the Scaffolding helpers with no-ops so StageView's coalesced
// relayout effect can't accidentally drive the real Scaffolding instance
// while other tests run in parallel.
vi.mock('@/lib/scaffolding', async () => {
  const actual = await vi.importActual<typeof import('@/lib/scaffolding')>('@/lib/scaffolding');
  return {
    ...actual,
    relayoutScaffolding: vi.fn(),
    setScaffoldingResizeMode: vi.fn(),
  };
});

vi.mock('@/runtime/player', async () => {
  const actual = await vi.importActual<typeof import('@/runtime/player')>('@/runtime/player');
  return {
    ...actual,
    initPlayer: (...args: unknown[]) => initPlayerMock(...args),
    applySettings: vi.fn(),
    setVolume: vi.fn(),
    subscribePlayerState: () => () => undefined,
  };
});

/**
 * Find the layout box (the div with `relative shrink-0` that wraps the
 * `[data-testid="stage-mount"]` element). Its inline `style` is what the
 * tests assert against — it's the only DOM-level observable for whether
 * StageView chose the fullscreen + High-Quality-Pen direct-canvas-resize
 * layout vs. the older transform-scale layout.
 */
function getLayoutBox(container: HTMLElement): HTMLElement {
  const stageMount = container.querySelector('[data-testid="stage-mount"]');
  if (!stageMount) throw new Error('stage-mount not found');
  const layoutBox = stageMount.parentElement;
  if (!layoutBox) throw new Error('layout box not found');
  return layoutBox as HTMLElement;
}

function setAdvanced(overrides: Partial<typeof DEFAULT_ADVANCED_SETTINGS>): void {
  useSettingsStore.setState({
    advanced: { ...DEFAULT_ADVANCED_SETTINGS, ...overrides },
    defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, ...overrides },
  });
}

describe('StageView — Fullscreen + High Quality Pen layout', () => {
  let originalInnerWidth: number;
  let originalInnerHeight: number;

  beforeEach(() => {
    initPlayerMock.mockClear();
    useProjectStore.setState({
      currentId: null,
      metadata: null,
      source: null,
      loadState: 'ready',
    });
    setAdvanced({ highQualityPen: false });
    originalInnerWidth = window.innerWidth;
    originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: originalInnerWidth,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: originalInnerHeight,
      configurable: true,
    });
  });

  it('fills the layout box to 100% × 100% and omits the CSS transform when fullscreen + HQ pen are on', () => {
    setAdvanced({ highQualityPen: true });
    const { container } = render(<StageView isFullscreen={true} />);
    const layoutBox = getLayoutBox(container);
    const style = layoutBox.getAttribute('style') ?? '';
    // Width/height must be percentages so the Scaffolding's `_root` inherits
    // the viewport dimensions and `Scaffolding.relayout()` size the renderer
    // canvas accordingly.
    expect(style).toMatch(/width:\s*100%/);
    expect(style).toMatch(/height:\s*100%/);
    // CSS transform MUST be absent — keeping it would double-apply the scale
    // and blur pen layers further. `useFullscreenPenResize` branches the
    // render to drop transform-related properties entirely.
    expect(style).not.toMatch(/transform:\s*scale\(/);
    expect(style).not.toMatch(/transform-origin:/);
  });

  it('falls back to transform-scale at the existing scale(2.5) when fullscreen but HQ pen is off', () => {
    // highQualityPen stays false from beforeEach — the previous TurboWarp-
    // parity behavior must be preserved for users who haven't enabled it.
    const { container } = render(<StageView isFullscreen={true} />);
    const layoutBox = getLayoutBox(container);
    const style = layoutBox.getAttribute('style') ?? '';
    expect(style).toMatch(/width:\s*480px/);
    expect(style).toMatch(/height:\s*360px/);
    // min(1600/480, 900/360) = min(3.33, 2.5) = 2.5
    expect(style).toMatch(/scale\(2\.5\)/);
    expect(style).toMatch(/transform-origin:\s*center\s+center/);
  });

  it('clamps the transform to scale(1) in normal (non-fullscreen) mode regardless of container size', () => {
    Object.defineProperty(window, 'innerWidth', { value: 9999, configurable: true });
    const { container } = render(<StageView isFullscreen={false} />);
    const layoutBox = getLayoutBox(container);
    const style = layoutBox.getAttribute('style') ?? '';
    expect(style).toMatch(/width:\s*480px/);
    expect(style).toMatch(/height:\s*360px/);
    expect(style).toMatch(/scale\(1\)/);
  });

  it('reverts the layout box back to stageWidth × stageHeight when HQ pen is toggled off mid-fullscreen', () => {
    setAdvanced({ highQualityPen: true });
    const { container, rerender } = render(<StageView isFullscreen={true} />);
    const layoutBox = getLayoutBox(container);
    const initialStyle = layoutBox.getAttribute('style') ?? '';
    expect(initialStyle).toMatch(/width:\s*100%/);
    expect(initialStyle).not.toMatch(/transform:\s*scale\(/);

    // User toggles HQ pen off in the Settings dialog while fullscreen.
    setAdvanced({ highQualityPen: false });
    rerender(<StageView isFullscreen={true} />);

    const revertedStyle = layoutBox.getAttribute('style') ?? '';
    expect(revertedStyle).toMatch(/width:\s*480px/);
    expect(revertedStyle).toMatch(/height:\s*360px/);
    expect(revertedStyle).toMatch(/scale\(2\.5\)/);
  });

  it('flips the layout box to 100% × 100% when entering fullscreen with HQ pen already on', () => {
    setAdvanced({ highQualityPen: true });
    const { container, rerender } = render(<StageView isFullscreen={false} />);
    const layoutBox = getLayoutBox(container);
    const initialStyle = layoutBox.getAttribute('style') ?? '';
    // Normal mode: layout box stays at project size, scale=1.
    expect(initialStyle).toMatch(/width:\s*480px/);
    expect(initialStyle).toMatch(/scale\(1\)/);

    rerender(<StageView isFullscreen={true} />);

    const afterStyle = layoutBox.getAttribute('style') ?? '';
    expect(afterStyle).toMatch(/width:\s*100%/);
    expect(afterStyle).toMatch(/height:\s*100%/);
    expect(afterStyle).not.toMatch(/transform:\s*scale\(/);
  });
});
