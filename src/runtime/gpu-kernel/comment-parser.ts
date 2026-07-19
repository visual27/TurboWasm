/**
 * Tokenize + parse `@compute` block comments on `control_repeat` blocks.
 *
 * The DSL is documented in §3 of `gpu-kernel-spec-summary.md`. Summary:
 *
 *   @bind <name>(<slot>) ro|rw [f32|i32|byte]
 *   @max length=<uint>
 *   @max <name>=<uint>
 *   @workgroup_size(<x>) | (<x>,<y>) | (<x>,<y>,<z>)
 *   @repeat R<i>[:<axis>] = <formula>[, max=<uint>]
 *   @map <var> <- <formula>
 *
 * `<name>` (and `<var>`, `<axis>`) accept either a plain identifier
 * (`tmp0`, `R0`, `aabb_width`) or a double-quoted string
 * (`"my list"`, `"my group"`, `"R0"`). §Phase E extended this support to
 * `@bind` and `@map`; §Phase E+ extends it to every identifier slot in
 * the parser. Quoted form is recommended in documentation but unquoted
 * identifiers continue to work for backwards compatibility.
 *
 * The parser is intentionally permissive about whitespace (TAB/spaces/CRLF
 * per §3.8) and directive casing (`@Bind` == `@BIND` == `@bind`), but
 * strict about identifier syntax. Anything that smells malformed becomes
 * a `Diagnostic` (`code: 'gpu.dsl_syntax_error'`) which the WGSL emitter
 * then turns into a D1 demote on the owning region.
 */

import type {
  AxisFinal,
  BindDirective,
  Diagnostic,
  MapDirective,
  MaxDirective,
  ParsedComment,
  ParsedDirective,
  RepeatDirective,
  Severity,
  WorkgroupSizeDirective,
} from './types';
import { ALL_AXES } from './types';

/**
 * §Phase 2 (15.2): `makeDiag` now accepts a `severity` argument so the
 * parser can emit `severity: 'error'` diagnostics for directive shapes
 * that the WGSL pipeline cannot tolerate (e.g. the `@max` removal in
 * §15.3). Default remains `'warn'` so every existing call site keeps its
 * pre-Phase 2 behaviour without modification.
 */

/**
 * Parse the text of one `@compute` comment block into the directives and
 * any diagnostics. Diagnostics are non-fatal at this layer — the caller
 * decides whether a syntax error becomes a D1 demote (it does).
 *
 * @param comment  The scratch comment DTO (`{ text, blockId }`).
 * @param regionId Stable identifier for the region, used in diagnostics.
 */
export function parseComputeComment(
  comment: ParsedComment,
  regionId: string,
): { directives: ParsedDirective[]; diagnostics: Diagnostic[] } {
  const directives: ParsedDirective[] = [];
  const diagnostics: Diagnostic[] = [];

  const text = comment.text ?? '';
  if (text.trim().length === 0) {
    diagnostics.push(
      makeDiag('empty comment', regionId, comment.blockId, 0, 0),
    );
    return { directives, diagnostics };
  }

  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Skip `//` line-comment prefixes (Scratch UI prefixes every block
    // comment with `// `).
    const withoutPrefix = trimmed.replace(/^\/\/\s*/, '');
    if (withoutPrefix.length === 0) continue;
    // Quick reject: non-directive lines are noted as errors so the user
    // knows their DSL was malformed.
    if (!withoutPrefix.startsWith('@')) {
      diagnostics.push(
        makeDiag(
          `expected a directive starting with '@', got '${truncate(withoutPrefix, 24)}'`,
          regionId,
          comment.blockId,
          i,
          0,
        ),
      );
      continue;
    }
    const result = parseDirectiveLine(withoutPrefix, i, regionId, comment.blockId);
    if (result.directive) directives.push(result.directive);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
  }

  return { directives, diagnostics };
}

interface LineParse {
  directive: ParsedDirective | null;
  diagnostic: Diagnostic | null;
}

