import * as React from 'react';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertTriangle, AlertCircle, ChevronDown, ChevronUp, X } from 'lucide-react';
import type { ErrorLogEntry, ErrorSeverity } from '@/stores/useErrorLogStore';

export function ErrorLogPanel(): React.JSX.Element {
  const allEntries = useErrorLogStore((s) => s.entries);
  const dismiss = useErrorLogStore((s) => s.dismiss);
  const clear = useErrorLogStore((s) => s.clear);
  const [expanded, setExpanded] = React.useState<boolean>(false);

  // §Phase 7 — surface `warn` and `error` entries. Info entries are
  // still recorded by the store (= `forwardGpuDiagnostics` drops
  // overflow into `info`) but stay invisible because the user only
  // cares about actionable items. The semantics-twconfig warning lands
  // here as a one-shot `warn`, distinct from the `error` count badge.
  const surfaced = React.useMemo(
    () => allEntries.filter((e) => e.severity === 'warn' || e.severity === 'error'),
    [allEntries],
  );
  const errorCount = surfaced.filter((e) => e.severity === 'error').length;
  const warnCount = surfaced.length - errorCount;

  if (surfaced.length === 0) {
    return <div className="h-0" aria-hidden />;
  }

  return (
    <section
      aria-label="Errors"
      className="mx-auto w-full max-w-2xl rounded-lg border border-border/40 bg-background/70 text-xs shadow-sm backdrop-blur"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex items-center gap-2">
          {errorCount > 0 ? (
            <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-yellow-500" />
          )}
          <span className="font-medium text-foreground">
            {summarize(errorCount, warnCount)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {expanded && (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0"
              aria-label="Dismiss all errors"
              onClick={clear}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
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
        </div>
      </header>
      {expanded && (
        <ScrollArea className="max-h-32 border-t border-border">
          <ul className="divide-y divide-border">
            {surfaced.map((e) => (
              <ErrorRow key={e.id} entry={e} onDismiss={dismiss} />
            ))}
          </ul>
        </ScrollArea>
      )}
    </section>
  );
}

function summarize(errorCount: number, warnCount: number): string {
  if (errorCount === 0) {
    return `${warnCount} warning${warnCount === 1 ? '' : 's'}`;
  }
  if (warnCount === 0) {
    return `${errorCount} error${errorCount === 1 ? '' : 's'}`;
  }
  return `${errorCount} error${errorCount === 1 ? '' : 's'} · ${warnCount} warning${warnCount === 1 ? '' : 's'}`;
}

interface ErrorRowProps {
  entry: ErrorLogEntry;
  onDismiss: (id: string) => void;
}

function ErrorRow({ entry, onDismiss }: ErrorRowProps): React.JSX.Element {
  const isError = entry.severity === 'error';
  const iconClass = isError ? 'text-red-500' : 'text-yellow-500';
  const Icon = isError ? AlertTriangle : AlertCircle;
  return (
    <li className="flex items-start gap-2 px-3 py-1.5">
      <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${iconClass}`} />
      <span className="flex-1 break-words text-foreground/90">{entry.message}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 shrink-0"
        aria-label={`Dismiss ${severityLabel(entry.severity)}`}
        onClick={() => onDismiss(entry.id)}
      >
        <X className="h-3 w-3" />
      </Button>
    </li>
  );
}

function severityLabel(severity: ErrorSeverity): string {
  return severity === 'error' ? 'error' : severity === 'warn' ? 'warning' : 'info';
}
