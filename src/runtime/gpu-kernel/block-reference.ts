/**
 * Single source of truth for resolving a scratch-vm block reference from
 * any of the raw shapes that appear in `inputs` / `fields` slots across
 * the GPU kernel pipeline.
 *
 * ## Why this exists (§15.15)
 *
 * `region-extractor.ts`, `block-subset.ts`, `axis-analysis.ts`,
 * `scratch-block-expr.ts`, `implicit-axis.ts`, and `wgsl-emitter.ts`
 * each carried their own reference-shape accept logic before Phase 1.
 * That made hand-built unit-test DTOs drift from real SB3 shape, and
 * loader-side fixes (root + per-target comment merge) couldn't fix
 * downstream gaps without rewriting every helper in lockstep.
 *
 * ## Accepted shapes
 *
 * SB3 raw block references can take any of these forms in `inputs`:
 *
 *   1. bare string: `"abc"`                                              (legacy)
 *   2. object `{ id: "abc" }`                                            (vendored VM)
 *   3. object `{ id: "abc", name: "foo" }`                              (vendored VM with menu)
 *   4. object `{ block: "abc", shadow: "xyz" }`                         (input-shape `{block, shadow}`)
 *   5. array  `[2, "abc"]`     (= `INPUT_BLOCK_NO_SHADOW` in sb3.js)
 *   6. array  `[1, "abc"]`     (= `INPUT_SAME_BLOCK_SHADOW` in sb3.js)
 *   7. array  `[3, "abc"]`     (= `INPUT_DIFF_BLOCK_SHADOW` in sb3.js)  — same handling as (5)
 *   8. nested: `[2, { id: "abc" }]`, `[2, [2, "abc"]]`                   (recursive)
 *   9. numeric: `42` (legacy VM serialised ids as numbers)               → `"42"`
 *
 * For `fields` slots (e.g. `data_variableof.fields.VARIABLE`):
 *
 *   - `{ id: "...", name: "..." }` is the canonical scratch-vm variable ref
 *   - bare string is the legacy / hand-built shape
 *   - `[name, null]` is the primitive field shape; this helper extracts
 *     the first string when applicable but most callers want
 *     `extractStringField` instead. See §15.15 doc for the split.
 *
 * ## What this helper does NOT do
 *
 * - It does not look up the block in a `blocks` map. The caller decides
 *   whether the returned id actually resolves. `wgsl-emitter.ts`'s
 *   `blockReference(input, blocks)` wraps this helper with the map check.
 * - It does not decode literal payloads. `[shadow_opcode, [reporter_opcode,
 *   value]]` (e.g. `[10, ['math_number', '5']]`) is detected and
 *   rejected with `null` — that's `axis-analysis.ts:isZeroLiteralShadow`'s
 *   job, not ours.
 * - It does not normalise / mutate the input. Callers keep their parsed
 *   shape intact; this helper is pure.
 */

const INPUT_SAME_BLOCK_SHADOW = 1;
const INPUT_BLOCK_NO_SHADOW = 2;
const INPUT_DIFF_BLOCK_SHADOW = 3;

/**
 * Numeric shadow opcodes that `sb3.js` uses to inline primitives (no
 * separate block in `blocks`). When `extractBlockReference` sees these
 * as the head element of an array, the array is a literal payload, not
 * a block reference, and we return `null`.
 *
 * `10` = `math_number` (the only shadow opcode the gpu-kernel pipeline
 * needs to special-case). Other shadow opcodes (string, colour picker,
 * ...) are not used inside `@compute` regions.
 */
const LITERAL_SHADOW_OPCODES: ReadonlySet<number> = new Set([10]);

/**
 * Resolve a scratch-vm block reference from any of the raw shapes
 * documented above. Returns the block id as a string, or `null` when
 * the input is empty, malformed, or a literal payload.
 *
 * Recursion is bounded by SB3 nesting depth in practice (~3); we leave
 * it unbounded because the helper is pure and cheap, and stack depth in
 * jsdom comfortably handles even pathological SB3 inputs.
 */
export function extractBlockReference(input: unknown): string | null {
  if (input === null || input === undefined) return null;

  // (1) bare string.
  if (typeof input === 'string') return input;

  // (9) numeric legacy id.
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return String(input);
  }

  if (Array.isArray(input)) {
    // (5)/(6)/(7) `[shadowKind, blockRef]` arrays.
    if (input.length >= 2 && typeof input[0] === 'number') {
      const head = input[0] as number;
      if (LITERAL_SHADOW_OPCODES.has(head)) {
        // Literal payload like `[10, ['math_number', '5']]` — not a block ref.
        return null;
      }
      if (
        head === INPUT_SAME_BLOCK_SHADOW ||
        head === INPUT_BLOCK_NO_SHADOW ||
        head === INPUT_DIFF_BLOCK_SHADOW
      ) {
        // `input[1]` is itself a block ref (string, object, or nested array).
        return extractBlockReference(input[1]);
      }
      // Unknown numeric head — fall through to per-element search so we
      // still recover when the SB3 producer uses a non-standard opcode.
    }
    // Defensive fallback: scan every element. This keeps us robust
    // against array variants we haven't enumerated (e.g. a single-element
    // array that wraps the block id for some legacy serializer).
    for (const item of input) {
      const result = extractBlockReference(item);
      if (result !== null) return result;
    }
    return null;
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // (2)/(3) `{ id }` and `{ id, name }`.
    if (typeof obj['id'] === 'string') return obj['id'];
    // (4) `{ block, shadow }`. `block` is the real reporter, `shadow` is
    // the unobscured shadow that sits underneath it. We prefer `block` so
    // downstream walk recurses into the reporter, then fall back to
    // `shadow` for legacy `{ shadow: "..." }`-only shapes.
    if (typeof obj['block'] === 'string') return obj['block'];
    if (typeof obj['shadow'] === 'string') return obj['shadow'];
  }

  return null;
}