function parseDirectiveLine(
  stripped: string,
  line: number,
  regionId: string,
  blockId: string,
): LineParse {
  // Strip leading '@' and lower-case the directive head. The head ends
  // at the first whitespace OR at the first `(` (so `@workgroup_size(64)`
  // resolves to head `workgroup_size` and tail `(64)`).
  const rest = stripped.slice(1);
  const headEnd = rest.search(/[\s(]/);
  const head = (headEnd === -1 ? rest : rest.slice(0, headEnd)).toLowerCase();
  const tail = headEnd === -1 ? '' : rest.slice(headEnd).trim();

  switch (head) {
    case 'bind':
      return parseBind(tail, line, regionId, blockId);
    case 'max':
      return parseMax(tail, line, regionId, blockId);
    case 'workgroup_size':
      return parseWorkgroupSize(tail, line, regionId, blockId);
    case 'repeat':
      return parseRepeat(tail, line, regionId, blockId, blockId);
    case 'map':
      return parseMap(tail, line, regionId, blockId);
    case 'compute':
      // `@compute` is a marker, not a directive. Silently skip.
      return { directive: null, diagnostic: null };
    default:
      return {
        directive: null,
        diagnostic: makeDiag(
          `unknown directive '@${head}'`,
          regionId,
          blockId,
          line,
          0,
        ),
      };
  }
}

interface ParsedNameToken {
  name: string;
  /**
   * `__tw_<hash>` for quoted names that contain characters not legal in
   * a WGSL identifier (spaces, punctuation). `undefined` for plain
   * identifiers — the existing reserved-keyword rename pass handles those.
   */
  internalName: string | undefined;
  diagnostic: Omit<Diagnostic, 'regionId' | 'blockId' | 'line'> | null;
}

/**
 * Parse a name token that may be a plain identifier (`tmp0`) or a
 * double-quoted string (`"my list"`, `"weird\"name"`). The quoted form
 * (§Phase E) lets users `@bind` Scratch lists that have spaces or
 * punctuation in their names without violating WGSL's identifier
 * grammar. §Phase E+ extends this to every NAME slot in the parser.
 *
 * Escape sequences inside quoted strings:
 *   - `\"` → `"`
 *   - `\\` → `\`
 *   - any other `\X` → `X` (literal)
 *
 * On empty quoted names the helper returns a diagnostic (severity warn,
 * code `gpu.dsl_syntax_error`). The caller propagates `regionId` /
 * `blockId` / `line` into the final diagnostic.
 */
export function parseNameToken(token: string): ParsedNameToken {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    const raw = token.slice(1, -1);
    // Walk the string char-by-char so the two structured escapes (`\"`
    // and `\\`) win the precedence race over the catch-all `\X` rule.
    // Anything else following a backslash is dropped (the backslash is
    // consumed). Plain backslashes without a paired character are left
    // intact so a future DSL extension can add more escapes without
    // ambiguity.
    let unescaped = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === '"' || next === '\\') {
          unescaped += next;
          i += 1;
          continue;
        }
        // Unknown escape: drop the backslash, keep the literal char.
        unescaped += next;
        i += 1;
        continue;
      }
      unescaped += ch;
    }
    if (unescaped.length === 0) {
      return {
        name: '',
        internalName: undefined,
        diagnostic: {
          severity: 'warn',
          code: 'gpu.dsl_syntax_error',
          message: `empty quoted name in directive (got '${truncate(token, 32)}')`,
          column: 0,
        },
      };
    }
    return {
      name: unescaped,
      internalName: hashedIdentifier(unescaped, 0),
      diagnostic: null,
    };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
    return {
      name: '',
      internalName: undefined,
      diagnostic: {
        severity: 'warn',
        code: 'gpu.dsl_syntax_error',
        message: `expected identifier or quoted name, got '${truncate(token, 32)}'`,
        column: 0,
      },
    };
  }
  return { name: token, internalName: undefined, diagnostic: null };
}

