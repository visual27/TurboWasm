import { describe, expect, it } from 'vitest';
import { COMPARE_VALUES, loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 1-A — Vitest port of
 * `vendored/scratch-vm/test/unit/tw_jsexecute.js` that pins the
 * semantically-invariant short-circuit `compareEqual` /
 * `compareGreaterThan` / `compareLessThan` implementations to
 * `Cast.compare`. The upstream TAP test runs the same Cartesian product
 * over the `VALUES` matrix; the vitest port runs the same matrix and
 * reports the first failure per direction with the offending inputs.
 *
 * The patch (`patches/vendored/scratch-vm.patch`, hunk on
 * `src/compiler/jsexecute.js:288`) replaces the legacy
 * `(typeof fast-path || v1 === v2) ? v1 === v2 : compareEqualSlow`
 * expression with a block-form short-circuit:
 *
 * ```js
 * const compareEqual = (v1, v2) => {
 *     if (v1 === v2) return true;
 *     if (typeof v1 === 'number' && typeof v2 === 'number' && !isNaN(v1) && !isNaN(v2)) {
 *         return false;
 *     }
 *     return compareEqualSlow(v1, v2);
 * };
 * ```
 *
 * Both shapes are semantically invariant across the `VALUES` matrix —
 * the test below is the regression net that catches drift in either
 * direction.
 */
describe('Phase 1-A — compareEqual short-circuit (vendored scratch-vm unit)', () => {
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

  it('runtimeFunctions object exposes compareEqual/compareGreaterThan/compareLessThan', () => {
    expect(typeof vm.jsexecute.scopedEval('compareEqual')).toBe('function');
    expect(typeof vm.jsexecute.scopedEval('compareGreaterThan')).toBe('function');
    expect(typeof vm.jsexecute.scopedEval('compareLessThan')).toBe('function');
  });

  // The full Cartesian product. Errors are collected so the test
  // reports every mismatch in a single run — useful when debugging
  // a regression that affects multiple input pairs.
  it('compareEqual / compareGreaterThan / compareLessThan match Cast.compare across the VALUES matrix', () => {
    const failures: string[] = [];
    for (const a of COMPARE_VALUES) {
      for (const b of COMPARE_VALUES) {
        const cast = vm.cast.compare(a, b);
        if (compareEqual(a, b) !== (cast === 0)) {
          failures.push(`compareEqual(${stringify(a)}, ${stringify(b)}) = ${compareEqual(a, b)} (expected ${cast === 0})`);
        }
        if (compareGreaterThan(a, b) !== (cast > 0)) {
          failures.push(`compareGreaterThan(${stringify(a)}, ${stringify(b)}) = ${compareGreaterThan(a, b)} (expected ${cast > 0})`);
        }
        if (compareLessThan(a, b) !== (cast < 0)) {
          failures.push(`compareLessThan(${stringify(a)}, ${stringify(b)}) = ${compareLessThan(a, b)} (expected ${cast < 0})`);
        }
      }
    }
    if (failures.length > 0) {
      // Show the first 20 to keep the report readable.
      throw new Error(`${failures.length} mismatches. First 20:\n${failures.slice(0, 20).join('\n')}`);
    }
  });

  // Targeted regression cases for the edge conditions the short-circuit
  // specifically changes:
  //  - v1 === v2 (including 0/-0, NaN, Infinity pairs, identical strings)
  //  - mixed types that fail the legacy (typeof v1 === 'number' && typeof v2 === 'number' && !isNaN...) &&
  //    still resolve to false on strict equality
  it('compareEqual returns true for identical references (the short-circuit fast path)', () => {
    const cases: ReadonlyArray<readonly [unknown, unknown]> = [
      [0, 0],
      [-0, -0],
      [0, -0],
      [1, 1],
      ['hello', 'hello'],
      ['', ''],
      [true, true],
      [false, false],
      [Infinity, Infinity],
      [-Infinity, -Infinity],
      [NaN, NaN],
    ];
    for (const [a, b] of cases) {
      expect(compareEqual(a, b), `${stringify(a)} === ${stringify(b)}`).toBe(true);
    }
  });

  it('compareEqual returns false for finite numbers that are not strictly equal (the typeof fast path)', () => {
    const cases: ReadonlyArray<readonly [unknown, unknown]> = [
      [1, 2],
      [0, 1],
      [-1, 1],
      [Number.MAX_VALUE, Number.MIN_VALUE],
      [1e6, 1e-6],
    ];
    for (const [a, b] of cases) {
      expect(compareEqual(a, b), `${stringify(a)} === ${stringify(b)}`).toBe(false);
    }
  });

  it('compareEqual falls through to compareEqualSlow for mixed-type operands', () => {
    // The short-circuit's fast-false path is gated on
    // `typeof a === 'number' && typeof b === 'number' && !NaN`. As
    // soon as one side is a non-number, control falls into
    // `compareEqualSlow` (= the legacy semantics). Each expectation
    // below is pinned by the upstream `tw_jsexecute.js` test — the
    // scratch-vm behaviour for these pairs is `compareEqual(...) ===
    // (Cast.compare(...) === 0)`.
    expect(compareEqual('5', 5)).toBe(true); // Scratch "5" == 5 (case-insensitive after coerce)
    expect(compareEqual('hello', 'HELLO')).toBe(true); // case-insensitive equality
    expect(compareEqual('0', '')).toBe(false);
    expect(compareEqual(true, 'true')).toBe(true);
    expect(compareEqual(false, 'false')).toBe(true);
    // `'' === 0` evaluates to `false` under scratch's coercion:
    // compareEqualSlow treats `''` as NaN (because `'' === 0` and
    // isNotActuallyZero('') === true), then falls into the string
    // compare path (`'' < '0'` lexicographically => -1, not equal).
    expect(compareEqual('', 0)).toBe(false);
  });
});

function stringify(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (Object.is(v, -0)) return '-0';
    return String(v);
  }
  return String(v);
}