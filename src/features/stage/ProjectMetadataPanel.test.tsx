import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectMetadataPanel } from '@/features/stage/ProjectMetadataPanel';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { ProjectMetadata } from '@/types/project';

const FULL_METADATA: ProjectMetadata = {
  id: '123',
  title: 'My Project',
  description: 'A short description.',
  instructions: 'Click the flag to start.',
  notesAndCredits: 'Thanks to everyone!',
  author: { username: 'tester' },
};

const INTRO_ONLY: ProjectMetadata = {
  id: '1',
  title: 'Intro Only',
  description: 'desc',
};

const NOTES_ONLY: ProjectMetadata = {
  id: '2',
  title: 'Notes Only',
  notesAndCredits: 'credits here',
};

describe('ProjectMetadataPanel', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
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
        stageWidth: 640,
        stageHeight: 480,
      },
    });
  });

  it('renders the title and author', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    expect(screen.getByText('My Project')).toBeInTheDocument();
    expect(screen.getByText(/tester/)).toBeInTheDocument();
  });

  it('width matches the configured stage width', () => {
    const { container } = render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect((aside as HTMLElement).style.maxWidth).toBe('640px');
  });

  it('renders Introductions first and Notes & Credits second (no tabs)', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    // No tabs — sections are stacked.
    expect(screen.queryByRole('tab')).toBeNull();
    // Each section is a real <section> with an h3 heading.
    const headings = screen.getAllByRole('heading', { level: 3 });
    const labels = headings.map((h) => h.textContent);
    expect(labels).toEqual(['Introductions', 'Notes & Credits']);
  });

  it('Introductions section contains both Description and Instructions texts', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const introductionsSection = screen
      .getByRole('heading', { name: 'Introductions' })
      .closest('section');
    expect(introductionsSection).not.toBeNull();
    expect(introductionsSection).toHaveTextContent('A short description.');
    expect(introductionsSection).toHaveTextContent('Click the flag to start.');
  });

  it('shows the description, instructions, and notes texts', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    expect(screen.getByText('A short description.')).toBeInTheDocument();
    expect(screen.getByText('Click the flag to start.')).toBeInTheDocument();
    expect(screen.getByText('Thanks to everyone!')).toBeInTheDocument();
  });

  it('renders only the Introductions section when notes are missing', () => {
    render(<ProjectMetadataPanel metadata={INTRO_ONLY} />);
    expect(screen.getByText('desc')).toBeInTheDocument();
    // Introductions is shown (description is present).
    expect(screen.getByRole('heading', { name: 'Introductions' })).toBeInTheDocument();
    // Notes is missing → its heading should not appear.
    expect(screen.queryByRole('heading', { name: /Notes/i })).toBeNull();
  });

  it('renders only Notes & Credits when Introductions is empty', () => {
    render(<ProjectMetadataPanel metadata={NOTES_ONLY} />);
    expect(screen.getByText('credits here')).toBeInTheDocument();
    // Introductions is empty → its heading should not appear.
    expect(screen.queryByRole('heading', { name: 'Introductions' })).toBeNull();
    // The h3 "Notes & Credits" section header is present.
    expect(
      screen.getByRole('heading', { level: 3, name: /Notes/i }),
    ).toBeInTheDocument();
  });

  it('has a border (matches stage frame)', () => {
    const { container } = render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const aside = container.querySelector('aside');
    expect(aside?.className).toMatch(/border/);
  });

  it('uses an independent background that is not bg-card', () => {
    const { container } = render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const aside = container.querySelector('aside');
    const cls = aside?.className ?? '';
    // Light mode: bg-white/90
    expect(cls).toMatch(/bg-white\/90/);
    // Dark mode: dark:bg-zinc-900/85
    expect(cls).toMatch(/dark:bg-zinc-900\/85/);
    // Must not use bg-card any more so it visually differs from the rest of
    // the UI surfaces.
    expect(cls).not.toMatch(/bg-card/);
  });
});