/**
 * FNV-1a 32-bit hash, formatted as `__tw_<8 hex digits>`. Identical
 * to `wgsl-emitter.ts:hashedIdentifier` — duplicated here so the parser
 * does not depend on the emitter and so a parser-only build (e.g. for
 * the `@turbowasm/gpu-kernel-parser` package) can still derive
 * `internalName`. The two functions are expected to agree byte-for-byte
 * because they share the same `Scratch` name lookup contract — see
 * `test/runtime/gpu-kernel/comment-parser.test.ts` for the cross-check.
 */
export function hashedIdentifier(identifier: string, salt: number): string {
  let hash = 0x811c9dc5;
  const input = salt === 0 ? identifier : `${identifier}:${salt}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `__tw_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function parseBind(
  tail: string,
  line: number,
  regionId: string,
  blockId: string,
): LineParse {
  // Pattern: <name>(<slot>) ro|rw [f32|i32|byte][, scalar|list]
  // `<name>` accepts either an identifier (`tmp0`) or a quoted string
  // (`"my list"`). Quoted names carry an `internalName` (FNV-1a hash)
  // used by the WGSL emitter to derive a valid identifier; unquoted
  // names go through the existing reserved-keyword rename pass.
  //
  // The trailing `, scalar` (or `, list`) suffix (§Phase 3, scalar
  // uniform binding) selects the binding's storage kind. `, list` is
  // the default (storage buffer); `, scalar` routes the binding through
  // `@group(1) @binding(0)` as a single-number uniform. Omission of the
  // suffix yields `storageKind: 'list'` (set explicitly below).
  //
  // We split on the first `(` so the name token can be quoted (a quoted
  // name may legally contain parentheses in future DSL extensions, so we
  // only split on the *unquoted* opening paren here — for now a quoted
  // name cannot contain `(`, but the regex below accepts the surface
  // form once extracted).
  const splitAt = findUnquotedOpenParen(tail);
  if (splitAt < 0) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @bind: expected '<name>(<slot>) ro|rw [f32|i32|byte][, scalar]', got '${truncate(tail, 32)}'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const nameToken = tail.slice(0, splitAt).trim();
  const after = tail.slice(splitAt + 1);
  // §Phase 3: trailing `, scalar|list` is optional. Capture group 4
  // (when present) selects the storage kind; capture group 3 captures
  // the dtype (default `f32`); group 2 captures ro|rw; group 1 captures
  // the slot.
  const m = after.match(
    /^\s*(\d+)\s*\)\s+(ro|rw)(?:\s+(f32|i32|byte))?(?:\s*,\s*(scalar|list))?\s*$/i,
  );
  if (!m) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @bind: expected '<name>(<slot>) ro|rw [f32|i32|byte][, scalar]', got '${truncate(tail, 32)}'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const slot = Number.parseInt(m[1] ?? '0', 10);
  const rw = (m[2] ?? '').toLowerCase() === 'rw';
  const dtypeRaw = (m[3] ?? 'f32').toLowerCase();
  const dtype = (dtypeRaw === 'i32' || dtypeRaw === 'byte') ? dtypeRaw : 'f32';
  const storageKindRaw = (m[4] ?? '').toLowerCase();
  // Default ('list' / omitted) is encoded as 'list' to keep the field
  // shape uniform; `undefined` only appears via direct object
  // construction in tests / fixtures. The WGSL emitter treats
  // `storageKind !== 'scalar'` as the list path.
  const storageKind: 'list' | 'scalar' = storageKindRaw === 'scalar' ? 'scalar' : 'list';
  const parsed = parseNameToken(nameToken);
  if (parsed.diagnostic) {
    return { directive: null, diagnostic: { ...parsed.diagnostic, regionId, blockId, line } };
  }
  const directive: BindDirective = {
    kind: 'bind',
    name: parsed.name,
    ...(parsed.internalName ? { internalName: parsed.internalName } : {}),
    slot,
    readOnly: !rw,
    dtype: dtype === 'i32' ? 'i32' : dtype === 'byte' ? 'byte' : 'f32',
    storageKind,
    line,
    column: 0,
  };
  return { directive, diagnostic: null };
}

/**
 * Find the index of the first unquoted `(` in `s`. Quoted segments
 * (between matching `"` characters) are skipped so a quoted name
 * containing future-extension characters (or whitespace) does not
 * confuse the split. Returns -1 when no unquoted `(` is found.
 */
