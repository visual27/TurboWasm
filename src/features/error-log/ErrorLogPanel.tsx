import * as React from 'react';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react';

export function ErrorLogPanel(): React.JSX.Element {
  const allEntries = useErrorLogStore((s) => s.entries);
  const dismiss = useErrorLogStore((s) => s.dismiss);
  const [expanded, setExpanded] = React.useState<boolean>(false);

  // Only surface error-severity entries. Info and warn messages are still
  // recorded in the store (push() accepts them) but are filtered out of the
  // visible panel — they don't belong in a viewer-facing "errors" surface.
  const errors = React.useMemo(
    () => allEntries.filter((e) => e.severity === 'error'),
    [allEntries],
  );

  if (errors.length === 0) {
    return <div className="h-0" aria-hidden />;
  }

  return (
    <section
      aria-label="Errors"
      className="mx-auto w-full max-w-2xl rounded-lg border border-border/40 bg-background/70 text-xs shadow-sm backdrop-blur"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
          <span className="font-medium text-foreground">
            {errors.length} error{errors.length === 1 ? '' : 's'}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={expanded ? 'Collapse errors' : 'Expand errors'}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </Button>
      </header>
      {expanded && (
        <ScrollArea className="max-h-32 border-t border-border">
          <ul className="divide-y divide-border">
            {errors.map((e) => (
              <li key={e.id} className="flex items-start gap-2 px-3 py-1.5 text-red-500">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="flex-1 break-words text-foreground/90">{e.message}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0"
                  aria-label="Dismiss error"
                  onClick={() => dismiss(e.id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </section>
  );
}
