/**
 * Formula syntax sugar → scratch-compat auto-rewrite (§Phase E+).
 *
 * The `@map <var> <- <formula>` and `@repeat R<i> = <formula>` formula
 * slots are spliced verbatim into the WGSL output. To make the DSL more
 * natural, this module rewrites a small set of general notations into
 * their scratch-compat equivalents before emission:
 *
 *   name[idx]   → scratch_list_read_{dtype}(&<emit>, scratch_index_clamp(idx, u_scratch.<emit>_length), u_scratch.<emit>_length)
 *   len(name)   → u_scratch.<emit>_length
 *   bool(x)     → select(0.0, 1.0, x != 0.0)
 *
 * Where `<emit>` is the WGSL-safe identifier for `name`: the
 * `internalName` from `parseNameToken` if set, otherwise the rename
 * table entry from `renameIdentifiers`, otherwise the surface `name`
 * itself. `name` MUST resolve to a `@bind` directive declared in the
 * same region; otherwise the rewrite is skipped (a `warn`-level
 * diagnostic is emitted when an undeclared subscript target is used).
 *
 * `bool(x)` is treated as always-rewritten: there is no other `bool`
 * function in the DSL or in `KNOWN_FORMULA_FUNCTIONS`, so the rewrite
 * is unambiguous.
 *
 * # Lexical safety
 *
 * The rewrite is driven by a hand-written lexer that recognises:
 *   - whitespace (skip)
 *   - numeric literals (skip)
 *   - quoted strings (skip — protects against accidental matches inside
 *     a string literal that the user happened to include)
 *   - identifiers (`[A-Za-z_][A-Za-z0-9_]*`) followed by an optional
 *     `(`, `[`, `.`, or end-of-input token boundary
 *   - punctuation / operators (skip; track nesting depth for `[ ] ( )`)
 *
 * The lexer tracks bracket nesting so a `name[` inside a nested
 * expression rewrites correctly and a `name[…` inside an unclosed
 * bracket is left as-is. The result is passed through `validateFormula`
 * for the existing reserved-keyword / function-name rejection pass.
 *
 * # Diagnostics
 *
 * The rewrite emits `gpu.formula_sugar_undeclared_target` warn-level
 * diagnostics when a subscript or `len(...)` target does not resolve to
 * a `@bind` declaration in the same region. The directive body still
 * emits as-is; the diagnostic surfaces in `ErrorLogPanel`.
 */
import type { BindDirective, Diagnostic } from './types';
import { safeIdentifierForBinding } from './wgsl-emitter';

export interface RewriteContext {
  /** `@bind` directives declared in the same region. */
  readonly bindings: readonly BindDirective[];
  /**
   * Pre-computed rename table (output of `renameIdentifiers`).
   * Maps surface name → emitted WGSL identifier. May be empty when
   * the caller hasn't run the rename pass yet.
   */
  readonly renameTable?: Readonly<Record<string, string>>;
  /** Region id (for diagnostics). */
  readonly regionId?: string;
  /** Owning directive block id (for diagnostics). */
  readonly blockId?: string;
  /** Owning directive line (for diagnostics). */
  readonly line?: number;
}

export interface RewriteResult {
  formula: string;
  diagnostics: Diagnostic[];
}

const LIST_READ_FUNCTIONS: Readonly<Record<BindDirective['dtype'], string>> = {
  f32: 'scratch_list_read_f32',
  i32: 'scratch_list_read_i32',
  byte: 'scratch_list_read_u32',
};

