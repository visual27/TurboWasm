/**
 * §Phase 3 (nested-parallelization-04-phase3 §3.6.3) — JS-side dispatch
 * formula evaluator.
 *
 * The WGSL emitter's `computeDispatchPlan` returns WGSL expression
 * strings like `"ceil(aabb_h[aabb_idx0] / 64)"`. The runtime dispatcher
 * must evaluate these to numeric dispatch extents for
 * `pass.dispatchWorkgroups(x, y, z)`. This module is a tiny host-side
 * evaluator that handles the subset of WGSL syntax that can appear in a
 * dispatch formula:
 *
 *   - scalar uniform references: `<scalar_name>` (where `<scalar_name>`
 *     matches a `ScalarUniformBinding.name`) → `scalarValues.get(name)`
 *   - list length references: `u_scratch.<list>_length` → `listLength(<list>)`
 *   - list element reads: `scratch_list_read_f32/i32/byte(&<list>,
 *     scratch_index_clamp(<idx>, <len>), <len>)` → `readList(...)[clamped_idx]`
 *   - formula sugar: `len(<list>)` → `listLength(<list>)`
 *   - WGSL helpers: `scratch_div(a, b)` → `a / b`, `scratch_mod(a, b)` →
 *     `((a % b) + b) % b`, `scratch_index_clamp(idx, len)` →
 *     `Math.max(0, Math.min(idx, len - 1))`
 *   - math: `ceil(x)` → `Math.ceil(x)`, `max(a, b, ...)` → `Math.max(...)`
 *   - bare storage references: `&<storage>` → `listLength(<storage>)`
 *
 * The output of `evaluateDispatchFormula` is a JS number suitable for
 * `clampDispatchExtent`'s clamping.
 *
 * Errors / edge cases:
 *   - scalar name referenced but no value in `scalarValues` → 0
 *     (defensive: kernel would be D4-demoted upstream anyway).
 *   - list name not found in `readList` → 0 (defensive; the runtime
 *     adapter returns null/empty for unknown names).
 *   - `Function(...)` throws SyntaxError → 0 (we emit a single
 *     `gpu.dispatch_formula_eval_failed` warn via the error log store
 *     so users can debug).
 *   - non-finite result (NaN / Infinity) → 0 (caller's `clampDispatchExtent`
 *     would have clamped it to 1 anyway; returning 0 keeps the contract
 *     uniform).
 */
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import type { ScalarUniformBinding } from './scalar-uniform-binding';

/**
 * The runtime hooks needed to resolve a dispatch formula. `scalarValues`
 * is decoupled from `scalarBindings` so the dispatcher can refresh
 * values per dispatch without rebuilding the binding metadata.
 */
export interface DispatchFormulaContext {
  /** Static scalar binding metadata (name + wgslName + dtype). */
  scalarBindings: readonly ScalarUniformBinding[];
  /** Runtime scalar values keyed by `ScalarUniformBinding.name`. */
  scalarValues: ReadonlyMap<string, number>;
  /** Host runtime list length hook. */
  listLength(name: string): number;
  /** Host runtime list element read hook. Returns null when the list is unknown. */
  readList(
    name: string,
    length: number,
    dtype: 'f32' | 'i32' | 'byte',
  ): Float32Array | Int32Array | Uint8Array | null;
}

// Sentinel dtype used by the JIT-compiled evaluator; the WGSL emitter
// emits `scratch_list_read_f32` / `scratch_list_read_i32` / `scratch_list_read_u32`.
// `scratch_list_read_u32` is the ABI name for the `byte` dtype (host
// `Uint8Array` ↔ WGSL `array<u32>` 2-step representation — see
// `list-buffer-binding.ts:packBytesToU32`).
type ReadListDtype = 'f32' | 'i32' | 'byte';

/**
 * Evaluate a WGSL dispatch formula string against runtime values.
 *
 * Returns 0 on any unrecoverable evaluation failure (missing scalar,
 * unknown list, syntax error, non-finite result). The caller
 * (`__dispatch-kernel-sync.ts`) feeds the result into
 * `clampDispatchExtent` which clamps to ≥ 1 and to the device's
 * `maxComputeWorkgroupsPerDimension` ceiling.
 *
 * The evaluator uses `new Function('return ' + reducedExpr)` for the
 * final numeric reduction step. This is safe because the input is
 * WGSL syntax produced by the emitter (no user-controlled code
 * reaches the runtime unless the emitter itself was bypassed; in
 * that case the kernel is already D4-demoted upstream).
 */
