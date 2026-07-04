import * as React from 'react';
import { Hash, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useProjectLoader } from '@/features/project-loader/useProjectLoader';
import { useProjectStore } from '@/stores/useProjectStore';
import { extractProjectId } from '@/utils/project-id';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { executeDebugCommand, isDebugCommand } from '@/features/project-loader/debug-commands';
import { cn } from '@/lib/utils';

export interface ProjectIdInputProps {
  /**
   * Visual width override. When omitted, the input is sized to the
   * configured stage width so it lines up with the stage frame.
   */
  width?: number;
}

/**
 * Compact project-ID input rendered below the runtime stage.
 *
 * Accepts:
 *  - a bare numeric Scratch / TurboWarp project ID
 *  - a full URL (e.g. https://scratch.mit.edu/projects/1334154904 or
 *    https://turbowarp.org/1197296165/editor?fps=48&limitless&hqpen)
 *  - a debug command prefixed with `!` (e.g. `!reset`, `!help`). See
 *    `src/features/project-loader/debug-commands.ts` for the list.
 *
 * On submit the input value is normalized via `extractProjectId` and the
 * extracted ID is used to load the project. Debug commands bypass the
 * loader entirely and run their maintenance action synchronously, then
 * push a feedback message to the error log. The field clears after
 * either kind of successful submit and shows a loading spinner while
 * a real load is in flight.
 */
export function ProjectIdInput({ width }: ProjectIdInputProps): React.JSX.Element {
  const { loadById } = useProjectLoader();
  const loadState = useProjectStore((s) => s.loadState);
  const stageWidth = useSettingsStore((s) => s.advanced.stageWidth);
  const push = useErrorLogStore((s) => s.push);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [value, setValue] = React.useState<string>('');

  const loading = loadState === 'loading';

  const onSubmit = React.useCallback(
    (e: React.FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) return;

      // Debug-command short-circuit: maintainers can type `!help` to
      // discover the available commands. We surface the result through
      // the error log so the same UI shows feedback for both successful
      // and unknown commands. The loader is not invoked.
      if (isDebugCommand(trimmed)) {
        const { message, severity } = executeDebugCommand(trimmed);
        push(severity, message);
        setValue('');
        return;
      }

      const extracted = extractProjectId(trimmed);
      if (extracted && extracted !== trimmed) {
        setValue(extracted);
      }
      // Suppress unhandled-rejection noise: useProjectLoader already routes
      // failures through the error log, so we don't need to handle them here.
      loadById(extracted ?? trimmed)
        .then(() => {
          // Clear on success so the same field can be reused; on failure
          // the field stays populated so the user can correct it.
          if (extracted) setValue('');
        })
        .catch(() => undefined);
    },
    [loadById, push, value],
  );

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      data-testid="project-id-input-form"
      className="flex w-full items-center gap-2"
      style={width ? { maxWidth: width } : { maxWidth: stageWidth }}
    >
      <div className="relative flex-1">
        <Hash
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          placeholder="Enter Project ID, paste URL"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={loading}
          aria-label="Project ID, URL, or debug command"
          data-testid="project-id-input"
          className={cn(
            'h-9 w-full pl-8 pr-3 text-sm',
            'border-border/60 bg-background/70 backdrop-blur',
            loading && 'opacity-60',
          )}
        />
      </div>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={!value.trim() || loading}
        data-testid="project-id-input-load"
        className="h-9 shrink-0 px-4"
      >
        {loading ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Loading
          </>
        ) : (
          'Load'
        )}
      </Button>
    </form>
  );
}
