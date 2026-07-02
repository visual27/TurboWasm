import * as React from 'react';
import type { ProjectMetadata } from '@/types/project';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { cn } from '@/lib/utils';

export interface ProjectMetadataPanelProps {
  metadata: ProjectMetadata;
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h3>
      <div className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">{children}</div>
    </section>
  );
}

/**
 * Project metadata viewer — renders the fields returned by the Scratch /
 * Trampoline API as two top-level sections, in the same order as
 * turbowarp.org's project page:
 *
 *   1. Introductions   — combines metadata.description and
 *      metadata.instructions. Either or both may be present; the section
 *      is hidden when both are empty.
 *   2. Notes & Credits — metadata.notesAndCredits.
 *
 * Within the Introductions section, Description appears first, then
 * Instructions, mirroring the same field order that the Scratch website
 * uses. The Notes & Credits section is always rendered below.
 */
export function ProjectMetadataPanel({ metadata }: ProjectMetadataPanelProps): React.JSX.Element {
  // Width matches the stage so the metadata frame aligns visually.
  const stageWidth = useSettingsStore((s) => s.advanced.stageWidth);

  const hasDescription = Boolean(metadata.description && metadata.description.trim().length > 0);
  const hasInstructions = Boolean(
    metadata.instructions && metadata.instructions.trim().length > 0,
  );
  const hasNotes = Boolean(
    metadata.notesAndCredits && metadata.notesAndCredits.trim().length > 0,
  );
  const hasIntroductions = hasDescription || hasInstructions;

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

  return (
    <aside
      aria-label="Project metadata"
      data-testid="project-metadata-panel"
      className={cn(
        'flex flex-col gap-5 rounded-xl border border-border/40 bg-white/90 p-4 text-left shadow-sm backdrop-blur-sm sm:p-5 dark:bg-zinc-900/85',
      )}
      style={{ width: '100%', maxWidth: stageWidth }}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">{metadata.title}</h2>
        {metadata.author?.username && (
          <span className="text-xs text-muted-foreground">by {metadata.author.username}</span>
        )}
      </header>

      <div className="max-h-80 space-y-5 overflow-y-auto pr-1 sm:max-h-96">
        {/* 1. Introductions (top) */}
        {hasIntroductions && (
          <Section title="Introductions">
            {hasDescription && <p>{metadata.description}</p>}
            {hasDescription && hasInstructions && <div aria-hidden className="h-2" />}
            {hasInstructions && <p>{metadata.instructions}</p>}
          </Section>
        )}

        {/* 2. Notes & Credits (bottom) */}
        {hasNotes && <Section title="Notes &amp; Credits">{metadata.notesAndCredits}</Section>}
      </div>
    </aside>
  );
}