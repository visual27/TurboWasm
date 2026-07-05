import * as React from 'react';
import { cn } from '@/lib/utils';
import type { LinkifySegment } from '@/utils/linkify';
import { scratchProfileUrl } from '@/utils/linkify';

export interface LinkedTextProps {
  segments: readonly LinkifySegment[];
}

/**
 * Render a sequence of linkified text segments as alternating plain text
 * and outbound anchor tags.
 *
 * - Plain text spans render into a `<span>` so the layout behaves like
 *   continuous text (line-breaks, surrounding content, `<p>`/`whitespace-
 *   pre-wrap` inherited from the parent all still flow correctly).
 * - URL segments render into an `<a target="_blank">` with
 *   `rel="noopener noreferrer"` (matches the convention used by the panel
 *   header and elsewhere in the app for outbound links).
 * - Mention segments render into an `<a>` pointing at the canonical
 *   Scratch profile URL and use the same `target`/`rel` treatment as
 *   regular URL links.
 *
 * Both link variants show a solid underline only on hover and on
 * keyboard focus — the rest state is left unadorned so the project
 * notes read as continuous prose, while the hover/focus affordance
 * remains explicit. Tailwind's `underline` is a solid line by default
 * (`no-underline` opts out of the rest-state line, and `hover:underline`
 * / `focus-visible:underline` restore it on interaction).
 *
 * Keys are positional — linkified segments are derived from a single
 * static string per render and the `linkify` helper guarantees
 * monotonically increasing start indices, so index keys are stable
 * enough for React reconciliation without risking DOM churn.
 */
export function LinkedText({ segments }: LinkedTextProps): React.JSX.Element {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.text}</span>;
        }
        if (segment.type === 'url') {
          return (
            <a
              key={index}
              href={segment.href}
              target="_blank"
              rel="noopener noreferrer"
              title={segment.href}
              aria-label={`Open ${segment.text} in a new tab`}
              data-testid="metadata-link"
              className={cn(
                'cursor-pointer rounded-sm no-underline underline-offset-4 transition-colors',
                'hover:underline focus-visible:underline',
                'hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            >
              {segment.text}
            </a>
          );
        }
        // segment.type === 'mention'
        return (
          <a
            key={index}
            href={scratchProfileUrl(segment.username)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${segment.username}'s Scratch profile`}
            aria-label={`Open Scratch profile for ${segment.username}`}
            data-testid="metadata-mention"
            data-mention-username={segment.username}
            className={cn(
              'cursor-pointer rounded-sm no-underline underline-offset-4 transition-colors',
              'hover:underline focus-visible:underline',
              'hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            )}
          >
            {segment.text}
          </a>
        );
      })}
    </>
  );
}
