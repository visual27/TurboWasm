/**
 * Forward GPU kernel pipeline diagnostics into the global ErrorLog store.
 *
 * §Phase 5 §15.9 / §15.14 — the previous `player.ts:bootstrapGpuKernels`
 * loop walked `RegionVerdict.diagnostics` only, dropped `severity: 'error'`
 * entries on the floor, and never touched emitter-time diagnostics. Both
 * gaps closed here:
 *
 *   - `severity: 'error'` entries are pushed uncondensed (the
 *     `ErrorLogPanel` filters on `severity === 'error'` so a cap here
 *     would only delay the user-visible signal).
 *   - Emitter diagnostics emitted from `initializeGpuKernels` are
 *     forwarded through the same path, with a dedicated 5-entry warn
 *     cap so the panel stays below the existing `defaultMaxLogs=5`
 *     bound per source (parser/D1/D2/D3 vs emitter).
 *
 * The function is side-effect-only on the ErrorLog store; it does not
 * mutate the input diagnostics array and is safe to call from both the
 * M3 verdict-walker and the M5 emitter-walker.
 */
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { Diagnostic } from './types';

export interface ForwardGpuDiagnosticsOptions {
  /**
   * Optional cap on the number of `warn`-severity entries that retain
   * `warn` severity in the panel. Entries beyond the cap are demoted
   * to `info`. Defaults to `5` to match the legacy `REGION_DIAG_CAP`
   * preserved by the Phase 5 call sites. Each source (M3 verdict vs
   * M5 emitter) keeps its own counter — the cap is per-call, not
   * shared.
   */
  readonly warnCap?: number;
  /**
   * Optional override for the store push target. Defaults to
   * `useErrorLogStore`. Tests can pass a stub that records the
   * `(severity, message)` tuples without writing through the Zustand
   * store.
   */
  readonly push?: (severity: 'info' | 'warn' | 'error', message: string) => void;
}

export interface ForwardGpuDiagnosticsSummary {
  /** Total number of diagnostics pushed in this call. */
  readonly total: number;
  /** Number of entries pushed at `warn` severity (= under the cap). */
  readonly warned: number;
  /** Number of entries pushed at `info` severity (= warns past the cap + raw infos). */
  readonly infoed: number;
  /** Number of entries pushed at `error` severity (uncapped). */
  readonly errored: number;
  /** Number of diagnostics skipped because they were already forwarded by an earlier call. */
  readonly skipped: number;
}

const DEFAULT_WARN_CAP = 5;

/**
 * Format a `Diagnostic` for the ErrorLog message slot. The bracket
 * prefix matches the existing format emitted by `player.ts` so log
 * greps that look for `[gpu.diagnostic] ...` keep working.
 */
export function formatGpuDiagnosticMessage(diagnostic: Diagnostic): string {
  const code = diagnostic.code && diagnostic.code.length > 0 ? diagnostic.code : 'gpu.diagnostic';
  const regionTag =
    diagnostic.regionId && diagnostic.regionId.length > 0 ? ` region=${diagnostic.regionId}` : '';
  return `[${code}${regionTag}] ${diagnostic.message}`;
}

/**
 * Forward diagnostics into the ErrorLog store.
 *
 * Behaviour matrix:
 *   - severity `error`  → push at `error`, uncapped
 *   - severity `warn`   → push at `warn` while `warned < warnCap`;
 *                          thereafter demote to `info`
 *   - severity `info`   → push at `info`, uncapped
 *
 * Returns counts so callers (tests) can assert how many entries landed.
 */
export function forwardGpuDiagnostics(
  diagnostics: readonly Diagnostic[],
  options: ForwardGpuDiagnosticsOptions = {},
): ForwardGpuDiagnosticsSummary {
  const warnCap = options.warnCap ?? DEFAULT_WARN_CAP;
  const push = options.push ?? ((severity, message): void => {
    useErrorLogStore.getState().push(severity, message);
  });

  let warned = 0;
  let infoed = 0;
  let errored = 0;
  for (const d of diagnostics) {
    const message = formatGpuDiagnosticMessage(d);
    if (d.severity === 'error') {
      push('error', message);
      errored += 1;
    } else if (d.severity === 'warn') {
      if (warned < warnCap) {
        push('warn', message);
        warned += 1;
      } else {
        push('info', message);
        infoed += 1;
      }
    } else if (d.severity === 'info') {
      push('info', message);
      infoed += 1;
    }
  }
  return {
    total: errored + warned + infoed,
    warned,
    infoed,
    errored,
    skipped: 0,
  };
}
