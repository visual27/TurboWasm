import { create } from 'zustand';

export type ErrorSeverity = 'info' | 'warn' | 'error';

export interface ErrorLogEntry {
  id: string;
  severity: ErrorSeverity;
  message: string;
  ts: number;
  visible: boolean;
}

export interface ErrorLogState {
  entries: ErrorLogEntry[];
  push: (severity: ErrorSeverity, message: string) => void;
  /**
   * §Phase 7 — push a warning exactly once per `dedupKey`. The first
   * call inserts the entry; subsequent calls with the same `dedupKey`
   * are no-ops. Used by the runtime to surface a single warning when
   * a project twconfig flips `semantics.preset` to a non-Scratch
   * preset, even if the same project is loaded repeatedly or the
   * twconfig is re-applied. The dedup key is intentionally not the
   * `message` string (= callers want distinct messages sharing one
   * dedup bucket, e.g. all preset-flips sharing the
   * `[semantics] preset-applied` bucket).
   */
  pushOnce: (severity: ErrorSeverity, message: string, dedupKey: string) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

let counter = 0;
const pushedOnceKeys = new Set<string>();

export const useErrorLogStore = create<ErrorLogState>((set) => ({
  entries: [],
  push: (severity, message) => {
    counter += 1;
    const id = `err-${Date.now()}-${counter}`;
    set((state) => ({
      entries: [...state.entries, { id, severity, message, ts: Date.now(), visible: true }].slice(
        -20,
      ),
    }));
  },
  pushOnce: (severity, message, dedupKey) => {
    if (pushedOnceKeys.has(dedupKey)) return;
    pushedOnceKeys.add(dedupKey);
    counter += 1;
    const id = `err-${Date.now()}-${counter}`;
    set((state) => ({
      entries: [...state.entries, { id, severity, message, ts: Date.now(), visible: true }].slice(
        -20,
      ),
    }));
  },
  dismiss: (id) =>
    set((state) => ({
      entries: state.entries.filter((e) => e.id !== id),
    })),
  clear: () => set({ entries: [] }),
}));

/**
 * §Phase 7 — clear the dedup bucket so a project reload that
 * legitimately needs to re-warn (= e.g. user changed `semantics.preset`
 * from `'scratch'` to `'full-js'` then back to `'scratch'`) starts
 * fresh. Tests can call this between cases to avoid bleed-over.
 */
export function __resetErrorLogOnceForTesting(): void {
  pushedOnceKeys.clear();
}
