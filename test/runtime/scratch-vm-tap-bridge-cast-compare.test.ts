import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 1-C — Vitest port of the Infinity-handling in
 * `vendored/scratch-vm/src/util/cast.js`. The patch replaces the
 * legacy `Infinity === Infinity ? 0 : n1 - n2` special case with a
 * direct `<` / `>` comparison. Subtraction-based comparison cannot
 * distinguish `Infinity - Infinity === NaN` from the genuine NaN path,
 * which is why the legacy code short-circuited the Infinity-equal case
 * separately. The new shape is semantically invariant:
 *
 *   n1 = Infinity, n2 = Infinity       -> false / false -> 0
 *   n1 = -Infinity, n2 = -Infinity     -> false / false -> 0
 *   n1 = Infinity, n2 = -Infinity      -> false / true -> 1
 *   n1 = -Infinity, n2 = Infinity      -> true / false -> -1
 *   n1 = Infinity, n2 = finite>0       -> false / true -> 1
 *   n1 = finite>0, n2 = Infinity       -> true / false -> -1
 *   n1 = -Infinity, n2 = finite<0      -> true / false -> -1
 *   n1 = finite<0, n2 = -Infinity      -> false / true -> 1
 *
 * The test below pins each combination against the legacy subtraction
 * shape (re-implemented inline as `legacyCastCompare`) to confirm
 * both paths agree on every input pair.
 */
describe('Phase 1-C — Infinity branch removal in Cast.compare', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // Reference implementation of the legacy subtraction-based path.
  // The vendored `Cast.compare` is the patched version (= the new
  // shape); we want to verify both shapes agree on every input pair.
  function legacyCastCompare(v1: unknown, v2: unknown): number {
    let n1 = Number(v1);
    let n2 = Number(v2);
    if (n1 === 0 && isNotActuallyZero(v1)) {
      n1 = NaN;
    } else if (n2 === 0 && isNotActuallyZero(v2)) {
      n2 = NaN;
    }
    if (isNaN(n1) || isNaN(n2)) {
      const s1 = String(v1).toLowerCase();
      const s2 = String(v2).toLowerCase();
      if (s1 < s2) return -1;
      if (s1 > s2) return 1;
      return 0;
    }
    if (
      (n1 === Infinity && n2 === Infinity) ||
      (n1 === -Infinity && n2 === -Infinity)
    ) {
      return 0;
    }
    return n1 - n2;
  }

  function isNotActuallyZero(val: unknown): boolean {
    if (typeof val !== 'string') return false;
    for (let i = 0; i < val.length; i++) {
      const code = val.charCodeAt(i);
      if (code === 48 || code === 9) return false;
    }
    return true;
  }

  // The exhaustive cross-product that the Infinity branch specifically
  // affects. Listed explicitly so the test surfaces a per-pair diff if
  // the patch ever regresses.
  const INFINITY_VALUES: readonly unknown[] = [
    Infinity,
    -Infinity,
    0,
    -0,
    1,
    -1,
    1e-300,
    1e300,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    NaN,
  ];

  it('Cast.compare returns 0 for equal-Infinity pairs', () => {
    expect(vm.cast.compare(Infinity, Infinity)).toBe(0);
    expect(vm.cast.compare(-Infinity, -Infinity)).toBe(0);
  });

  it('Cast.compare handles Infinity against finite numbers', () => {
    expect(vm.cast.compare(Infinity, 0)).toBe(1);
    expect(vm.cast.compare(Infinity, 1)).toBe(1);
    expect(vm.cast.compare(Infinity, -1)).toBe(1);
    expect(vm.cast.compare(Infinity, -Infinity)).toBe(1);
    expect(vm.cast.compare(Infinity, Number.MAX_VALUE)).toBe(1);
    expect(vm.cast.compare(0, Infinity)).toBe(-1);
    expect(vm.cast.compare(-1, Infinity)).toBe(-1);
    expect(vm.cast.compare(-Infinity, 0)).toBe(-1);
    expect(vm.cast.compare(-Infinity, 1)).toBe(-1);
    expect(vm.cast.compare(-Infinity, Infinity)).toBe(-1);
    expect(vm.cast.compare(-Infinity, Number.MAX_VALUE)).toBe(-1);
    expect(vm.cast.compare(Number.MAX_VALUE, Infinity)).toBe(-1);
  });

  it('Cast.compare matches the legacy subtraction-based path across the Infinity × VALUE matrix', () => {
    const failures: string[] = [];
    for (const a of INFINITY_VALUES) {
      for (const b of INFINITY_VALUES) {
        const patched = vm.cast.compare(a, b);
        const legacy = legacyCastCompare(a, b);
        // The legacy subtraction-based path returns `n1 - n2` (= raw
        // Infinity for `Infinity - (-Infinity)`) while the patched
        // version normalises to -1 / 0 / 1. Both shapes agree on the
        // sign, which is the only thing the operator consumers care
        // about (`gt` reads `compare > 0`, `lt` reads `compare < 0`,
        // `equals` reads `compare === 0`). Compare by sign + zero, not
        // by raw value.
        const signMatch =
          (patched > 0) === (legacy > 0) &&
          (patched < 0) === (legacy < 0) &&
          (patched === 0) === (legacy === 0);
        if (!signMatch) {
          failures.push(`Cast.compare(${stringify(a)}, ${stringify(b)}) = ${patched} (sign differs from legacy ${legacy})`);
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} mismatches. First 20:\n${failures.slice(0, 20).join('\n')}`);
    }
  });

  it('vendored cast.js source carries the marker and no longer has the special branch', () => {
    const castPath = resolve(VENDORED_VM_DIR, 'src/util/cast.js');
    if (!existsSync(castPath)) return;
    const src = readFileSync(castPath, 'utf8');
    expect(src).toContain('// TurboWasm: comparison-infinity-branch-removed');
    // The marker comment legitimately references the literal
    // `n1 === Infinity && n2 === Infinity` (in the doc block) so the
    // regex must be code-only. Anchor on `if (` to skip comment
    // occurrences and on the line-start position to skip comment
    // lines starting with `//`.
    expect(src).not.toMatch(/^\s*if \(\s*\(n1 === Infinity/u);
    expect(src).toMatch(/if \(n1 < n2\) return -1;/);
    expect(src).toMatch(/if \(n1 > n2\) return 1;/);
  });
});

const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readFileSync } = require('node:fs') as typeof import('node:fs');

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