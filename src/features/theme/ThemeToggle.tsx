import * as React from 'react';
import { Check, Monitor, Moon, Sun, Upload } from 'lucide-react';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useProjectLoader } from '@/features/project-loader/useProjectLoader';
import { isAllowedFileName } from '@/lib/validation';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { Theme } from '@/types/settings';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const OPTIONS: ReadonlyArray<{
  value: Theme;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

function ThemeIcon({ value, className }: { value: Theme; className?: string }): React.JSX.Element {
  const opt = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]!;
  const Icon = opt.icon;
  return <Icon className={className} />;
}

export interface ThemeToggleProps {
  /**
   * Optional class for the outer container — useful for the top bar layout.
   */
  className?: string;
}

/**
 * Theme selector (vertical dropdown) + an upload button on its right side.
 *
 * Layout:
 *   [Theme button (▼)] [Upload button]
 *
 * Clicking the theme button opens a vertical dropdown with System / Light /
 * Dark options. Clicking the upload button opens a hidden file picker
 * (accepts .sb3 / .sb2 / .sb) and runs the same loadFile flow as the
 * initial drop screen. Having the upload button next to the theme toggle
 * means a user can always load a new file from anywhere in the app, not
 * only from the initial drop screen.
 */
export function ThemeToggle({ className }: ThemeToggleProps): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const { loadFile } = useProjectLoader();
  const push = useErrorLogStore((s) => s.push);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const onUploadClick = React.useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  const onFileChange = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file) return;
      if (!isAllowedFileName(file.name)) {
        push('error', `"${file.name}" is not a .sb3 / .sb2 / .sb file.`);
        return;
      }
      try {
        await loadFile(file);
      } finally {
        // Reset the input so selecting the same file twice fires onChange.
        e.target.value = '';
      }
    },
    [loadFile, push],
  );

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Theme: ${theme}`}
                data-testid="theme-toggle-trigger"
                className="h-8 w-8 rounded-full"
              >
                <ThemeIcon value={theme} className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Theme</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-40 p-1">
          <div role="radiogroup" aria-label="Color theme" className="flex flex-col">
            {OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`theme-option-${opt.value}`}
                  onClick={() => setTheme(opt.value)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    'hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    active && 'bg-foreground/10 text-foreground font-medium',
                    !active && 'text-muted-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="flex-1">{opt.label}</span>
                  {active && <Check className="h-3.5 w-3.5" />}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Upload a new SB3 file"
            data-testid="upload-trigger"
            onClick={onUploadClick}
            className="h-8 w-8 rounded-full"
          >
            <Upload className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Upload SB3</TooltipContent>
      </Tooltip>

      <input
        ref={fileInputRef}
        type="file"
        accept=".sb3,.sb2,.sb"
        className="hidden"
        onChange={onFileChange}
        data-testid="upload-input"
      />
    </div>
  );
}