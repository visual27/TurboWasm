import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Check, ChevronsUpDown } from 'lucide-react';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

export interface SelectFieldProps<T extends string> {
  id: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Lightweight Select primitive built on top of Radix Popover (no
 * additional dependency). Used by the Settings dialog for the
 * Performance Mode dropdown. Keeps the existing shadcn-style surface
 * (Trigger + Content) so visual style matches the rest of the dialog.
 */
export function SelectField<T extends string>({
  id,
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  className,
}: SelectFieldProps<T>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'inline-flex h-9 items-center justify-between gap-1.5 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
            'ring-offset-background placeholder:text-muted-foreground',
            'focus:outline-none focus:ring-1 focus:ring-ring focus:ring-offset-1',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'hover:bg-accent hover:text-accent-foreground',
            className,
          )}
        >
          <span className="truncate">{current ? current.label : value}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] min-w-[12rem] p-1"
        align="end"
      >
        <ul role="listbox" aria-label={ariaLabel} className="max-h-72 overflow-auto">
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                    'hover:bg-accent hover:text-accent-foreground',
                    'focus:outline-none focus:bg-accent focus:text-accent-foreground',
                    selected && 'bg-accent/40',
                  )}
                >
                  <Check
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      selected ? 'opacity-100' : 'opacity-0',
                    )}
                    aria-hidden
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{opt.label}</span>
                    {opt.description && (
                      <span className="text-xs text-muted-foreground">
                        {opt.description}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
