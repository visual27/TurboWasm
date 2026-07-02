import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface LoadingProgressProps {
  /**
   * Number of asset requests that have finished loading. When the Scaffolding
   * is between assets, this is the last reported finished count.
   */
  finished: number;
  /**
   * Total number of asset requests that need to complete. 0 means the
   * loader has not yet reported a total (indeterminate state).
   */
  total: number;
  /**
   * What triggered the load, e.g. "Loading project…" / "Loading assets…".
   */
  label?: string;
  /**
   * Optional class for the outer wrapper.
   */
  className?: string;
}

/**
 * Asset loading progress overlay shown on top of the stage area while a
 * project is being loaded.
 *
 * Layout:
 *  ┌────────────────────────────┐
 *  │ ◐ Loading assets…  42 / 87 │
 *  │ ████████░░░░░░░░░░░░░░░░░░ │
 *  └────────────────────────────┘
 *
 * When `total === 0` we render an indeterminate spinner with a generic
 * "Loading project…" label. The bar is a single absolutely positioned div
 * sized in percent so it survives the parent having `overflow: hidden` on
 * the stage frame.
 */
export function LoadingProgress({
  finished,
  total,
  label,
  className,
}: LoadingProgressProps): React.JSX.Element {
  const ratio = total > 0 ? Math.min(1, finished / total) : 0;
  const percent = total > 0 ? Math.round(ratio * 100) : null;
  const isIndeterminate = total <= 0;
  const text = label ?? (isIndeterminate ? 'Loading project…' : 'Loading assets…');

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="loading-progress"
      data-finished={finished}
      data-total={total}
      className={cn(
        'pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/70 text-foreground backdrop-blur-sm',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {isIndeterminate ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        <span>{text}</span>
        {!isIndeterminate && (
          <span className="tabular-nums text-muted-foreground">
            {finished} / {total}
            {percent !== null ? ` (${percent}%)` : ''}
          </span>
        )}
      </div>
      <div className="h-1.5 w-64 overflow-hidden rounded-full bg-foreground/10">
        {isIndeterminate ? (
          <div
            className="h-full w-1/3 animate-[loading-bar_1.2s_ease-in-out_infinite] rounded-full bg-foreground/60"
            style={{ animationName: 'loading-bar' }}
          />
        ) : (
          <div
            className="h-full rounded-full bg-foreground/60 transition-[width] duration-150"
            style={{ width: `${Math.max(2, ratio * 100)}%` }}
          />
        )}
      </div>
    </div>
  );
}