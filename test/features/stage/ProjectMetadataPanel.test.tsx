import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectMetadataPanel } from '@/features/stage/ProjectMetadataPanel';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { ProjectMetadata } from '@/types/project';

const FULL_METADATA: ProjectMetadata = {
  id: '123',
  title: 'My Project',
  // Per the Scratch REST API, the `description` field holds the project's
  // Notes and Credits content (see services/scratch-project.ts mapping).
  // The viewer exposes it as `notesAndCredits` so the UI can label it
  // unambiguously.
  instructions: 'Click the flag to start.',
  notesAndCredits: 'Thanks to everyone!',
  author: { username: 'tester' },
};

const INTRO_ONLY: ProjectMetadata = {
  id: '1',
  title: 'Intro Only',
  instructions: 'click the green flag',
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

  it('makes the project title a link to the Scratch project page', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const titleLink = screen.getByTestId('metadata-title-link');
    expect(titleLink).toBeInTheDocument();
    expect(titleLink.tagName).toBe('A');
    expect(titleLink).toHaveAttribute('href', 'https://scratch.mit.edu/projects/123/');
    expect(titleLink).toHaveAttribute('target', '_blank');
    expect(titleLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(titleLink).toHaveAttribute('aria-label', 'Open project "My Project" on Scratch');
    expect(titleLink).toHaveAttribute('title', 'Open "My Project" on Scratch');
    // The link contains the title text.
    expect(titleLink).toHaveTextContent('My Project');
  });

  it('makes the author name a link to the Scratch profile page', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const authorLink = screen.getByTestId('metadata-author-link');
    expect(authorLink).toBeInTheDocument();
    expect(authorLink.tagName).toBe('A');
    expect(authorLink).toHaveAttribute('href', 'https://scratch.mit.edu/users/tester/');
    expect(authorLink).toHaveAttribute('target', '_blank');
    expect(authorLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(authorLink).toHaveAttribute(
      'aria-label',
      'Open Scratch profile for tester',
    );
    expect(authorLink).toHaveAttribute('title', "Open tester's Scratch profile");
    // The link contains only the username (not the "by" prefix).
    expect(authorLink).toHaveTextContent('tester');
  });

  it('does not render an author link when username is missing', () => {
    const NO_AUTHOR: ProjectMetadata = {
      id: '7',
      title: 'Anonymous',
      instructions: 'play me',
    };
    render(<ProjectMetadataPanel metadata={NO_AUTHOR} />);
    expect(screen.queryByTestId('metadata-author-link')).toBeNull();
    // The title link is still rendered.
    const titleLink = screen.getByTestId('metadata-title-link');
    expect(titleLink).toBeInTheDocument();
  });

  it('URL-encodes special characters in project id and username', () => {
    const WEIRD: ProjectMetadata = {
      id: '42/abc',
      title: 'Weird',
      instructions: 'click the flag',
      author: { username: 'user name' },
    };
    render(<ProjectMetadataPanel metadata={WEIRD} />);
    expect(screen.getByTestId('metadata-title-link')).toHaveAttribute(
      'href',
      'https://scratch.mit.edu/projects/42%2Fabc/',
    );
    expect(screen.getByTestId('metadata-author-link')).toHaveAttribute(
      'href',
      'https://scratch.mit.edu/users/user%20name/',
    );
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

  it('Introductions section contains the instructions text', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const introductionsSection = screen
      .getByTestId('metadata-section-introductions');
    expect(introductionsSection).toBeInTheDocument();
    expect(introductionsSection).toHaveTextContent('Click the flag to start.');
    // Introductions must NOT contain the notes text.
    expect(introductionsSection).not.toHaveTextContent('Thanks to everyone!');
  });

  it('Notes & Credits section contains the notes text', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const notesSection = screen.getByTestId('metadata-section-notes');
    expect(notesSection).toBeInTheDocument();
    expect(notesSection).toHaveTextContent('Thanks to everyone!');
    // Notes & Credits must NOT contain the instructions text.
    expect(notesSection).not.toHaveTextContent('Click the flag to start.');
  });

  it('shows the instructions and notes texts', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    expect(screen.getByText('Click the flag to start.')).toBeInTheDocument();
    expect(screen.getByText('Thanks to everyone!')).toBeInTheDocument();
  });

  it('renders only the Introductions section when notes are missing', () => {
    render(<ProjectMetadataPanel metadata={INTRO_ONLY} />);
    expect(screen.getByText('click the green flag')).toBeInTheDocument();
    // Introductions is shown (instructions are present).
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

  it('renders each section content in its own section (Notes text is NOT inside the Introductions section)', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const introductionsSection = screen.getByTestId('metadata-section-introductions');
    const notesSection = screen.getByTestId('metadata-section-notes');
    expect(introductionsSection).not.toBeNull();
    expect(notesSection).not.toBeNull();
    // Introductions section must contain instructions but NOT notes.
    expect(introductionsSection).toHaveTextContent('Click the flag to start.');
    expect(introductionsSection).not.toHaveTextContent('Thanks to everyone!');
    // Notes & Credits section must contain the notes text but NOT instructions.
    expect(notesSection).toHaveTextContent('Thanks to everyone!');
    expect(notesSection).not.toHaveTextContent('Click the flag to start.');
  });

  it('renders the Notes & Credits header (h3) when notes are present', () => {
    render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    // The bug previously caused the Notes & Credits h3 to be missing entirely.
    const notesHeader = screen.getByRole('heading', { level: 3, name: 'Notes & Credits' });
    expect(notesHeader).toBeInTheDocument();
    expect(notesHeader.textContent).toBe('Notes & Credits');
  });

  it('places the Notes & Credits section after the Introductions section in DOM order', () => {
    const { container } = render(<ProjectMetadataPanel metadata={FULL_METADATA} />);
    const intro = container.querySelector('[data-testid="metadata-section-introductions"]');
    const notes = container.querySelector('[data-testid="metadata-section-notes"]');
    expect(intro).not.toBeNull();
    expect(notes).not.toBeNull();
    // DOM order: compare positions within the rendered <section> elements.
    const allSections = Array.from(container.querySelectorAll<HTMLElement>('section'));
    const introPos = allSections.indexOf(intro as HTMLElement);
    const notesPos = allSections.indexOf(notes as HTMLElement);
    expect(introPos).toBeGreaterThanOrEqual(0);
    expect(notesPos).toBeGreaterThan(introPos);
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