/**
 * D3 cascade analysis: cycles in the `@map` DAG, missing `@map` for
 * declared `@repeat Ri:<axis>`, and the (D1 already covers the rest of
 * the cascade; this module only sees regions that passed D1's block
 * subset).
 *
 * The dependency graph is built by tokenising each `@map` formula and
 * noting which `@map` names it references. The tokeniser only yields
 * identifiers — numeric literals, operators, and WGSL reserved keywords
 * are dropped so the DAG reflects actual variable references. The WGSL
 * emitter does the deeper reference scan in M4.
 */

import type {
  CascadeVerdict,
  Diagnostic,
  ExtractedRegion,
  MapDirective,
  ParsedDirective,
  ParsedProject,
  RepeatDirective,
} from './types';

const RESERVED_DSL_KEYWORDS: ReadonlySet<string> = new Set([
  'global_invocation_id',
  'local_invocation_id',
  'workgroup_id',
  'builtin',
  'dispatch',
  'compute',
]);

const RESERVED_WGSL_KEYWORDS: ReadonlySet<string> = new Set([
  'array',
  'bool',
  'f32',
  'i32',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'mat2x2',
  'mat3x3',
  'mat4x4',
  'struct',
  'let',
  'var',
  'const',
  'if',
  'else',
  'for',
  'while',
  'loop',
  'return',
  'true',
  'false',
  'select',
  'min',
  'max',
  'clamp',
  'sin',
  'cos',
  'pow',
  'exp',
  'log',
  'floor',
  'ceil',
  'fract',
  'abs',
  'sqrt',
  'mix',
  'step',
  'length',
  'normalize',
  'inverse',
  'transpose',
  'dot',
  'cross',
  'distance',
  'reflect',
]);

export interface CascadeAnalysisInput {
  region: ExtractedRegion;
  directives: readonly ParsedDirective[];
  project: ParsedProject;
  /** Axes that survived D2. Used to know which `@repeat` must have a `@map`. */
  survivedAxes: Set<string>;
}

export function analyzeCascade(input: CascadeAnalysisInput): CascadeVerdict {
  const { region, directives } = input;
  const diagnostics: Diagnostic[] = [];
  const maps = directives.filter((d): d is MapDirective => d.kind === 'map');
  const repeats = directives.filter((d): d is RepeatDirective => d.kind === 'repeat');

  // Identifier collision warnings (the emitter will rename in M4, but we
  // surface a warning here so the user can rename their variable).
  for (const m of maps) {
    if (RESERVED_DSL_KEYWORDS.has(m.var) || RESERVED_WGSL_KEYWORDS.has(m.var)) {
      diagnostics.push({
        severity: 'warn',
        code: 'gpu.identifier_collision',
        message: `@map var '${m.var}' collides with a reserved identifier; emitter will rename`,
        regionId: region.regionId,
        blockId: m.blockId,
        line: m.line,
      });
    }
  }

  // Build a sparse adjacency map: name → list of names it references
  // among the other `@map` declarations.
  const referencedBy = new Map<string, Set<string>>();
  const names = new Set(maps.map((m) => m.var));
  for (const m of maps) {
    const refSet = new Set<string>();
    const tokens = tokeniseFormula(m.formula);
    for (const t of tokens) {
      if (t === m.var) continue;
      if (!names.has(t)) continue;
      // Reserved keywords are never declared as @map names, but defend
      // against future name overlap by skipping them here too.
      if (RESERVED_DSL_KEYWORDS.has(t) || RESERVED_WGSL_KEYWORDS.has(t)) continue;
      refSet.add(t);
    }
    referencedBy.set(m.var, refSet);
  }

  // Detect cycles via DFS coloring. Any cycle in the graph → D3.
  const cycle = detectCycle(maps, referencedBy);
  if (cycle) {
    const diag: Diagnostic = {
      severity: 'warn',
      code: 'd3.region_cascade_demoted',
      message: `region '${region.regionId}' has a @map cycle (${cycle.join(' -> ')}); D3 demote, falling back to JS`,
      regionId: region.regionId,
    };
    return {
      valid: false,
      demoteReason: 'd3',
      diagnostics: [diag, ...diagnostics],
      topoOrder: [],
    };
  }

  // Each `@repeat Ri:<axis>` (where `axis` survived D2) must have an `@map Ri`.
  for (const r of repeats) {
    if (r.axis === 'sequential') continue;
    if (!input.survivedAxes.has(r.name)) continue;
    if (!names.has(r.name)) {
      const diag: Diagnostic = {
        severity: 'warn',
        code: 'd3.region_cascade_demoted',
        message: `region '${region.regionId}' has @repeat '${r.name}' without @map '${r.name}'; D3 demote, falling back to JS`,
        regionId: region.regionId,
      };
      return {
        valid: false,
        demoteReason: 'd3',
        diagnostics: [diag, ...diagnostics],
        topoOrder: [],
      };
    }
  }

  // Topologically sort the @map declarations.
  const topoOrder = topoSort(maps, referencedBy);

  return { valid: true, diagnostics, topoOrder };
}

