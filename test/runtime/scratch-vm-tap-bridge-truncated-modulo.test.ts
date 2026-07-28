import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 8-A — truncated modulo (= JS `%` instead of Scratch floored).
 *
 * Verifies the runtime gate `semantics.truncatedModulo` on both
 * execution paths:
 *
 *  - `runtimeFunctions.mod` (= the legacy floored helper, the OFF
 *    path). When the OP_MOD case emits `mod(left, right)`, this is
 *    the function that gets called. Verified by `scopedEval`-ing the
 *    helper out of the runtime and exercising it across the
 *    `dividend / divisor` sign matrix.
 *  - JS `%` (= the truncated path, the ON path). The OP_MOD case
 *    emits `(${left} % ${right})` when the flag is on, so the source
 *    is `a % b`. We verify the OFF/ON emission shapes against the
 *    vendored `jsgen.js` source (= the patch is structural, the
 *    runtime is unchanged from the OFF perspective).
 *
 * The interpreter path (`scratch3_operators.js:mod`) is verified by
 * source-level marker + signature checks. The integration smoke
 * (= Playwright + the `truncated-modulo-fixture.sb3` runner) covers
 * end-to-end behaviour.
 */
describe('Phase 8-A — truncated modulo (vendored scratch-vm unit)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // The runtime helper `mod` (= the OFF / floored path). Used as the
  // reference for the legacy behaviour.
  const mod = vm.jsexecute.scopedEval('mod') as (n: number, modulus: number) => number;
  // The truncated reference = plain JS `%` operator. Reproduced
  // here so the cross-check is independent of the patched source.
  const truncatedMod = (n: number, modulus: number): number => n % modulus;

  it('runtimeFunctions object exposes the mod helper (= legacy floored path)', () => {
    expect(typeof mod).toBe('function');
  });

  it('mod with positive operands matches truncatedMod (= both modes agree)', () => {
    for (const a of [0, 1, 2, 5, 10, 100]) {
      for (const b of [1, 2, 3, 7]) {
        expect(mod(a, b)).toBe(truncatedMod(a, b));
      }
    }
  });

  it('mod with negative dividend diverges from truncatedMod (= 1 vs -2)', () => {
    // Scratch floored: (-5) mod 3 = 1 (sign of divisor)
    // JS truncated:    (-5) %  3 = -2 (sign of dividend)
    expect(mod(-5, 3)).toBe(1);
    expect(truncatedMod(-5, 3)).toBe(-2);
    expect(mod(-7, 4)).toBe(1);
    expect(truncatedMod(-7, 4)).toBe(-3);
  });

  it('mod with negative divisor diverges from truncatedMod (= -1 vs 2)', () => {
    // Scratch floored: 5 mod (-3) = -1 (sign of divisor)
    // JS truncated:    5 %  (-3) = 2  (sign of dividend)
    expect(mod(5, -3)).toBe(-1);
    expect(truncatedMod(5, -3)).toBe(2);
    expect(mod(7, -4)).toBe(-1);
    expect(truncatedMod(7, -4)).toBe(3);
  });

  it('mod with both negative operands agrees with truncatedMod (both = -2 / -2)', () => {
    expect(mod(-5, -3)).toBe(-2);
    expect(truncatedMod(-5, -3)).toBe(-2);
    expect(mod(-7, -4)).toBe(-3);
    expect(truncatedMod(-7, -4)).toBe(-3);
  });

  it('mod with zero dividend returns 0 (= both modes agree)', () => {
    expect(mod(0, 5)).toBe(0);
    expect(truncatedMod(0, 5)).toBe(0);
    // 0 mod -5: result = 0 % -5 = 0 (positive, not -0) in JS;
    // 0 / -5 = -0, and -0 < 0 is false, so the floored correction
    // does NOT add modulus. Both paths return 0.
    expect(mod(0, -5)).toBe(0);
    expect(truncatedMod(0, -5)).toBe(0);
  });

  it('mod with -0 dividend: floored = 0, truncated = -0 (Object.is sensitive)', () => {
    // (-0) mod 3: floored path triggers `result / modulus < 0`
    // (because -0 / 3 = -0 < 0) and adds `modulus` → returns 3.
    // Actually wait: -0 / 3 = -0. Is -0 < 0? Yes (`Object.is(-0, 0)` is
    // false; `-0 < 0` is `false` in JS though). Let me re-check:
    //   -0 / 3 = -0
    //   -0 < 0 → false (JS treats -0 and 0 as equal in comparison)
    // So the floored path does NOT add modulus, returning -0.
    expect(Object.is(mod(-0, 3), -0)).toBe(true);
    // JS-truncated path: -0 % 3 = -0.
    expect(Object.is(truncatedMod(-0, 3), -0)).toBe(true);
  });

  it('mod with zero divisor returns NaN (= both modes agree)', () => {
    expect(Number.isNaN(mod(5, 0))).toBe(true);
    expect(Number.isNaN(mod(-5, 0))).toBe(true);
    expect(Number.isNaN(truncatedMod(5, 0))).toBe(true);
    expect(Number.isNaN(truncatedMod(-5, 0))).toBe(true);
  });

  it('mod with Infinity dividend returns NaN (= both modes agree)', () => {
    expect(Number.isNaN(mod(Infinity, 3))).toBe(true);
    expect(Number.isNaN(truncatedMod(Infinity, 3))).toBe(true);
    expect(Number.isNaN(mod(-Infinity, 3))).toBe(true);
    expect(Number.isNaN(truncatedMod(-Infinity, 3))).toBe(true);
  });

  it('mod with Infinity divisor returns the dividend (= both modes agree)', () => {
    expect(mod(5, Infinity)).toBe(5);
    expect(truncatedMod(5, Infinity)).toBe(5);
  });
});

