/**
 * Tokenize + parse `@compute` block comments on `control_repeat` blocks.
 *
 * The DSL is documented in Â§3 of `gpu-kernel-spec-summary.md`. Summary:
 *
 *   @bind <name>(<slot>) ro|rw [f32|i32|byte]
 *   @max length=<uint>
 *   @max <groupName>=<uint>
 *   @workgroup_size(<x>) | (<x>,<y>) | (<x>,<y>,<z>)
 *   @repeat R<i>[:<axis>] = <formula>[, max=<uint>]
 *   @map <var> <- <formula>
 *
 * The parser is intentionally permissive about whitespace (TAB/spaces/CRLF
 * per Â§3.8) and directive casing (`@Bind` == `@BIND` == `@bind`), but
 * strict about identifiers. Anything that smells malformed becomes a
 * `Diagnostic` (`code: 'gpu.dsl_syntax_error'`) which the WGSL emitter
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
  WorkgroupSizeDirective,
} from './types';
import { ALL_AXES } from './types';

/**
 * Parse the text of one `@compute` comment block into the directives and
 * any diagnostics. Diagnostics are non-fatal at this layer â the caller
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
   * identifiers â the existing reserved-keyword rename pass handles those.
   */
  internalName: string | undefined;
  diagnostic: Omit<Diagnostic, 'regionId' | 'blockId' | 'line'> | null;
}

/**
 * Parse a name token that may be a plain identifier (`tmp0`) or a
 * double-quoted string (`"my list"`, `"weird\"name"`). The quoted form
 * (Â§Phase E) lets users `@bind` Scratch lists that have spaces or
 * punctuation in their names without violating WGSL's identifier
 * grammar.
 *
 * Escape sequences inside quoted strings:
 *   - `\"` â `"`
 *   - `\\` â `\`
 *   - any other `\X` â `X` (literal)
 *
 * On empty quoted names the helper returns a diagnostic (severity warn,
 * code `gpu.dsl_syntax_error`). The caller propagates `regionId` /
 * `blockId` / `line` into the final diagnostic.
 */
function parseNameToken(token: string): ParsedNameToken {
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
 * to `wgsl-emitter.ts:hashedIdentifier` â duplicated here so the parser
 * does not depend on the emitter and so a parser-only build (e.g. for
 * the `@turbowasm/gpu-kernel-parser` package) can still derive
 * `internalName`. The two functions are expected to agree byte-for-byte
 * because they share the same `Scratch` name lookup contract â see
 * `test/runtime/gpu-kernel/comment-parser.test.ts` for the cross-check.
 */
function hashedIdentifier(identifier: string, salt: number): string {
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
  // Pattern: <name>(<slot>) ro|rw [f32|i32|byte]
  // `<name>` is either an identifier (`tmp0`) or a quoted string (`"my list"`).
  // Quoted names carry an `internalName` (FNV-1a hash) used by the WGSL
  // emitter to derive a valid identifier; unquoted names go through the
  // existing reserved-keyword rename pass (no `internalName` set here).
  const m = tail.match(
    /^("[^"\\]*(?:\\.[^"\\]*)*"|[A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(\d+)\s*\)\s+(ro|rw)(?:\s+(f32|i32|byte))?\s*$/i,
  );
  if (!m) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @bind: expected '<name>(<slot>) ro|rw [f32|i32|byte]', got '${truncate(tail, 32)}'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const nameToken = m[1] ?? '';
  const slotStr = m[2] ?? '0';
  const slot = Number.parseInt(slotStr, 10);
  const rw = (m[3] ?? '').toLowerCase() === 'rw';
  const dtypeRaw = (m[4] ?? 'f32').toLowerCase();
  const dtype = (dtypeRaw === 'i32' || dtypeRaw === 'byte') ? dtypeRaw : 'f32';
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
    line,
    column: 0,
  };
  return { directive, diagnostic: null };
}

function parseMax(
  tail: string,
  line: number,
  regionId: string,
  blockId: string,
): LineParse {
  // Pattern: <ident>=<uint>
  const m = tail.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*$/);
  if (!m) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @max: expected '<group>=<uint>', got '${truncate(tail, 32)}'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const groupName = m[1] ?? '';
  const value = Number.parseInt(m[2] ?? '0', 10);
  if (!Number.isFinite(value) || value < 0) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `@max value must be a non-negative integer (got '${m[2] ?? ''}')`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const directive: MaxDirective = { kind: 'max', groupName, value, line, column: 0 };
  return { directive, diagnostic: null };
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
        `@workgroup_size entries must be â¥ 1, got (${x},${y},${z})`,
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
  // Pattern: R<i>[:<axis>] = <formula>[, max=<uint>]
  // The formula may contain anything up to a trailing `, max=...`.
  // We split on the first `=` to get the head (left) and the tail right
  // of `=`. Then look for trailing `, max=<uint>` on the right tail.
  const eq = tail.indexOf('=');
  if (eq === -1) {
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

  // Optional trailing `, max=<uint>`.
  let max: number | undefined;
  const maxMatch = right.match(/,\s*max\s*=\s*(\d+)\s*$/);
  if (maxMatch) {
    max = Number.parseInt(maxMatch[1] ?? '0', 10);
    right = right.slice(0, right.length - maxMatch[0].length).trim();
  }

  // Head: `R<digit>` or `R<digit>:<axis>`.
  const headMatch = head.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_]*))?$/);
  if (!headMatch) {
    return {
      directive: null,
      diagnostic: makeDiag(
        `malformed @repeat head: expected 'R<i>[:<axis>]', got '${truncate(head, 32)}'`,
        regionId,
        blockId,
        line,
        0,
      ),
    };
  }
  const name = headMatch[1] ?? '';
  const axisRaw = headMatch[2] ?? 'sequential';
  const axis = normalizeAxis(axisRaw);

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
    name,
    axis,
    formula: right,
    max,
    blockId: repeatBlockId,
    line,
    column: 0,
  };
  return { directive, diagnostic: null };
}

function parseMap(
  tail: string,
  line: number,
  regionId: string,
  blockId: string,
): LineParse {
  // Pattern: <var> <- <formula>
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
  const formula = tail.slice(arrow + 2).trim();
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
  const directive: MapDirective = {
    kind: 'map',
    var: parsed.name,
    ...(parsed.internalName ? { internalName: parsed.internalName } : {}),
    formula,
    blockId,
    line,
    column: 0,
  };
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
): Diagnostic {
  return {
    severity: 'warn',
    code: 'gpu.dsl_syntax_error',
    message,
    regionId,
    blockId,
    line,
    column,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + 'â¦';
}
