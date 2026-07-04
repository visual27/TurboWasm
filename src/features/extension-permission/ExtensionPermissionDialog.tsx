import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Label } from '@/components/ui/label';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { ExtensionSandboxMode } from '@/types/settings';
import {
  setExtensionPermissionRequest,
  type ExtensionPermissionDecision,
  type ExtensionPromptEntry,
} from '@/runtime/player';
import { cn } from '@/lib/utils';

interface SandboxOption {
  value: ExtensionSandboxMode;
  label: string;
  description: string;
}

const SANDBOX_OPTIONS: ReadonlyArray<SandboxOption> = [
  {
    value: 'worker',
    label: 'Worker (recommended)',
    description: 'Runs the extension inside a Web Worker. Most isolated.',
  },
  {
    value: 'iframe',
    label: 'Iframe',
    description: 'Runs inside a sandboxed same-origin iframe. Historical TurboWarp default.',
  },
  {
    value: 'unsandboxed',
    label: 'Unsandboxed',
    description:
      'Runs the extension inline with full DOM/JS access to the viewer. Use only with trusted projects.',
  },
  {
    value: 'disabled',
    label: 'Disabled',
    description:
      "Do not load any extensions. The project loads normally but extension blocks are unavailable.",
  },
];

interface ResolverState {
  entries: ExtensionPromptEntry[];
  resolve: (decision: ExtensionPermissionDecision) => void;
}

/**
 * Modal that prompts the user to choose which custom extensions to load
 * from a project, and which sandbox mode to run them in.
 *
 * The dialog has no `open` prop of its own — its visibility is driven by
 * the in-component `pending` state, which is populated whenever the
 * runtime invokes the registered permission request. It registers itself
 * with the player on mount and clears the registration on unmount.
 */