function findUnquotedOpenParen(s: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && inQuote && i + 1 < s.length) {
      // Skip escaped char inside a quoted string.
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === '(') return i;
  }
  return -1;
}

/**
 * Find the index of the *last* unquoted `,` in `s`. Quoted segments
 * (between matching `"` characters) are skipped so a quoted name or a
 * `name[idx]` formula containing a comma does not break the split.
 * Returns -1 when no unquoted `,` is found.
 *
 * §Phase 0 — used by `parseTrailingBlockId` to detect the boundary
 * between the formula and the trailing `, blockId="<id>"` argument
 * without misreading commas inside `len(my_list)` / `"a,b"` etc.
 *
 * Scans from the end so a formula written as `expr, max=64, blockId="x"`
 * finds the comma immediately before `blockId="x"` rather than the
 * earlier comma before `max=64`.
 */
function findLastUnquotedComma(s: string): number {
  let inQuote = false;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const ch = s[i];
    if (ch === '\\' && inQuote && i - 1 >= 0) {
      // Skip escaped char inside a quoted string.
      i -= 1;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === ',') return i;
  }
  return -1;
}

function parseMax(
  tail: string,
  line: number,
  regionId: string,
  blockId: string,
): LineParse {
  // Pattern: <name>=<uint> where <name> is identifier-or-quoted (§Phase
  // E+). We split on the *unquoted* `=` so a quoted group name with
  // future extension characters does not break the parse.
  const eq = findUnquotedEq(tail);
  if (eq < 0) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @max: expected '<name>=<uint>', got '${truncate(tail, 32)}'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const nameToken = tail.slice(0, eq).trim();
  const valueStr = tail.slice(eq + 1).trim();
  if (!/^\d+$/.test(valueStr)) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @max: expected '<name>=<uint>', got '${truncate(tail, 32)}'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const parsed = parseNameToken(nameToken);
  if (parsed.diagnostic) {
    return { directive: null, diagnostic: { ...parsed.diagnostic, regionId, blockId, line } };
  }
  const value = Number.parseInt(valueStr, 10);
  if (!Number.isFinite(value) || value < 0) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `@max value must be a non-negative integer (got '${valueStr}')`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const directive: MaxDirective = {
    kind: 'max',
    name: parsed.name,
    ...(parsed.internalName ? { internalName: parsed.internalName } : {}),
    value,
    line,
    column: 0,
  };
  return { directive, diagnostic: null };
}

function findUnquotedEq(s: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && inQuote && i + 1 < s.length) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === '=') return i;
  }
  return -1;
}

/**
 * §Phase 0 — strip a trailing `, blockId="<id>"` argument off a directive
 * tail. Returns the trimmed tail with the suffix removed plus the parsed
 * id, or `{ tail }` if no suffix was found. When `blockId=` is present in
 * a malformed form (unquoted, missing closing quote, etc.) a
 * `gpu.dsl_syntax_error` diagnostic is emitted and the suffix is dropped
 * silently — the directive still parses without `boundBlockId`.
 */
function parseTrailingBlockId(
  tail: string,
  line: number,
  regionId: string,
  blockId: string,
  diagnostics: Diagnostic[],
): { tail: string; boundBlockId?: string } {
  // Look at the *last* unquoted `,` and check whether what follows is a
  // well-formed `blockId="..."` argument. This keeps the regex scope tight
  // so a `len(my_list)` style formula with a trailing comma does not
  // accidentally match.
  const lastComma = findLastUnquotedComma(tail);
  if (lastComma < 0) return { tail };
  const head = tail.slice(0, lastComma).trimEnd();
  const suffix = tail.slice(lastComma + 1).trim();
  const m = suffix.match(/^blockId\s*=\s*"([^"]*)"\s*$/);
  if (!m) {
    // Either `blockId=` appears with malformed shape, or the trailing
    // comma is not part of a `blockId=` suffix (e.g. formula ends with
    // `, `). Only complain when `blockId=` is recognisable.
    if (/^blockId\s*=/.test(suffix)) {
      diagnostics.push({
        severity: 'warn',
        code: 'gpu.dsl_syntax_error',
        message: `malformed blockId=... in directive: expected trailing ', blockId="<id>"' (got '${truncate(tail, 32)}')`,
        regionId,
        blockId,
        line,
        column: 0,
      });
      return { tail: head };
    }
    return { tail };
  }
  const id = m[1] ?? '';
  if (id.length === 0) {
    diagnostics.push({
      severity: 'warn',
      code: 'gpu.dsl_syntax_error',
      message: `empty blockId="..." in directive (got '${truncate(tail, 32)}')`,
      regionId,
      blockId,
      line,
      column: 0,
    });
    return { tail: head };
  }
  return { tail: head, boundBlockId: id };
}