export function rewriteFormula(formula: string, ctx: RewriteContext): RewriteResult {
  const diagnostics: Diagnostic[] = [];
  if (formula.length === 0) return { formula, diagnostics };

  // Build the binding lookup keyed on the *emit* name (the WGSL
  // identifier the storage binding will use). Multiple surface names
  // may map to the same emit name after the rename pass, but each
  // `@bind` directive produces exactly one storage variable.
  const bindingByEmit = new Map<string, BindDirective>();
  for (const binding of ctx.bindings) {
    const emitName = resolveEmitName(binding, ctx.renameTable);
    bindingByEmit.set(emitName, binding);
  }
  const bindingBySurface = new Map<string, BindDirective>();
  for (const binding of ctx.bindings) {
    bindingBySurface.set(binding.name, binding);
  }

  // §Phase 3 §15.11 — the caller (`wgsl-emitter.ts:emitFormula`)
  // applies the quoted-reference rename pass BEFORE the sugar pass so
  // the lexer sees `"my list"` as the hashed identifier and the
  // binding lookup resolves it via `bindingByEmit`. This preprocess
  // step is a defensive fallback: if the caller has not yet run
  // `renameFormulaIdentifiers`, we still try to resolve quoted
  // targets through `bindingBySurface` by walking the formula's
  // quoted segments once.
  const preprocessed = preprocessQuotedReferences(formula, bindingBySurface);
  const tokens = tokenise(preprocessed);

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.kind !== 'ident') {
      out.push(tok.text);
      continue;
    }
    const next = tokens[i + 1];
    // `bool(x)` → `select(0.0, 1.0, x != 0.0)`
    if (tok.text === 'bool' && next && next.kind === 'paren-open') {
      const close = findMatching(tokens, i + 1);
      if (close < 0) {
        out.push(tok.text);
        continue;
      }
      const innerText = tokens
        .slice(i + 2, close)
        .map((t) => t.text)
        .join('');
      // Recursively rewrite the inner expression so nested sugar
      // (e.g. `bool(my_list[R0])`) is fully expanded before being
      // wrapped in `select(0.0, 1.0, ...)`.
      const innerRewrite = rewriteFormula(innerText, ctx);
      if (innerRewrite.diagnostics.length > 0) {
        diagnostics.push(...innerRewrite.diagnostics);
      }
      out.push(`select(0.0, 1.0, ${innerRewrite.formula} != 0.0)`);
      i = close;
      continue;
    }
    // `len(name)` → `u_scratch.<emit>_length`
    if (tok.text === 'len' && next && next.kind === 'paren-open') {
      const close = findMatching(tokens, i + 1);
      if (close < 0) {
        out.push(tok.text);
        continue;
      }
      const argIdents = tokens.slice(i + 2, close).filter((t) => t.kind === 'ident');
      if (argIdents.length === 1) {
        const argTok = argIdents[0];
        if (argTok) {
          const binding = bindingBySurface.get(argTok.text) ?? bindingByEmit.get(argTok.text);
          if (binding) {
            const emitName = resolveEmitName(binding, ctx.renameTable);
            out.push(`u_scratch.${emitName}_length`);
            i = close;
            continue;
          }
        }
      }
      // Undeclared or non-single-arg len(...) — emit a diagnostic and
      // leave the surface form untouched.
      diagnostics.push(makeDiag(ctx, `len(...) target does not resolve to a @bind directive`));
      out.push(tok.text);
      continue;
    }
    // `name[idx]` → `scratch_list_read_{dtype}(&<emit>, scratch_index_clamp(idx, u_scratch.<emit>_length), u_scratch.<emit>_length)`
    if (next && next.kind === 'bracket-open') {
      const close = findMatching(tokens, i + 1);
      if (close < 0) {
        out.push(tok.text);
        continue;
      }
      const binding = bindingBySurface.get(tok.text) ?? bindingByEmit.get(tok.text);
      if (binding) {
        const emitName = resolveEmitName(binding, ctx.renameTable);
        const reader = LIST_READ_FUNCTIONS[binding.dtype];
        const innerText = tokens
          .slice(i + 2, close)
          .map((t) => t.text)
          .join('');
        // Recursively rewrite the inner expression so nested sugar
        // inside the subscript (e.g. `my_list[R0 + 1]`) is expanded.
        const innerRewrite = rewriteFormula(innerText, ctx);
        if (innerRewrite.diagnostics.length > 0) {
          diagnostics.push(...innerRewrite.diagnostics);
        }
        out.push(
          `${reader}(&${emitName}, scratch_index_clamp(${innerRewrite.formula}, u_scratch.${emitName}_length), u_scratch.${emitName}_length)`,
        );
        i = close;
        continue;
      }
      diagnostics.push(
        makeDiag(ctx, `subscript target '${tok.text}' does not resolve to a @bind directive`),
      );
      out.push(tok.text);
      continue;
    }
    out.push(tok.text);
  }

  return { formula: out.join(''), diagnostics };
}

