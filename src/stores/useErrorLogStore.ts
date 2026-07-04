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
  dismiss: (id: string) => void;
  clear: () => void;
}

let counter = 0;

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
  dismiss: (id) =>
    set((state) => ({
      entries: state.entries.filter((e) => e.id !== id),
    })),
  clear: () => set({ entries: [] }),
}));