/**
 * Phase 8-A — OP_MOD emit (compiled path) and the interpreter
 * `scratch3_operators.mod`. Both are verified by source-level
 * checks so the test is robust to vendored-scratch-vm not being
 * set up.
 */
describe('Phase 8-A — OP_MOD emit + interpreter mod (source shape)', () => {
  const JSGEN = resolve(
    process.cwd(),
    'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsgen.js',
  );
  const OPS = resolve(
    process.cwd(),
    'vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_operators.js',
  );
  if (!existsSync(JSGEN) || !existsSync(OPS)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const jsgenSource = readFileSync(JSGEN, 'utf8');
  const opsSource = readFileSync(OPS, 'utf8');

  it('jsgen.js carries the // TurboWasm: truncated-modulo marker', () => {
    expect(jsgenSource).toContain('// TurboWasm: truncated-modulo');
  });

  it('jsgen.js OP_MOD case branches on semantics.truncatedModulo', () => {
    // The case body reads the flag and emits either the JS `%` form
    // or the `mod(...)` wrapper.
    expect(jsgenSource).toMatch(/this\.target\.runtime\.compilerOptions\.semantics/);
    expect(jsgenSource).toMatch(/sem\.truncatedModulo/);
  });

  it('jsgen.js OP_MOD ON path emits the JS `%` operator', () => {
    expect(jsgenSource).toMatch(/return `\(\$\{left\} % \$\{right\}\)`/);
  });

  it('jsgen.js OP_MOD OFF path emits the legacy `mod(...)` wrapper', () => {
    expect(jsgenSource).toMatch(/return `mod\(\$\{left\}, \$\{right\}\)`/);
  });

  it('scratch3_operators.js carries the // TurboWasm: truncated-modulo-interpreter marker', () => {
    expect(opsSource).toContain('// TurboWasm: truncated-modulo-interpreter');
  });

  it('scratch3_operators.js mod reads the flag from runtime.compilerOptions.semantics', () => {
    expect(opsSource).toMatch(/this\.runtime\.compilerOptions\.semantics/);
    expect(opsSource).toMatch(/sem\.truncatedModulo/);
  });

  it('scratch3_operators.js mod ON path returns `n % modulus` (= JS)', () => {
    expect(opsSource).toMatch(/return n % modulus/);
  });

  it('scratch3_operators.js mod OFF path preserves the legacy floored logic', () => {
    // The legacy floored correction is intact.
    expect(opsSource).toMatch(/if \(result \/ modulus < 0\) result \+= modulus/);
  });
});
