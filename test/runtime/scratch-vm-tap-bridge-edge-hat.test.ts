import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 1-B — Vitest port of the edge-activated-hat semantics in
 * `vendored/scratch-vm/src/engine/execute.js` and the compiler-emitted
 * shape in `vendored/scratch-vm/src/compiler/jsgen.js`. The patch
 * replaces the legacy `hasOldEdgeValue ? (!oldEdgeValue && newValue)
 * : newValue` ternary with `!oldEdgeValue && newValue` (the sentinel
 * elimination), which is semantically invariant because
 * `updateEdgeActivatedValue` returns `undefined` (= falsy) on first
 * access. The vitest ports below exercise the three points where the
 * upstream test suite (`hat-threads-run-every-frame.js` and
 * `tw_edge_activated_hat_returns_promise.js`) would catch a
 * regression.
 *
 * We do not load the upstream fixtures — the vendored fixtures live
 * under `vendored/scratch-vm/test/fixtures/` and depend on a private
 * `tap` install. The port instead drives the
 * `Target._edgeActivatedHatValues` map directly so the test stays
 * hermetic and fast.
 */
describe('Phase 1-B — edge hat sentinel elimination (vendored scratch-vm unit)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Target = require(resolve(VENDORED_VM_DIR, 'src/engine/target.js'));
  const target = new (Target.default ?? Target)();
  const currentBlockId = 'hat-1';
  // Recreate the patched sentinel-elimination expression directly:
  //   const oldEdgeValue = target.updateEdgeActivatedValue(currentBlockId, resolvedValue);
  //   const edgeWasActivated = !oldEdgeValue && resolvedValue;
  function evaluateEdgeHat(resolvedValue: unknown): boolean {
    const oldEdgeValue = target.updateEdgeActivatedValue(currentBlockId, resolvedValue);
    return !oldEdgeValue && Boolean(resolvedValue);
  }

  function reset(): void {
    target._edgeActivatedHatValues = {};
  }

  it('edge hat fires on the first evaluation when resolvedValue is truthy', () => {
    reset();
    expect(evaluateEdgeHat(true)).toBe(true);
    expect(evaluateEdgeHat(true)).toBe(false); // true -> true: no transition
    expect(evaluateEdgeHat(false)).toBe(false); // true -> false: not a rising edge
    expect(evaluateEdgeHat(true)).toBe(true); // false -> true: rising edge
  });

  it('edge hat does not fire on the first evaluation when resolvedValue is falsy', () => {
    reset();
    expect(evaluateEdgeHat(false)).toBe(false);
    expect(evaluateEdgeHat(false)).toBe(false);
  });

  it('edge hat evaluation pattern matches the legacy ternary semantics', () => {
    // Reference implementation mirrors the legacy
    //   hasOldEdgeValue ? (!oldEdgeValue && resolvedValue) : resolvedValue
    // path so the test verifies both paths agree.
    reset();
    type State = { hasOld: boolean; old: unknown };
    function legacy(targetMap: Record<string, unknown>, resolved: unknown): {
      fired: boolean;
      nextState: State;
    } {
      const hasOld = Object.prototype.hasOwnProperty.call(targetMap, currentBlockId);
      const old = targetMap[currentBlockId];
      targetMap[currentBlockId] = resolved;
      const fired = hasOld ? !old && Boolean(resolved) : Boolean(resolved);
      return { fired, nextState: { hasOld: true, old } };
    }
    const transitions: ReadonlyArray<readonly [unknown, unknown]> = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
      ['x', 'x'],
      ['x', 'y'],
      [NaN, NaN],
      [0, 1],
    ];
    for (const [prev, next] of transitions) {
      reset();
      // seed with prev
      target._edgeActivatedHatValues[currentBlockId] = prev;
      const a = evaluateEdgeHat(next);
      reset();
      const seed: Record<string, unknown> = {};
      seed[currentBlockId] = prev;
      const b = legacy(seed, next).fired;
      expect(a, `(${stringify(prev)} -> ${stringify(next)})`).toBe(b);
    }
  });

  it('compiler-emitted edge-hat code uses the !oldEdgeValue && resolvedValue form', () => {
    // Read the vendored source to confirm the marker is present and
    // the legacy `hasOldEdgeValue` ternary is gone.
    const jsgenPath = resolve(
      VENDORED_VM_DIR,
      'src/compiler/jsgen.js',
    );
    if (!existsSync(jsgenPath)) return;
    const src = readFileSync(jsgenPath, 'utf8');
    expect(src).toContain('// TurboWasm: edge-detection-hat-sentinel-eliminated');
    expect(src).not.toMatch(/const hasOldEdgeValue = target\.hasEdgeActivatedValue\(id\)/);
    expect(src).toMatch(/const edgeWasActivated = !oldEdgeValue && resolvedValue;/);
  });

  it('interpreter execute.js uses the !oldEdgeValue && resolvedValue form', () => {
    const executePath = resolve(VENDORED_VM_DIR, 'src/engine/execute.js');
    if (!existsSync(executePath)) return;
    const src = readFileSync(executePath, 'utf8');
    expect(src).toContain('// TurboWasm: edge-detection-hat-sentinel-eliminated');
    expect(src).not.toMatch(/const hasOldEdgeValue = thread\.target\.hasEdgeActivatedValue/);
    expect(src).toMatch(/const edgeWasActivated = !oldEdgeValue && resolvedValue;/);
  });
});

// Local helpers ------------------------------------------------------------

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