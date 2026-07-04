import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreditsDialog } from '@/features/credits/CreditsDialog';

describe('CreditsDialog', () => {
  it('renders author names when open', () => {
    render(<CreditsDialog open onOpenChange={() => undefined} />);
    expect(screen.getByText('visual27')).toBeInTheDocument();
    expect(screen.getByText('_vfx')).toBeInTheDocument();
  });

  it('mentions TurboWarp Scaffolding', () => {
    render(<CreditsDialog open onOpenChange={() => undefined} />);
    expect(screen.getAllByText(/TurboWarp Scaffolding/i).length).toBeGreaterThan(0);
  });

  it('links to the Scaffolding repository', () => {
    render(<CreditsDialog open onOpenChange={() => undefined} />);
    const link = screen.getByRole('link', { name: /TurboWarp Scaffolding/i });
    expect(link.getAttribute('href')).toBe('https://github.com/TurboWarp/scaffolding');
  });

  it('renders nothing visible when closed', () => {
    render(<CreditsDialog open={false} onOpenChange={() => undefined} />);
    expect(screen.queryByText('visual27')).toBeNull();
  });

  it('does not render an explicit bottom Close button (only the shadcn X button)', () => {
    render(<CreditsDialog open onOpenChange={() => undefined} />);
    // The shadcn DialogContent renders a top-right close button with sr-only "Close" text.
    // We verify there is exactly one such button — not two.
    const closeButtons = screen.getAllByRole('button', { name: /close/i });
    expect(closeButtons).toHaveLength(1);
  });

  it('close button has no focus ring (no square outline on click)', () => {
    render(<CreditsDialog open onOpenChange={() => undefined} />);
    const closeBtn = screen.getByRole('button', { name: /close/i });
    // Make sure we don't apply focus:ring-* classes that would create a square
    // outline when the button is clicked.
    expect(closeBtn.className).not.toMatch(/focus:ring/);
  });
});
