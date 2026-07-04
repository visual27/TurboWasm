import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePlayerStore } from '@/stores/usePlayerStore';

export interface LoadingProgressProps {
  /**
   * Optional explicit override for the `finished` count. When omitted, the
   * component subscribes directly to `usePlayerStore.assetProgress` so the
   * parent does not need to re-render on every Scaffolding `ASSET_PROGRESS`
   * event.
   */
  finished?: number;
  /**
   * Optional explicit override for the `total` count. See `finished`.
   */
  total?: number;
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
 * Subscribes directly to `usePlayerStore` for `assetProgress` so the parent
 * (`App`) does not need to re-render on every `ASSET_PROGRESS` event from
 * Scaffolding. Callers can still pass explicit `finished` / `total` props
 * to override the store value (e.g. for tests or non-store-driven state).
 *
 * Layout:
 *  ┌────────────────────────────┐
 *  │ ◐ Loading assets…           │
 *  │ ████████░░░░░░░░░░░░░░░░░░ │
 *  │   42 / 87 (48%)            │
 *  └────────────────────────────┘
 *
 * When `total === 0` we render an indeterminate spinner with a generic
 * "Loading project…" label. The bar is a single absolutely positioned div
 * sized in percent so it survives the parent having `overflow: hidden` on
 * the stage frame.
 */
export const LoadingProgress = React.memo(function LoadingProgress({
  finished: finishedProp,
  total: totalProp,
  label,
  className,
}: LoadingProgressProps): React.JSX.Element {
  // Subscribe with primitive selectors so this component re-renders only
  // when the actual numbers change (Zustand uses Object.is by default).
  const storeFinished = usePlayerStore((s) => s.assetProgress.finished);
  const storeTotal = usePlayerStore((s) => s.assetProgress.total);
  const finished = finishedProp ?? storeFinished;
  const total = totalProp ?? storeTotal;
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
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{text}</span>
      </div>
      <div className="h-1.5 w-64 overflow-hidden rounded-full bg-foreground/10">
        {isIndeterminate ? (
          <div
            className="h-1/3 w-1/3 rounded-full bg-foreground/60"
            style={{
              animation: 'loading-bar 1.2s ease-in-out infinite',
            }}
          />
        ) : (
          <div
            className="h-full rounded-full bg-foreground/60 transition-[width] duration-150"
            style={{ width: `${Math.max(2, ratio * 100)}%` }}
          />
        )}
      </div>
      {!isIndeterminate && (
        <div className="text-xs tabular-nums text-muted-foreground/70">
          {finished} / {total}
          {percent !== null ? ` (${percent}%)` : ''}
        </div>
      )}
    </div>
  );
});
