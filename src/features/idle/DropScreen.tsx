import * as React from 'react';
import { useProjectLoader } from '@/features/project-loader/useProjectLoader';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { isAllowedFileName } from '@/lib/validation';
import { extractProjectId } from '@/utils/project-id';

export function DropScreen(): React.JSX.Element {
  const { loadById, loadFile } = useProjectLoader();
  const push = useErrorLogStore((s) => s.push);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [projectId, setProjectId] = React.useState<string>('');

  const onSubmitId = React.useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = projectId.trim();
      if (!trimmed) return;
      const extracted = extractProjectId(trimmed);
      if (!extracted) {
        push('error', 'Project ID must be a numeric string or Scratch/TurboWarp URL.');
        return;
      }
      if (extracted !== trimmed) {
        setProjectId(extracted);
      }
      void loadById(extracted);
    },
    [loadById, projectId, push],
  );

  const onFilePickerChange = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file) return;
      if (!isAllowedFileName(file.name)) {
        push('error', `"${file.name}" is not a .sb3 / .sb2 / .sb file.`);
        return;
      }
      await loadFile(file);
      e.target.value = '';
    },
    [loadFile, push],
  );

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-8 py-6 text-center" data-testid="drop-screen">
      <p className="text-sm text-muted-foreground">
        Drag an <span className="font-medium text-foreground">.sb3</span> file anywhere on the page
      </p>

      <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">Or</span>

      <input
        ref={fileInputRef}
        type="file"
        accept=".sb3,.sb2,.sb"
        className="hidden"
        onChange={onFilePickerChange}
      />
      <button
        type="button"
        className="text-sm font-medium text-foreground underline underline-offset-4 transition-opacity hover:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        onClick={() => fileInputRef.current?.click()}
      >
        Select File
      </button>

      <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">Or</span>

      <form onSubmit={onSubmitId} className="flex w-full items-center gap-2" noValidate>
        <label htmlFor="project-id-input" className="sr-only">
          Project ID
        </label>
        <Input
          id="project-id-input"
          type="text"
          inputMode="numeric"
          // No `pattern` here: Scratch / TurboWarp URLs (which we now
          // accept and parse) would otherwise trigger the browser's native
          // "Please match the requested format" popup on submit. Validation
          // is performed in onSubmitId via extractProjectId.
          placeholder="Enter Project ID or paste URL"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project ID"
          className="flex-1"
        />
        <Button type="submit" variant="ghost" disabled={!projectId.trim()}>
          Load
        </Button>
      </form>
    </div>
  );
}