export function evaluateDispatchFormula(
  expr: string,
  context: DispatchFormulaContext,
): number {
  let reduced = expr.trim();
  if (reduced === '') return 0;

  // Order matters: list-read → scalar → list length → sugar → math
  // helpers. Each pass may produce a string that another pass can
  // further reduce.
  reduced = reduceListReads(reduced, context);
  reduced = reduceStorageRefs(reduced, context);
  reduced = reduceListLengthRefs(reduced, context);
  reduced = reduceLenSugar(reduced, context);
  reduced = reduceScalarNames(reduced, context);
  reduced = reduceMathHelpers(reduced);

  // Strip stray `&` left over from `scratch_list_read_*(&list, ...)`
  // reductions (defensive — should already be consumed).
  reduced = reduced.replace(/&([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const len = safeListLength(name, context);
    return String(len);
  });

  let value: number;
  try {
    // eslint-disable-next-line no-new-func
    value = Function(`"use strict"; return (${reduced});`)() as number;
  } catch (err) {
    useErrorLogStore
      .getState()
      .push(
        'warn',
        `gpu.dispatch_formula_eval_failed: ${truncate(reduced, 64)} (${err instanceof Error ? err.message : String(err)})`,
      );
    return 0;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value;
}

// --- reducers --------------------------------------------------------------

/**
 * Reduce `scratch_list_read_<dtype>(&<list>, scratch_index_clamp(<idx>, <len>), <len>)`
 * to a host-side numeric value. The `<idx>` may itself contain nested
 * calls — handle by recursively evaluating the index expression with
 * `evaluateDispatchFormula` (which strips its own list reads etc.).
 *
 * `<dtype>` is one of `f32` | `i32` | `u32`. `u32` is the ABI name for
 * the byte-ABI binding (see `list-buffer-binding.ts`).
 */
function reduceListReads(expr: string, context: DispatchFormulaContext): string {
  return expr.replace(
    /scratch_list_read_(f32|i32|u32)\s*\(\s*&\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([^,()]+(?:\([^)]*\)[^,()]*)*)\s*,\s*([^,()]+(?:\([^)]*\)[^,()]*)*)\s*\)/g,
    (_match, dtypeRaw: string, listName: string, idxExpr: string, _lenExpr: string) => {
      const dtype: ReadListDtype = dtypeRaw === 'i32' ? 'i32' : dtypeRaw === 'u32' ? 'byte' : 'f32';
      const len = safeListLength(listName, context);
      const rawIdx = evaluateDispatchFormula(idxExpr, context);
      const clampedIdx = Math.max(0, Math.min(Math.floor(rawIdx), Math.max(0, len - 1)));
      const data = context.readList(listName, len, dtype);
      if (!data || clampedIdx >= data.length) return '0';
      // `noUncheckedIndexedAccess`: typed-array access returns `T | undefined`.
      // Fall back to 0 so the eventual `Function(...)` reducer evaluates to
      // a definite numeric literal (rather than `"undefined"`).
      const raw = data[clampedIdx] ?? 0;
      // Keep integer dtype's numeric literal as an integer literal so the
      // final Function(...) eval produces an integer (not a float with
      // rounding noise). f32 keeps its float representation.
      return dtype === 'f32' ? String(raw) : String(raw | 0);
    },
  );
}

/**
 * Reduce bare storage references (`&<storage>`) to the host list length.
 * Used as a defensive fallback after `scratch_list_read_*` reduction has
 * already stripped the explicit calls.
 */
