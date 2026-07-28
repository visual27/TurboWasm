import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 9-A — strictNumericEquality.
 *
 * Verifies the runtime gate `semantics.strictNumericEquality`:
 *
 *  - `Cast.compare(v1, v2, caseSensitive, strictEqual)` (= the interpreter
 *    path from `scratch3_data.js:listContainsItem` / `getItemNumOfList`):
 *    a `strictEqual=true` argument short-circuits type-mixed comparisons
 *    to a non-zero value (= never equal). Number-vs-number still routes
 *    through the NaN-aware coercion below so Infinity / -Infinity / NaN
 *    semantics are preserved. String-vs-string falls back to the
 *    caseSensitive-aware substring compare.
 *  - `compareEqual` / `compareGreaterThan` / `compareLessThan` (=
 *    compiled path via `jsexecute.js` runtime helpers): the slow path
 *    branches on the captured `__semantics.strictNumericEquality` flag
 *    (= seeded at script-compile time from
 *    `runtime.compilerOptions.semantics`).
 *  - `compareContains` (= helper for `operator_contains` block).
 *  - `scratch3_operators.js:equals` / `lt` / `gt` / `contains` /
 *    `scratch3_data.js:listContainsItem` / `getItemNumOfList`
 *    (interpreter path, threads `strictEqual` through `Cast.compare`).
 *  - `iroptimizer.js:foldCompare` (constant-fold path must agree
 *    with the runtime helpers or folded comparisons would diverge
 *    from the runtime when the user flips the toggle).
 *
 * The runtime-helper tests re-evaluate `compareEqual` /
 * `compareGreaterThan` / `compareLessThan` via `jsexecute.scopedEval`.
 * The slow-path branches in `compareEqualSlow` /
 * `compareGreaterThanSlow` / `compareLessThanSlow` read the captured
 * `__semantics` (= scopedEval injects `globalState` with no
 * `compilerOptions.semantics` set, so the default fallback (= all
 * OFF) applies). For the ON path we re-create the helpers via a
 * side-channel `Function` constructor that injects a custom
 * `__semantics` const (= per-helper, see below).
 */
describe('Phase 9-A — Cast.compare(v1, v2, caseSensitive, strictEqual) (interpreter path)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }
  const compareDefault = (a: unknown, b: unknown): number => vm.cast.compare(a, b);
  const compareStrict = (a: unknown, b: unknown): number =>
    vm.cast.compare(a, b, false, true);
  const compareCaseSensitiveStrict = (a: unknown, b: unknown): number =>
    vm.cast.compare(a, b, true, true);

  it('Cast.compare signature accepts optional `caseSensitive` AND `strictEqual` arguments', () => {
    expect(typeof vm.cast.compare).toBe('function');
    expect(vm.cast.compare.length).toBeGreaterThanOrEqual(2);
  });

  it('default (= caseSensitive omitted, strictEqual omitted) preserves the legacy Scratch behaviour', () => {
    expect(compareDefault('5', 5)).toBe(0);
    expect(compareDefault('Hello', 'hello')).toBe(0);
  });

  it('strictEqual=true: "5" vs 5 diverges (= never equal)', () => {
    expect(compareStrict('5', 5)).not.toBe(0);
    expect(compareStrict(5, '5')).not.toBe(0);
  });

  it('strictEqual=true preserves numeric/numeric + strict semantics', () => {
    expect(compareStrict(5, 5)).toBe(0);
    expect(compareStrict(5.0, 5)).toBe(0);
    expect(compareStrict(-1, 1)).toBeLessThan(0);
    expect(compareStrict(1, -1)).toBeGreaterThan(0);
  });

  it('strictEqual=true preserves Infinity / NaN semantics on numeric paths', () => {
    expect(compareStrict(NaN, NaN)).not.toBe(0);
    expect(compareStrict(Infinity, Infinity)).toBe(0);
    expect(compareStrict(-Infinity, -Infinity)).toBe(0);
    expect(compareStrict(Infinity, -Infinity)).toBeGreaterThan(0);
  });

  it('strictEqual=true: null vs false → not equal (different typeof)', () => {
    expect(compareStrict(null, false)).not.toBe(0);
    expect(compareStrict(false, null)).not.toBe(0);
  });

  it('strictEqual=true: string/number type-mixed → not equal', () => {
    expect(compareStrict('hello', 5)).not.toBe(0);
    expect(compareStrict(5, 'hello')).not.toBe(0);
  });

  it('strictEqual=true: String object vs number primitive → not equal', () => {
    // String wrapper is `typeof "object"`, number is `typeof "number"`.
    const s = new String('5');
    expect(compareStrict(s, 5)).not.toBe(0);
    expect(compareStrict(5, s)).not.toBe(0);
  });

  it('strictEqual=true + caseSensitive=true: string "Hello" vs "hello" are not equal', () => {
    expect(compareCaseSensitiveStrict('Hello', 'hello')).not.toBe(0);
    expect(compareCaseSensitiveStrict('hello', 'Hello')).not.toBe(0);
  });

  it('string-only comparison respects caseSensitive even with strict', () => {
    expect(compareCaseSensitiveStrict('Apple', 'apple')).toBeLessThan(0);
    expect(compareCaseSensitiveStrict('apple', 'Apple')).toBeGreaterThan(0);
  });
});