/**
 * Tokenize an `@map` formula into identifier tokens. Drops:
 *   - numeric literals (e.g. `0`, `1.5`, `-3`, `6.022e23`)
 *   - WGSL keywords (`sqrt`, `floor`, `let`, `var`, ...)
 *   - DSL keywords (`global_invocation_id`, ...)
 *
 * Numeric and keyword tokens never participate in the `@map` DAG, so
 * including them produced false references (e.g. `@map a <- b + 1`
 * used to treat `1` as a candidate dependency).
 *
 * §Phase 3 §15.11 — quoted-string segments (`"my axis"`) are
 * extracted first and pushed as a single surface-name token so the
 * DAG sees `"my axis"` as one identifier reference. Escape handling
 * mirrors `comment-parser.ts:parseNameToken` (`\"` → `"`, `\\` → `\`).
 */
function tokeniseFormula(formula: string): string[] {
  const tokens: string[] = [];
  // 1. Strip quoted segments; record their unescaped content as a
  // single surface-name token before identifier regex runs.
  const stripped = formula.replace(/"((?:[^"\\]|\\.)*)"/g, (_match, body: string) => {
    const unescaped = body.replace(/\\(.)/g, '$1');
    tokens.push(unescaped);
    return ' ';
  });
  const re = /[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const tok = match[0];
    // Drop numeric literals: leading digit → skip.
    if (/^[0-9]/.test(tok)) continue;
    tokens.push(tok);
  }
  return tokens;
}

/**
 * Returns the cycle path as `[a, b, c, a]` or `null` when there is no
 * cycle. We use DFS with three-coloring.
 */
function detectCycle(
  maps: MapDirective[],
  referencedBy: Map<string, Set<string>>,
): string[] | null {
  enum Color {
    White,
    Gray,
    Black,
  }
  const color = new Map<string, Color>();
  const stack: string[] = [];
  for (const m of maps) color.set(m.var, Color.White);

  function visit(node: string): string[] | null {
    color.set(node, Color.Gray);
    stack.push(node);
    const children = referencedBy.get(node);
    if (children) {
      for (const next of children) {
        const c = color.get(next) ?? Color.White;
        if (c === Color.Gray) {
          const idx = stack.indexOf(next);
          if (idx >= 0) {
            const cyclePath = stack.slice(idx).concat(next);
            return cyclePath;
          }
          return [next, node];
        }
        if (c === Color.White) {
          const r = visit(next);
          if (r) return r;
        }
      }
    }
    stack.pop();
    color.set(node, Color.Black);
    return null;
  }

  for (const m of maps) {
    if ((color.get(m.var) ?? Color.White) === Color.White) {
      const r = visit(m.var);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Khan's algorithm: stable when there are no cycles (the cycle check
 * above guarantees it). The output is one valid topological order.
 *
 * Edges are oriented FROM a dependency TO a dependent. `referencedBy`
 * stores "from → set of vars it references in its formula" — which
 * translates to "from depends on each set member, so the edge is
 * `set member → from`" (the dependency must be processed first).
 */
function topoSort(
  maps: MapDirective[],
  referencedBy: Map<string, Set<string>>,
): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const m of maps) {
    inDegree.set(m.var, inDegree.get(m.var) ?? 0);
    adj.set(m.var, adj.get(m.var) ?? []);
  }
  for (const [dependent, deps] of referencedBy) {
    for (const dep of deps) {
      if (!inDegree.has(dep)) continue; // external reference; ignore
      // dep must come before dependent: edge dep → dependent.
      adj.get(dep)?.push(dependent);
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1);
    }
  }
  const q: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) q.push(name);
  }
  const order: string[] = [];
  while (q.length > 0) {
    const n = q.shift();
    if (n === undefined) continue;
    order.push(n);
    for (const m of adj.get(n) ?? []) {
      const d = (inDegree.get(m) ?? 0) - 1;
      inDegree.set(m, d);
      if (d === 0) q.push(m);
    }
  }
  return order;
}

// We deliberately ignore the unused `project` parameter on the input —
// the M5 dispatcher will need a real view of scratch-vm variables / lists
// and that's where cross-iteration access etc. would be re-checked. Here
// we only need the directives and the survived-axis set.
