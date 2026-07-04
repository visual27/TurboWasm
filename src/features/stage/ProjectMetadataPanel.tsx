import * as React from 'react';
import type { ProjectMetadata } from '@/types/project';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export interface ProjectMetadataPanelProps {
  metadata: ProjectMetadata;
}

interface SectionProps {
  title: string;
  testId: string;
  children: React.ReactNode;
}

function Section({ title, testId, children }: SectionProps): React.JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h3>
      <div className="flex flex-col gap-1 text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
        {children}
      </div>
    </section>
  );
}

// Build the canonical Scratch URL for a project page.
function scratchProjectUrl(id: string): string {
  return `https://scratch.mit.edu/projects/${encodeURIComponent(id)}/`;
}

// Build the canonical Scratch URL for a user profile page.
function scratchProfileUrl(username: string): string {
  return `https://scratch.mit.edu/users/${encodeURIComponent(username)}/`;
}

/**
 * Project metadata viewer — renders the fields returned by the Scratch /
 * Trampoline API as two top-level sections, in the same order as
 * turbowarp.org's project page:
 *
 *   1. Introductions   — project instructions (the "Instructions" tab on
 *      the Scratch project page).
 *   2. Notes & Credits — project notes/credits (the "Notes and Credits" tab
 *      on the Scratch project page; exposed as the `description` field by
 *      the Scratch REST API).
 *
 * Each section is hidden when its content is empty / whitespace-only.
 *
 * The header (title + author) is rendered as outbound links to the
 * corresponding Scratch pages — click the title to open the project, click
 * the author to open the author's profile.
 *
 * NOTE: The Scratch REST API's `description` field is the project's Notes
 * and Credits content, NOT a short summary description (see
 * https://en.scratch-wiki.info/wiki/Scratch_API#PUT_.2Fprojects.2F.3Cproject_id.3E
 * where the PUT body uses "description": "New Notes and Credits"). The
 * mapping is done in `services/scratch-project.ts` so this component only
 * ever sees semantically-named fields.
 */
export const ProjectMetadataPanel = React.memo(function ProjectMetadataPanel({
  metadata,
}: ProjectMetadataPanelProps): React.JSX.Element {
  // Width matches the stage so the metadata frame aligns visually.
  const stageWidth = useSettingsStore((s) => s.advanced.stageWidth);

  const instructions = metadata.instructions?.trim() ?? '';
  const notes = metadata.notesAndCredits?.trim() ?? '';

  const hasInstructions = instructions.length > 0;
  const hasNotes = notes.length > 0;
  const hasIntroductions = hasInstructions;

  if (!hasIntroductions && !hasNotes) {
    // Nothing to show — render a thin empty placeholder so the layout
    // doesn't jump around when metadata is sparse.
    return (
      <aside
        aria-label="Project metadata"
        className={cn(
          'rounded-xl border border-border/40 bg-white/90 px-4 py-3 text-left text-xs text-muted-foreground shadow-sm backdrop-blur-sm dark:bg-zinc-900/85',
        )}
        style={{ width: '100%', maxWidth: stageWidth }}
      >
        No project notes available.
      </aside>
    );
  }

  const projectUrl = scratchProjectUrl(metadata.id);
  const authorUsername = metadata.author?.username;

  return (
    <aside
      aria-label="Project metadata"
      data-testid="project-metadata-panel"
      className={cn(
        /*
          The aside itself caps the height so long Notes & Credits /
          Introductions blocks are scrollable instead of pushing the
          page taller. overflow-hidden + flex-col is required so the
          Radix ScrollArea Viewport below can scroll inside the
          fixed-height box (and so the custom scrollbar cannot leak out
          of the rounded border).
        */
        'flex max-h-80 flex-col gap-5 overflow-hidden rounded-xl border border-border/40 bg-white/90 p-4 text-left shadow-sm backdrop-blur-sm sm:max-h-96 sm:p-5 dark:bg-zinc-900/85',
      )}
      style={{ width: '100%', maxWidth: stageWidth }}
    >
      <header className="flex items-baseline justify-between gap-3">
        <a
          href={projectUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open "${metadata.title}" on Scratch`}
          aria-label={`Open project "${metadata.title}" on Scratch`}
          data-testid="metadata-title-link"
          className={cn(
            'rounded-sm text-base font-semibold tracking-tight',
            'underline-offset-4 transition-colors',
            'hover:text-foreground/80 hover:underline',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
        >
          {metadata.title}
        </a>
        {authorUsername && (
          <span className="text-xs text-muted-foreground">
            by{' '}
            <a
              href={scratchProfileUrl(authorUsername)}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${authorUsername}'s Scratch profile`}
              aria-label={`Open Scratch profile for ${authorUsername}`}
              data-testid="metadata-author-link"
              className={cn(
                'rounded-sm underline-offset-4 transition-colors',
                'hover:text-foreground hover:underline',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            >
              {authorUsername}
            </a>
          </span>
        )}
      </header>

      {/*
        ScrollArea wrapper. We rely on the Radix Viewport for scrolling —
        it matches the custom scrollbar treatment used by the Settings
        dialog and Extension Permission dialog (6px track, foreground/10
        at rest, foreground/30 on hover) instead of the browser-default
        scrollbar that `overflow-y-auto` previously produced. The pair
        `min-h-0 h-0 flex-1` lets the ScrollArea shrink below its
        intrinsic content height and grow to fill the parent flex
        column, exactly the same pattern as the two dialogs.

        `flush` skips the default `-translate-x-1.5` inward shift so the
        scrollbar's right edge sits at the content area's right edge —
        the same x-coordinate as the author link in the header above.
        Without `flush`, the bar would land 6px to the left of the
        author name and read as visually misaligned with the title row.
      */}
      <ScrollArea
        className="min-h-0 h-0 flex-1"
        data-testid="project-metadata-scroll-area"
        flush
      >
        <div className="space-y-5 pr-1">
          {hasIntroductions && (
            <Section title="Introductions" testId="metadata-section-introductions">
              <p data-testid="metadata-instructions">{instructions}</p>
            </Section>
          )}

          {hasNotes && (
            <Section title="Notes & Credits" testId="metadata-section-notes">
              <p data-testid="metadata-notes">{notes}</p>
            </Section>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
});