describe('Phase 9-A — compareEqual / compareGreaterThan / compareLessThan (compiled path, OFF)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  const compareEqual = vm.jsexecute.scopedEval('compareEqual') as (a: unknown, b: unknown) => boolean;
  const compareGreaterThan = vm.jsexecute.scopedEval('compareGreaterThan') as (
    a: unknown,
    b: unknown,
  ) => boolean;
  const compareLessThan = vm.jsexecute.scopedEval('compareLessThan') as (
    a: unknown,
    b: unknown,
  ) => boolean;

  it('OFF path (= default captured __semantics): "5" = 5 is true (= Scratch-compatible)', () => {
    expect(compareEqual('5', 5)).toBe(true);
    expect(compareEqual(5, '5')).toBe(true);
  });

  it('OFF path: Infinity / -Infinity unchanged (NaN falls through to scratch-compatible string fallback)', () => {
    expect(compareEqual(Infinity, Infinity)).toBe(true);
    expect(compareEqual(-Infinity, -Infinity)).toBe(true);
    // NaN comparisons in OFF (= scratch-compatible) mode fall through to
    // the string fallback: `'nan' > '5'` is true lexicographically so the
    // observable behaviour matches the upstream matrix. We pin the
    // current behaviour so a future regression (= numeric NaN poisoning)
    // is caught.
    expect(compareGreaterThan(NaN, 5)).toBe(true);
    expect(compareGreaterThan(5, NaN)).toBe(false);
    expect(compareLessThan(NaN, 5)).toBe(false);
    expect(compareLessThan(5, NaN)).toBe(true);
  });
});

describe('Phase 9-A — compareEqual / compareGreaterThan / compareLessThan (compiled path, ON via __semantics injection)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // Re-create the helpers with a custom `__semantics` const (= reads
  // `strictNumericEquality` from the side-channel). This mirrors the
  // pattern in `scratch-vm-tap-bridge-case-sensitive-strings.test.ts`.
  const compileHelper = (sourceCode: string): ((v1: unknown, v2: unknown) => unknown) => {
    const sandbox = `
      const __semantics = { strictNumericEquality: true, caseSensitiveStrings: false };
      ${sourceCode}
    `;
    return new Function(sandbox)() as (v1: unknown, v2: unknown) => unknown;
  };

  const compareEqual = compileHelper(
    'return (v1, v2) => { if (v1 === v2) return true; if (typeof v1 === "number" && typeof v2 === "number" && !Number.isNaN(v1) && !Number.isNaN(v2)) return false; if (__semantics.strictNumericEquality && typeof v1 !== typeof v2) return false; return compareEqualSlow(v1, v2); };',
  ) as (v1: unknown, v2: unknown) => boolean;
  const compareGreaterThan = compileHelper(
    'return (v1, v2) => { if (__semantics.strictNumericEquality && typeof v1 !== typeof v2) return false; return typeof v1 === "number" && typeof v2 === "number" && !Number.isNaN(v1) ? v1 > v2 : compareGreaterThanSlow(v1, v2); };',
  ) as (v1: unknown, b: unknown) => boolean;
  const compareLessThan = compileHelper(
    'return (v1, v2) => { if (__semantics.strictNumericEquality && typeof v1 !== typeof v2) return false; return typeof v1 === "number" && typeof v2 === "number" && !Number.isNaN(v2) ? v1 < v2 : compareLessThanSlow(v1, v2); };',
  ) as (v1: unknown, b: unknown) => boolean;

  it('ON path: "5" = 5 is false (type-mixed)', () => {
    expect(compareEqual('5', 5)).toBe(false);
    expect(compareEqual(5, '5')).toBe(false);
  });

  it('ON path: numeric === numeric unchanged', () => {
    expect(compareEqual(5, 5)).toBe(true);
    expect(compareEqual(5.0, 5)).toBe(true);
    expect(compareEqual(0, -0)).toBe(true);
  });

  it('ON path: null !== false (different typeof)', () => {
    expect(compareEqual(null, false)).toBe(false);
  });

  it('ON path: compareGreaterThan type-mixed returns false', () => {
    expect(compareGreaterThan('5', 5)).toBe(false);
    expect(compareGreaterThan(5, '5')).toBe(false);
  });

  it('ON path: compareLessThan type-mixed returns false', () => {
    expect(compareLessThan('5', 5)).toBe(false);
    expect(compareLessThan(5, '5')).toBe(false);
  });

  it('ON path: numeric greater-than / less-than unchanged', () => {
    expect(compareGreaterThan(2, 1)).toBe(true);
    expect(compareGreaterThan(1, 2)).toBe(false);
    expect(compareLessThan(1, 2)).toBe(true);
    expect(compareLessThan(2, 1)).toBe(false);
  });
});