export function ExtensionPermissionDialog(): React.JSX.Element {
  const initialSandboxMode = useSettingsStore((s) => s.advanced.extensionSandboxMode);
  const [pending, setPending] = React.useState<ResolverState | null>(null);
  const [selections, setSelections] = React.useState<Record<string, boolean>>({});
  const [sandboxMode, setSandboxMode] = React.useState<ExtensionSandboxMode>(initialSandboxMode);

  // Keep the in-component sandboxMode in sync with the store until the
  // user opens the dialog — at that point we copy the store value into
  // local state so the user's per-load choice doesn't bleed into the
  // next load before they confirm.
  React.useEffect(() => {
    if (pending === null) {
      setSandboxMode(initialSandboxMode);
    }
  }, [initialSandboxMode, pending]);

  const requestRef = React.useRef<
    ((entries: readonly ExtensionPromptEntry[]) => Promise<ExtensionPermissionDecision>) | null
  >(null);

  // Stable callback that closes over the latest state setters.
  requestRef.current = (entries) => {
    return new Promise<ExtensionPermissionDecision>((resolve) => {
      const initialSelections: Record<string, boolean> = {};
      for (const e of entries) {
        initialSelections[e.url] = true;
      }
      setSelections(initialSelections);
      setSandboxMode(useSettingsStore.getState().advanced.extensionSandboxMode);
      setPending({ entries: [...entries], resolve });
    });
  };

  React.useEffect(() => {
    setExtensionPermissionRequest((entries) => {
      const cb = requestRef.current;
      if (!cb) {
        // Defensive: if the dialog unmounted between mount and the next
        // load, deny everything rather than hanging the load forever.
        return Promise.resolve({
          allowedUrls: new Set<string>(),
          sandboxMode: 'worker',
          sessionDeniedUrls: entries.map((e) => e.url),
        });
      }
      return cb(entries);
    });
    return () => setExtensionPermissionRequest(null);
  }, []);

  const close = React.useCallback((decision: ExtensionPermissionDecision): void => {
    setPending((current) => {
      if (current) current.resolve(decision);
      return null;
    });
  }, []);

  const onToggle = React.useCallback((url: string, next: boolean): void => {
    setSelections((prev) => ({ ...prev, [url]: next }));
  }, []);

  // When `disabled` is the active sandbox mode the per-URL toggles have
  // no effect (the player strips every extension from the project before
  // the VM sees it). Force all rows to "off" and disable the switches
  // so the user is not misled.
  const effectiveSelections = React.useMemo<Record<string, boolean>>(() => {
    if (sandboxMode !== 'disabled') return selections;
    return Object.fromEntries(pending ? pending.entries.map((e) => [e.url, false]) : []);
  }, [selections, sandboxMode, pending]);
  const rowsDisabled = sandboxMode === 'disabled';

  const onDenyAll = React.useCallback((): void => {
    if (!pending) return;
    close({
      allowedUrls: new Set<string>(),
      sandboxMode,
      sessionDeniedUrls: pending.entries.map((e) => e.url),
    });
  }, [pending, sandboxMode, close]);

  const onAllowSelected = React.useCallback((): void => {
    if (!pending) return;
    // When sandbox mode is `disabled` every URL is denied regardless
    // of which Allow button the user clicked — the per-URL switches
    // are forced off and the runtime strips extensions regardless.
    if (sandboxMode === 'disabled') {
      close({
        allowedUrls: new Set<string>(),
        sandboxMode,
        sessionDeniedUrls: pending.entries.map((e) => e.url),
      });
      return;
    }
    const allowedUrls = new Set<string>();
    const denied: string[] = [];
    for (const e of pending.entries) {
      if (selections[e.url]) allowedUrls.add(e.url);
      else denied.push(e.url);
    }
    close({ allowedUrls, sandboxMode, sessionDeniedUrls: denied });
  }, [pending, selections, sandboxMode, close]);

  const onAllowAll = React.useCallback((): void => {
    if (!pending) return;
    // When sandbox mode is `disabled` the per-URL toggles are forced
    // off and `Allow all` is equivalent to `Deny all` for the URLs —
    // see onAllowSelected above.
    if (sandboxMode === 'disabled') {
      close({
        allowedUrls: new Set<string>(),
        sandboxMode,
        sessionDeniedUrls: pending.entries.map((e) => e.url),
      });
      return;
    }
    close({
      allowedUrls: new Set(pending.entries.map((e) => e.url)),
      sandboxMode,
      sessionDeniedUrls: [],
    });
  }, [pending, sandboxMode, close]);

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && pending) {
          // Esc / overlay click → equivalent to Deny All.
          onDenyAll();
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden p-0">
        {pending && (
          <>
            <DialogHeader className="px-8 pb-2 pt-8">
              <DialogTitle>Allow custom extensions</DialogTitle>
              <DialogDescription>
                This project requests the following extensions. Choose which to load and how to run
                them. Allowed extensions are remembered for future loads.
              </DialogDescription>
            </DialogHeader>
            <Separator />

            {/*
              ScrollArea wrapper. We rely on the Radix Viewport for
              scrolling — the dialog's flex column lays out header /
              ScrollArea / footer, and `min-h-0 h-0 flex-1` lets the
              ScrollArea shrink below its intrinsic content height and
              grow to fill the parent. The inner div deliberately does
              NOT also use `overflow-y-auto`: the double-scrollbar
              pattern previously left both layers un-scrollable because
              the Viewport and the inner div would each grow to match
              their content height, leaving scrollHeight === clientHeight
              on both.
            */}
            <ScrollArea className="min-h-0 h-0 flex-1">
              <div className="flex flex-col gap-3 px-8 py-5">
                <div className="flex flex-col gap-2">
                  {pending.entries.map((entry) => (
                    <ExtensionRow
                      key={entry.url}
                      entry={entry}
                      checked={Boolean(effectiveSelections[entry.url])}
                      disabled={rowsDisabled}
                      onToggle={onToggle}
                    />
                  ))}
                </div>

                <Separator className="my-4" />

                <div className="flex flex-col gap-3">
                  <div>
                    <Label className="text-sm">Sandbox mode</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      How the allowed extensions are executed. Applies to this load and future
                      loads.
                    </p>
                  </div>
                  <div
                    className="flex flex-col gap-2"
                    role="radiogroup"
                    aria-label="Extension sandbox mode"
                  >
                    {SANDBOX_OPTIONS.map((opt) => {
                      const checked = sandboxMode === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          onClick={() => setSandboxMode(opt.value)}
                          className={cn(
                            'rounded-md border px-4 py-3 text-left text-sm transition-colors',
                            checked
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:bg-muted/40',
                          )}
                          data-testid={`permission-sandbox-mode-${opt.value}`}
                        >
                          <div className="font-medium">{opt.label}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {opt.description}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </ScrollArea>

            <Separator />
            <DialogFooter className="flex-row justify-between gap-2 px-8 pb-6 pt-4 sm:justify-between sm:space-x-2">
              <Button variant="outline" onClick={onDenyAll} data-testid="permission-deny-all">
                Deny all
              </Button>
              <div className="flex flex-row gap-2">
                <Button
                  variant="secondary"
                  onClick={onAllowSelected}
                  data-testid="permission-allow-selected"
                >
                  Allow selected
                </Button>
                <Button variant="default" onClick={onAllowAll} data-testid="permission-allow-all">
                  Allow all
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ExtensionRowProps {
  entry: ExtensionPromptEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: (url: string, next: boolean) => void;
}

const ExtensionRow = React.memo(function ExtensionRow({
  entry,
  checked,
  disabled,
  onToggle,
}: ExtensionRowProps): React.JSX.Element {
  const onCheckedChange = React.useCallback(
    (next: boolean): void => {
      if (disabled) return;
      onToggle(entry.url, next);
    },
    [entry.url, onToggle, disabled],
  );
  const urlLabel = entry.url.length > 56 ? `${entry.url.slice(0, 53)}…` : entry.url;
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 rounded-md border px-4 py-3 transition-colors',
        disabled
          ? 'border-border/30 bg-muted/30 opacity-60'
          : 'border-border/60 bg-card/30',
      )}
      data-testid={`permission-row-${entry.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={entry.id}>
          {entry.id}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground" title={entry.url}>
          {urlLabel}
        </div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={`Allow ${entry.id}`}
        data-testid={`permission-switch-${entry.id}`}
      />
    </div>
  );
});