function reduceStorageRefs(expr: string, context: DispatchFormulaContext): string {
  return expr.replace(/&\s*([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    return String(safeListLength(name, context));
  });
}

/**
 * Reduce `u_scratch.<list>_length` to the host list length. The struct
 * field naming convention is enforced by `wgsl-emitter.ts:emitUniforms`
 * — list length fields are emitted as `<storage>_length`.
 */
function reduceListLengthRefs(expr: string, context: DispatchFormulaContext): string {
  return expr.replace(
    /u_scratch\.([A-Za-z_][A-Za-z0-9_]*)_length/g,
    (_m, listName: string) => String(safeListLength(listName, context)),
  );
}

/**
 * Reduce `len(<list>)` (Phase E+ formula sugar) to the host list length.
 */
function reduceLenSugar(expr: string, context: DispatchFormulaContext): string {
  return expr.replace(/\blen\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, (_m, name: string) => {
    return String(safeListLength(name, context));
  });
}

/**
 * Reduce scalar uniform names to their runtime values. Word boundary
 * uses `[A-Za-z0-9_]` to match WGSL identifier characters (the
 * default `\b` does not consider `_` a word boundary in all engines).
 *
 * Scalar bindings come from `@bind ..., scalar` directives; the
 * dispatcher caches values per dispatch in `context.scalarValues`.
 *
 * §Phase 3 §15.11 — formula text after WGSL emitter rename carries
 * the binding's hashed `wgslName` (FNV-1a form for quoted
 * `@bind "x"(0) ..., scalar`). The reducer now matches against
 * `binding.wgslName` first, then falls back to `binding.name` for
 * unquoted bindings, and looks up the runtime value via `name`
 * (the surface name is the runtime adapter key — see
 * `scalar-uniform-binding.ts:ScalarUniformBinding.name`).
 */
function reduceScalarNames(expr: string, context: DispatchFormulaContext): string {
  if (context.scalarBindings.length === 0) return expr;
  let out = expr;
  for (const binding of context.scalarBindings) {
    const candidates = Array.from(
      new Set([binding.wgslName, binding.name].filter((n): n is string => Boolean(n))),
    );
    const value = context.scalarValues.get(binding.name) ?? 0;
    for (const candidate of candidates) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(candidate)}(?![A-Za-z0-9_])`, 'g');
      out = out.replace(re, String(value));
    }
  }
  return out;
}

/**
 * Reduce the WGSL helpers `scratch_div`, `scratch_mod`,
 * `scratch_index_clamp`, `ceil`, `max` to native JS expressions.
 *
 * `scratch_mod` uses the positive-modulo convention
 * `((a % b) + b) % b` so negative divisors / dividends behave like the
 * scratch runtime (host JS `%` is sign-of-dividend).
 *
 * `max(...)` accepts 2 or more arguments.
 *
 * Nested calls are handled by repeating the regex until no match
 * remains. The loop bounds guard against pathological inputs.
 *
 * `ceil` / `max` use a negative lookbehind `(?<![A-Za-z0-9_.])` to
 * avoid matching the `ceil` / `max` token inside an already-expanded
 * `Math.ceil` / `Math.max` call (`Math.XXX` → `.` precedes the
 * identifier and `\b` alone would re-match).
 */
function reduceMathHelpers(expr: string): string {
  let out = expr;
  for (let i = 0; i < 8; i += 1) {
    const before = out;
    out = out.replace(
      /\bscratch_div\s*\(\s*([^,()]+(?:\([^)]*\)[^,()]*)*)\s*,\s*([^,()]+(?:\([^)]*\)[^,()]*)*)\s*\)/g,
      (_m, a: string, b: string) => `(${a})/(${b})`,
    );
    out = out.replace(
      /\bscratch_mod\s*\(\s*([^,()]+(?:\([^)]*\)[^,()]*)*)\s*,\s*([^,()]+(?:\([^)]*\)[^,()]*)*)\s*\)/g,
      (_m, a: string, b: string) => `(((${a})%(${b}))+(${b}))%(${b})`,
    );
    out = out.replace(
      /\bscratch_index_clamp\s*\(\s*([^,()]+(?:\([^)]*\)[^,()]*)*)\s*,\s*([^,()]+(?:\([^)]*\)[^,()]*)*)\s*\)/g,
      (_m, idx: string, len: string) =>
        `Math.max(0,Math.min((${idx}),Math.max(0,(${len})-1)))`,
    );
    out = out.replace(
      /(?<![A-Za-z0-9_.])ceil\s*\(\s*([^()]+(?:\([^)]*\)[^()]*)*)\s*\)/g,
      (_m, x: string) => `Math.ceil(${x})`,
    );
    out = out.replace(
      /(?<![A-Za-z0-9_.])max\s*\(([^()]*(?:\([^)]*\)[^()]*)*)\)/g,
      (_m, args: string) => {
        // Split args on top-level commas only (skip nested parens).
        const parts = splitTopLevelCommas(args);
        if (parts.length < 2) return `Math.max(${args})`;
        return `Math.max(${parts.join(', ')})`;
      },
    );
    if (out === before) break;
  }
  return out;
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(') {
      depth += 1;
      buf += ch;
    } else if (ch === ')') {
      depth -= 1;
      buf += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
    } else if (ch !== undefined) {
      buf += ch;
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeListLength(name: string, context: DispatchFormulaContext): number {
  const raw = context.listLength(name);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
