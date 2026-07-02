import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { StageView } from '@/features/stage/StageView';
import { useProjectStore } from '@/stores/useProjectStore';

// Mock the player module to capture initPlayer calls without actually loading Scaffolding.
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

describe('StageView mount behavior (player readiness)', () => {
  beforeEach(() => {
    initPlayerMock.mockClear();
    useProjectStore.setState({
      currentId: null,
      metadata: null,
      source: null,
      loadState: 'idle',
    });
  });

  it('always mounts the stage-mount element (so initPlayer has a container) regardless of loadState', () => {
    const { container, rerender } = render(<StageView isFullscreen={false} />);
    expect(container.querySelector('[data-testid="stage-mount"]')).not.toBeNull();

    // Even after loadState changes to 'ready', the element should remain mounted.
    useProjectStore.getState().setReadyFromFile();
    rerender(<StageView isFullscreen={false} />);
    expect(container.querySelector('[data-testid="stage-mount"]')).not.toBeNull();
  });

  it('applies the hidden class to the stage container when idle', () => {
    useProjectStore.setState({ loadState: 'idle' });
    const { container } = render(<StageView isFullscreen={false} />);
    const stageEl = container.querySelector('[data-testid="stage-container"]');
    expect(stageEl).not.toBeNull();
    expect(stageEl?.className).toMatch(/\bhidden\b/);
  });

  it('does not apply the hidden class when a project is ready', () => {
    useProjectStore.getState().setReadyFromFile();
    const { container } = render(<StageView isFullscreen={false} />);
    const stageEl = container.querySelector('[data-testid="stage-container"]');
    expect(stageEl).not.toBeNull();
    expect(stageEl?.className).not.toMatch(/\bhidden\b/);
  });

  it('calls initPlayer on mount', async () => {
    render(<StageView isFullscreen={false} />);
    // initPlayer is async; flush microtasks
    await Promise.resolve();
    await Promise.resolve();
    expect(initPlayerMock).toHaveBeenCalled();
  });
});

describe('StageView fullscreen scaling', () => {
  beforeEach(() => {
    initPlayerMock.mockClear();
    useProjectStore.setState({
      currentId: null,
      metadata: null,
      source: null,
      loadState: 'ready',
    });
  });

  it('scales the stage to the window size when in fullscreen (not 1)', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });

    try {
      const { container } = render(<StageView isFullscreen={true} />);
      // Find the element that receives the transform: scale(...) style.
      // The scale wrapper sits inside the inner container.
      const scaled = Array.from(container.querySelectorAll<HTMLElement>('div')).find(
        (el) => /transform:\s*scale\(/.test(el.getAttribute('style') ?? ''),
      );
      expect(scaled).toBeDefined();
      const style = scaled?.getAttribute('style') ?? '';
      // With stage 480x360 default and window 1600x900, scale should be
      // min(1600/480, 900/360) = min(3.33, 2.5) = 2.5 — NOT 1.
      expect(style).toMatch(/scale\(2\.5\)/);
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        value: originalInnerWidth,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });

  it('never exceeds 1x scale in normal (non-fullscreen) mode', () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 9999, configurable: true });

    try {
      const { container } = render(<StageView isFullscreen={false} />);
      const scaled = Array.from(container.querySelectorAll<HTMLElement>('div')).find(
        (el) => /transform:\s*scale\(/.test(el.getAttribute('style') ?? ''),
      );
      expect(scaled).toBeDefined();
      const style = scaled?.getAttribute('style') ?? '';
      expect(style).toMatch(/scale\(1\)/);
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        value: originalInnerWidth,
        configurable: true,
      });
    }
  });

  it('uses h-full w-full on the stage container in fullscreen so the scaled canvas is not clipped', () => {
    useProjectStore.setState({ loadState: 'ready' });
    const { container } = render(<StageView isFullscreen={true} />);
    const stageEl = container.querySelector('[data-testid="stage-container"]');
    expect(stageEl).not.toBeNull();
    const cls = stageEl?.className ?? '';
    // Both h-full and w-full must be applied so the parent is large enough
    // to contain the transform-scaled content.
    expect(cls).toMatch(/\bh-full\b/);
    expect(cls).toMatch(/\bw-full\b/);
  });

  it('uses flex items-center justify-center on inner container in fullscreen so the scaled canvas is centered', () => {
    useProjectStore.setState({ loadState: 'ready' });
    const { container } = render(<StageView isFullscreen={true} />);
    // The inner container is the only child of [data-testid="stage-container"].
    const stageEl = container.querySelector('[data-testid="stage-container"]');
    const inner = stageEl?.querySelector('div') as HTMLElement | null;
    expect(inner).not.toBeNull();
    const cls = inner?.className ?? '';
    expect(cls).toMatch(/\bflex\b/);
    expect(cls).toMatch(/\bitems-center\b/);
    expect(cls).toMatch(/\bjustify-center\b/);
  });
});