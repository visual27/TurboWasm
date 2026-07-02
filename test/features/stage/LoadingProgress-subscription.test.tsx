import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LoadingProgress } from '@/features/stage/LoadingProgress';
import { usePlayerStore } from '@/stores/usePlayerStore';

describe('LoadingProgress store subscription (Phase 2-1 regression)', () => {
  beforeEach(() => {
    cleanup();
    usePlayerStore.setState({
      isPlaying: false,
      isPaused: false,
      isFullscreen: false,
      assetProgress: { finished: 0, total: 0 },
    });
  });

  it('renders without props and reflects the store assetProgress', () => {
    usePlayerStore.getState().setAssetProgress(3, 10);
    render(<LoadingProgress />);
    const node = screen.getByTestId('loading-progress');
    expect(node.getAttribute('data-finished')).toBe('3');
    expect(node.getAttribute('data-total')).toBe('10');
  });

  it('updates when the store assetProgress changes (subscribed)', () => {
    const { rerender } = render(<LoadingProgress />);
    usePlayerStore.getState().setAssetProgress(5, 12);
    rerender(<LoadingProgress />);
    const node = screen.getByTestId('loading-progress');
    expect(node.getAttribute('data-finished')).toBe('5');
    expect(node.getAttribute('data-total')).toBe('12');
  });

  it('explicit props override the store values', () => {
    usePlayerStore.getState().setAssetProgress(99, 100);
    render(<LoadingProgress finished={1} total={2} />);
    const node = screen.getByTestId('loading-progress');
    expect(node.getAttribute('data-finished')).toBe('1');
    expect(node.getAttribute('data-total')).toBe('2');
  });

  it('shows the indeterminate label when total is 0', () => {
    render(<LoadingProgress />);
    expect(screen.getByText(/Loading project/i)).toBeInTheDocument();
  });

  it('shows the determinate label + ratio when total is > 0', () => {
    usePlayerStore.getState().setAssetProgress(2, 8);
    const { container } = render(<LoadingProgress />);
    expect(screen.getByText(/Loading assets/i)).toBeInTheDocument();
    // The "2 / 8 (25%)" text is split across multiple text nodes due to
    // the inline `{percent !== null ? ... : ''}` template, so we assert on
    // the rendered HTML / container text instead.
    const ratioNode = container.querySelector('[data-testid="loading-progress"] .tabular-nums');
    expect(ratioNode).not.toBeNull();
    expect(ratioNode?.textContent).toBe('2 / 8 (25%)');
  });
});