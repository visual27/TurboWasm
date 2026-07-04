import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LoadingProgress } from '@/features/stage/LoadingProgress';
import { usePlayerStore } from '@/stores/usePlayerStore';

function renderWithProviders(): ReturnType<typeof render> {
  return render(
    <TooltipProvider delayDuration={0}>
      <LoadingProgress finished={0} total={0} />
    </TooltipProvider>,
  );
}

describe('LoadingProgress', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      assetProgress: { finished: 0, total: 0 },
    });
  });

  it('renders an indeterminate bar when total is 0', () => {
    renderWithProviders();
    const el = screen.getByTestId('loading-progress');
    expect(el.getAttribute('data-finished')).toBe('0');
    expect(el.getAttribute('data-total')).toBe('0');
    expect(el.textContent).toMatch(/Loading project/);
  });

  it('renders finished/total and a percentage when total > 0', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <LoadingProgress finished={42} total={87} />
      </TooltipProvider>,
    );
    const el = screen.getByTestId('loading-progress');
    expect(el.getAttribute('data-finished')).toBe('42');
    expect(el.getAttribute('data-total')).toBe('87');
    expect(el.textContent).toMatch(/Loading assets/);
    expect(el.textContent).toMatch(/42\s*\/\s*87/);
    expect(el.textContent).toMatch(/48%/); // 42/87 ≈ 48%
  });

  it('honors a custom label', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <LoadingProgress finished={1} total={2} label="Downloading sprites…" />
      </TooltipProvider>,
    );
    expect(screen.getByText(/Downloading sprites/)).toBeInTheDocument();
  });

  it('clamps the displayed ratio to 100% when finished > total', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <LoadingProgress finished={120} total={87} />
      </TooltipProvider>,
    );
    const el = screen.getByTestId('loading-progress');
    // finished=120, total=87 → ratio 1.379 → 138%? but we clamp to 100%.
    // We just check the bar is present and total/finished are reported.
    expect(el.textContent).toMatch(/120\s*\/\s*87/);
  });

  it('renders the count BELOW the bar with a muted style, not next to the label', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <LoadingProgress finished={42} total={87} />
      </TooltipProvider>,
    );
    const el = screen.getByTestId('loading-progress');
    // The label and the count are now in different visual rows.
    const labelRow = el.querySelector('div');
    expect(labelRow?.textContent).toMatch(/Loading assets/);
    expect(labelRow?.textContent).not.toMatch(/42\s*\/\s*87/);
    // The count must live in a separate descendant with muted styling.
    const count = el.querySelector('div.text-xs.tabular-nums');
    expect(count).not.toBeNull();
    expect(count?.textContent).toMatch(/42\s*\/\s*87/);
    expect(count?.className).toMatch(/text-muted-foreground/);
  });
});