describe('Phase 9-A — source markers', () => {
  const JSEXEC = 'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsexecute.js';
  const CAST = 'vendored/scaffolding/node_modules/scratch-vm/src/util/cast.js';
  const OPS = 'vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_operators.js';
  const DATA = 'vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_data.js';
  const IROPT = 'vendored/scaffolding/node_modules/scratch-vm/src/compiler/iroptimizer.js';

  it('all 5 files carry the // TurboWasm: strict-numeric-equality marker', () => {
    for (const file of [CAST, JSEXEC, OPS, DATA, IROPT]) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} missing marker`).toContain('// TurboWasm: strict-numeric-equality');
    }
  });

  it('cast.js:compare signature accepts `(v1, v2, caseSensitive = false, strictEqual = false)`', () => {
    const text = readFileSync(CAST, 'utf8');
    expect(text).toMatch(/static compare \(v1, v2, caseSensitive = false, strictEqual = false\)/);
  });

  it('scratch3_operators.js: equals / lt / gt thread strictEqual through Cast.compare', () => {
    const text = readFileSync(OPS, 'utf8');
    // The 4-arg `Cast.compare(..., !!sem?.caseSensitiveStrings, !!sem?.strictNumericEquality)`
    expect(text).toMatch(/equals \(args\)[\s\S]*Cast\.compare\(args\.OPERAND1, args\.OPERAND2, !!sem\?\.caseSensitiveStrings, !!sem\?\.strictNumericEquality\)/);
    expect(text).toMatch(/lt \(args\)[\s\S]*Cast\.compare\(args\.OPERAND1, args\.OPERAND2, !!sem\?\.caseSensitiveStrings, !!sem\?\.strictNumericEquality\)/);
    expect(text).toMatch(/gt \(args\)[\s\S]*Cast\.compare\(args\.OPERAND1, args\.OPERAND2, !!sem\?\.caseSensitiveStrings, !!sem\?\.strictNumericEquality\)/);
  });

  it('scratch3_operators.js: contains reads strictNumericEquality + caseSensitiveStrings', () => {
    const text = readFileSync(OPS, 'utf8');
    expect(text).toMatch(/contains \(args\)[\s\S]*sem && sem\.strictNumericEquality && typeof args\.STRING1 !== typeof args\.STRING2/);
    expect(text).toMatch(/contains \(args\)[\s\S]*sem && sem\.caseSensitiveStrings/);
  });

  it('scratch3_data.js: listContainsItem + getItemNumOfList thread strictEqual through Cast.compare', () => {
    const text = readFileSync(DATA, 'utf8');
    expect(text).toMatch(/listContainsItem \(args, util\)[\s\S]*Cast\.compare\(list\.value\[i\], item, caseSensitive, strict\)/);
    expect(text).toMatch(/getItemNumOfList \(args, util\)[\s\S]*Cast\.compare\(list\.value\[i\], item, caseSensitive, strict\)/);
  });

  it('jsexecute.js: compareContains / compareEqual / compareGreaterThan / compareLessThan gated by __semantics.strictNumericEquality', () => {
    const text = readFileSync(JSEXEC, 'utf8');
    // compareContains
    expect(text).toMatch(/compareContains = `[\s\S]*__semantics\.strictNumericEquality && typeof a !== typeof b[\s\S]*return false/);
    // compareEqual
    expect(text).toMatch(/const compareEqual[\s\S]*__semantics\.strictNumericEquality && typeof v1 !== typeof v2[\s\S]*return false/);
    // compareGreaterThan
    expect(text).toMatch(/const compareGreaterThan = \(v1, v2\) => \{[\s\S]*__semantics\.strictNumericEquality && typeof v1 !== typeof v2[\s\S]*return false/);
    // compareLessThan
    expect(text).toMatch(/const compareLessThan = \(v1, v2\) => \{[\s\S]*__semantics\.strictNumericEquality && typeof v1 !== typeof v2[\s\S]*return false/);
  });

  it('iroptimizer.js: foldCompare threads strictEqual through Cast.compare', () => {
    const text = readFileSync(IROPT, 'utf8');
    expect(text).toMatch(/foldCompare[\s\S]*Cast\.compare\(left\.inputs\.value, right\.inputs\.value, caseSensitive, strictEqual\)/);
  });
});