/**
 * §Phase 3 §15.11 — defensive quoted-reference rename. Walks every
 * `"..."` segment in the formula; if its unescaped content matches a
 * binding surface name, replace the quoted segment with the WGSL
 * emit identifier so the lexer's `bindingByEmit` lookup succeeds.
 *
 * Returns the original formula when no quoted segment matches, so
 * this helper is a no-op for formulas that don't carry quoted
 * references.
 */
function preprocessQuotedReferences(
  formula: string,
  bindingBySurface: ReadonlyMap<string, BindDirective>,
): string {
  let out = formula;
  let changed = false;
  out = out.replace(/"((?:[^"\\]|\\.)*)"/g, (match, body: string) => {
    const surface = body.replace(/\\(.)/g, '$1');
    const binding = bindingBySurface.get(surface);
    if (!binding) return match;
    changed = true;
    return binding.internalName ?? binding.name;
  });
  return changed ? out : formula;
}

function resolveEmitName(
  binding: BindDirective,
  renameTable: Readonly<Record<string, string>> | undefined,
): string {
  if (binding.internalName) return binding.internalName;
  const renamed = renameTable?.[binding.name];
  if (renamed) return renamed;
  return safeIdentifierForBinding(binding.name);
}

interface Token {
  kind: 'ident' | 'number' | 'string' | 'paren-open' | 'paren-close' | 'bracket-open' | 'bracket-close' | 'other';
  text: string;
}

function tokenise(formula: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (!ch) break;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      tokens.push({ kind: 'other', text: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // String literal: copy verbatim up to the closing `"`. We don't
      // unescape; the rewrite layer doesn't need to inspect the
      // contents.
      let j = i + 1;
      while (j < formula.length) {
        const cj = formula[j];
        if (cj === '\\' && j + 1 < formula.length) {
          j += 2;
          continue;
        }
        if (cj === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ kind: 'string', text: formula.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < formula.length) {
        const cj = formula[j];
        if (!cj) break;
        if (!/[0-9.]/.test(cj) && !/[eE]/.test(cj)) break;
        j += 1;
      }
      tokens.push({ kind: 'number', text: formula.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < formula.length) {
        const cj = formula[j];
        if (!cj) break;
        if (!/[A-Za-z0-9_]/.test(cj)) break;
        j += 1;
      }
      tokens.push({ kind: 'ident', text: formula.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'paren-open', text: ch });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'paren-close', text: ch });
      i += 1;
      continue;
    }
    if (ch === '[') {
      tokens.push({ kind: 'bracket-open', text: ch });
      i += 1;
      continue;
    }
    if (ch === ']') {
      tokens.push({ kind: 'bracket-close', text: ch });
      i += 1;
      continue;
    }
    tokens.push({ kind: 'other', text: ch });
    i += 1;
  }
  return tokens;
}

function findMatching(tokens: readonly Token[], openIdx: number): number {
  const open = tokens[openIdx];
  if (!open) return -1;
  if (open.kind !== 'paren-open' && open.kind !== 'bracket-open') return -1;
  // Bracket nesting is tracked per-type. A `(` open matches the next
  // `)` at depth 0; a `[` open matches the next `]` at depth 0. The
  // other type's brackets are transparent — so `bool(my_list[R0])` finds
  // the `)` after `[R0]` at depth 0 even though `[` and `]` sit between.
  if (open.kind === 'paren-open') {
    let depth = 1;
    for (let i = openIdx + 1; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (!tok) continue;
      if (tok.kind === 'paren-open') depth += 1;
      else if (tok.kind === 'paren-close') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
  let depth = 1;
  for (let i = openIdx + 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.kind === 'bracket-open') depth += 1;
    else if (tok.kind === 'bracket-close') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function makeDiag(ctx: RewriteContext, message: string): Diagnostic {
  return {
    severity: 'warn',
    code: 'gpu.formula_sugar_undeclared_target',
    message,
    regionId: ctx.regionId,
    blockId: ctx.blockId,
    line: ctx.line,
  };
}