function parseWorkgroupSize(
  tail: string,
  line: number,
  regionId: string,
  blockId: string,
): LineParse {
  // Pattern: (x[,y[,z]])
  const m = tail.match(/^\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?\)\s*$/);
  if (!m || m[1] === undefined) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @workgroup_size: expected '(x)' / '(x,y)' / '(x,y,z)', got '${truncate(tail, 32)}'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const x = Number.parseInt(m[1], 10);
  const yRaw = m[2];
  const zRaw = m[3];
  const y = yRaw === undefined ? 1 : Number.parseInt(yRaw, 10);
  const z = zRaw === undefined ? 1 : Number.parseInt(zRaw, 10);
  if (x < 1 || y < 1 || z < 1) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `@workgroup_size entries must be ≥ 1, got (${x},${y},${z})`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const directive: WorkgroupSizeDirective = { kind: 'workgroup_size', x, y, z, line, column: 0 };
  return { directive, diagnostic: null };
}

function parseRepeat(
  tail: string,
  line: number,
  regionId: string,
  blockId: string,
  repeatBlockId: string,
): LineParse {
  // Pattern: <name>[:<axis>] = <formula>[, max=<uint>][, blockId="<id>"]
  // Both `<name>` and `<axis>` accept either an identifier or a quoted
  // string (§Phase E+). The formula may contain anything up to a trailing
  // `, max=...` and/or `, blockId="..."`. We split on the first *unquoted*
  // `=` so a quoted name containing future-extension characters does not
  // break the parse.
  const eq = findUnquotedEq(tail);
  if (eq < 0) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @repeat: missing '=...'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const head = tail.slice(0, eq).trim();
  let right = tail.slice(eq + 1).trim();

  // Optional trailing `, max=<uint>` and/or `, blockId="<id>"` (§Phase 0).
  // The two may appear in either order, so we iterate the suffix scan
  // up to a small fixed budget. Each pass strips one recognisable
  // suffix; the loop breaks when neither pattern matches the tail.
  let max: number | undefined;
  let boundBlockId: string | undefined;
  const suffixDiagnostics: Diagnostic[] = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const maxMatch = right.match(/,\s*max\s*=\s*(\d+)\s*$/);
    if (maxMatch) {
      max = Number.parseInt(maxMatch[1] ?? '0', 10);
      right = right.slice(0, right.length - maxMatch[0].length).trim();
      continue;
    }
    const beforeLen = right.length;
    const blockIdSuffix = parseTrailingBlockId(
      right,
      line,
      regionId,
      blockId,
      suffixDiagnostics,
    );
    if (blockIdSuffix.boundBlockId !== undefined) {
      boundBlockId = blockIdSuffix.boundBlockId;
      right = blockIdSuffix.tail;
      continue;
    }
    // `parseTrailingBlockId` shrinks the tail only when it stripped
    // something (malformed blockId= suffix with a diagnostic). When
    // nothing matched the loop is done.
    if (blockIdSuffix.tail.length === beforeLen) break;
    right = blockIdSuffix.tail;
  }

  // Head: `<name>` or `<name>:<axis>`. Find the unquoted `:` between
  // them. When absent, the whole head is `<name>` and `<axis>` defaults
  // to `'sequential'`.
  const colon = findUnquotedColon(head);
  const nameRaw = (colon < 0 ? head : head.slice(0, colon)).trim();
  const axisRaw = (colon < 0 ? '' : head.slice(colon + 1)).trim();
  const nameParsed = parseNameToken(nameRaw);
  if (nameParsed.diagnostic) {
    return { directive: null, diagnostic: { ...nameParsed.diagnostic, regionId, blockId, line } };
  }
  let axis: AxisFinal;
  if (axisRaw.length === 0) {
    axis = 'sequential';
  } else {
    const axisParsed = parseNameToken(axisRaw);
    if (axisParsed.diagnostic) {
      return { directive: null, diagnostic: { ...axisParsed.diagnostic, regionId, blockId, line } };
    }
    axis = normalizeAxis(axisParsed.name);
  }

  if (right.length === 0) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @repeat: missing formula after '='`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }

  const directive: RepeatDirective = {
    kind: 'repeat',
    name: nameParsed.name,
    ...(nameParsed.internalName ? { internalName: nameParsed.internalName } : {}),
    axis,
    formula: right,
    max,
    blockId: repeatBlockId,
    ...(boundBlockId ? { boundBlockId } : {}),
    line,
    column: 0,
  };
  // Surface the trailing-blockId diagnostics alongside the directive so
  // the caller can fold them into the region's diagnostic list.
  if (suffixDiagnostics.length > 0) {
    return { directive, diagnostic: suffixDiagnostics[0] ?? null };
  }
  return { directive, diagnostic: null };
}

function findUnquotedColon(s: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && inQuote && i + 1 < s.length) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === ':') return i;
  }
  return -1;
}

function parseMap(
  tail: string,
  line: number,
  regionId: string,
  blockId: string,
): LineParse {
  // Pattern: <var> <- <formula>[, blockId="<id>"]
  // `<var>` is either an identifier or a quoted string. Quoted names
  // carry an `internalName` so the WGSL emitter can derive a valid
  // `let` binding name without disturbing the canonical key (which is
  // keyed on `var`/`name`).
  const arrow = tail.indexOf('<-');
  if (arrow === -1) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @map: missing '<-'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const varToken = tail.slice(0, arrow).trim();
  let formula = tail.slice(arrow + 2).trim();
  const parsed = parseNameToken(varToken);
  if (parsed.diagnostic) {
    return { directive: null, diagnostic: { ...parsed.diagnostic, regionId, blockId, line } };
  }
  if (formula.length === 0) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @map: missing formula after '<-'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }

  // Optional trailing `, blockId="<id>"` (§Phase 0).
  const diagnostics: Diagnostic[] = [];
  const blockIdSuffix = parseTrailingBlockId(formula, line, regionId, blockId, diagnostics);
  formula = blockIdSuffix.tail;
  const boundBlockId = blockIdSuffix.boundBlockId;

  const directive: MapDirective = {
    kind: 'map',
    var: parsed.name,
    ...(parsed.internalName ? { internalName: parsed.internalName } : {}),
    formula,
    blockId,
    ...(boundBlockId ? { boundBlockId } : {}),
    line,
    column: 0,
  };
  if (diagnostics.length > 0) {
    return { directive, diagnostic: diagnostics[0] ?? null };
  }
  return { directive, diagnostic: null };
}

function normalizeAxis(raw: string): AxisFinal {
  const lower = raw.toLowerCase();
  if (lower === 'sequential') return 'sequential';
  if ((ALL_AXES as readonly string[]).includes(lower)) {
    return lower as AxisFinal;
  }
  // Unknown axis values are normalised to `sequential` (the safe
  // fallback) and surfaced as a diagnostic by the caller. We do not
  // error here so the @repeat itself still parses.
  return 'sequential';
}

function makeDiag(
  message: string,
  regionId: string,
  blockId: string,
  line: number,
  column: number,
  severity: Severity = 'warn',
): Diagnostic {
  return {
    severity,
    code: 'gpu.dsl_syntax_error',
    message,
    regionId,
    blockId,
    line,
    column,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
