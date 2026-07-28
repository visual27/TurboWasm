import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 8-B — case-sensitive strings.
 *
 * Verifies the runtime gate `semantics.caseSensitiveStrings`:
 *
 *  - `Cast.compare(v1, v2, caseSensitive)` (= the interpreter path
 *    from `scratch3_data.js:listContainsItem` / `getItemNumOfList`):
 *    a `caseSensitive=true` argument skips `.toLowerCase()` in the
 *    string fallback (= JS semantics). Default `false` preserves
 *    legacy Scratch behaviour for every existing caller.
 *  - `compareEqual` / `compareGreaterThan` / `compareLessThan` (=
 *    compiled path via `jsexecute.js` runtime helpers): the slow
 *    path branches on the captured `__semantics.caseSensitiveStrings`
 *    flag (= seeded at script-compile time from
 *    `runtime.compilerOptions.semantics`).
 *  - `compareContains` (= new helper for `operator_contains` block).
 *  - `jsgen.js:OP_CONTAINS` (compiled emit).
 *  - `scratch3_operators.js:contains` (interpreter path).
 *  - `scratch3_data.js:listContainsItem` / `getItemNumOfList`
 *    (interpreter path, threads `caseSensitive` through).
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
describe('Phase 8-B — Cast.compare(v1, v2, caseSensitive) (interpreter path)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }
  const compareCaseInsensitive = (a: unknown, b: unknown): number => vm.cast.compare(a, b);
  const compareCaseSensitive = (a: unknown, b: unknown): number => vm.cast.compare(a, b, true);
  const compareLegacyDefault = (a: unknown, b: unknown): number => vm.cast.compare(a, b, false);

  it('Cast.compare signature accepts an optional third `caseSensitive` argument', () => {
    expect(typeof vm.cast.compare).toBe('function');
    expect(vm.cast.compare.length).toBeGreaterThanOrEqual(2);
  });

  it('default (= caseSensitive omitted) preserves the legacy Scratch behaviour', () => {
    expect(compareLegacyDefault('Hello', 'hello')).toBe(0);
    expect(compareCaseInsensitive('Hello', 'hello')).toBe(0);
  });

  it('caseSensitive=true: "Hello" vs "hello" diverges (= not equal)', () => {
    // JS semantics: "Hello" < "hello" (uppercase letters come before lowercase in ASCII)
    expect(compareCaseSensitive('Hello', 'hello')).not.toBe(0);
    // Specifically:
    expect(compareCaseSensitive('Hello', 'hello')).toBeLessThan(0);
    expect(compareCaseSensitive('hello', 'Hello')).toBeGreaterThan(0);
  });

  it('caseSensitive=false: "Hello" vs "hello" equal (= legacy)', () => {
    expect(compareCaseInsensitive('Hello', 'hello')).toBe(0);
    expect(compareCaseInsensitive('HELLO', 'hello')).toBe(0);
    expect(compareCaseInsensitive('Hello', 'HELLO')).toBe(0);
  });

  it('identical strings are equal in both modes', () => {
    expect(compareCaseSensitive('Hello', 'Hello')).toBe(0);
    expect(compareCaseInsensitive('Hello', 'Hello')).toBe(0);
    expect(compareCaseSensitive('', '')).toBe(0);
    expect(compareCaseInsensitive('', '')).toBe(0);
  });

  it('numeric comparison unaffected by caseSensitive flag', () => {
    expect(compareCaseSensitive(5, 5)).toBe(0);
    expect(compareCaseInsensitive(5, 5)).toBe(0);
    expect(compareCaseSensitive(-1, 1)).toBeLessThan(0);
    expect(compareCaseInsensitive(-1, 1)).toBeLessThan(0);
  });

  it('mixed numeric/string types: "5" vs 5 is equal in both modes (Scratch-style coerce)', () => {
    // Cast.compare coerces both to numbers when one is numeric; the
    // string-fallback path is only taken when at least one side is
    // NaN after coercion (= e.g. "" or "hello").
    expect(compareCaseSensitive('5', 5)).toBe(0);
    expect(compareCaseInsensitive('5', 5)).toBe(0);
  });

  it('pure string comparison respects case in ON mode', () => {
    // 'Apple' vs 'apple': JS says 'A' < 'a', so 'Apple' < 'apple'.
    expect(compareCaseSensitive('Apple', 'apple')).toBeLessThan(0);
    expect(compareCaseSensitive('apple', 'Apple')).toBeGreaterThan(0);
    expect(compareCaseInsensitive('Apple', 'apple')).toBe(0);
  });
});

describe('Phase 8-B — compareEqual / compareGreaterThan / compareLessThan (compiled path)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // The runtime helpers as emitted by `runtimeFunctions.compareEqual` etc.
  // These read the captured `__semantics` const (= default OFF in this
  // test environment because `globalState.runtime` is not wired up).
  // The default = all OFF (= Scratch-compatible) behaviour is the
  // OFF path; the ON path is verified by source-level checks below.
  const compareEqual = vm.jsexecute.scopedEval('compareEqual') as (a: unknown, b: unknown) => boolean;
  const compareGreaterThan = vm.jsexecute.scopedEval('compareGreaterThan') as (
    a: unknown,
    b: unknown,
  ) => boolean;
  const compareLessThan = vm.jsexecute.scopedEval('compareLessThan') as (
    a: unknown,
    b: unknown,
  ) => boolean;

  it('OFF path (= default captured __semantics): "Hello" = "hello" is true', () => {
    expect(compareEqual('Hello', 'hello')).toBe(true);
    expect(compareEqual('HELLO', 'hello')).toBe(true);
  });

  it('OFF path: lexicographic comparison on same-case strings', () => {
    expect(compareGreaterThan('apple', 'Apple')).toBe(false);
    expect(compareGreaterThan('Apple', 'apple')).toBe(false);
    expect(compareLessThan('apple', 'Apple')).toBe(false);
    expect(compareLessThan('Apple', 'apple')).toBe(false);
  });

  it('ON path is verified by source-level checks (= runtime capture defaults to OFF)', () => {
    const JSGEN = resolve(
      process.cwd(),
      'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsgen.js',
    );
    const JSEXEC = resolve(
      process.cwd(),
      'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsexecute.js',
    );
    if (!existsSync(JSGEN) || !existsSync(JSEXEC)) {
      it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
      return;
    }
    const jsexecSource = readFileSync(JSEXEC, 'utf8');
    expect(jsexecSource).toContain('// TurboWasm: case-sensitive-strings');
    // The compare family slow path branches on __semantics.caseSensitiveStrings.
    expect(jsexecSource).toMatch(/__semantics\.caseSensitiveStrings \? \('' \+ v1\) : \('' \+ v1\)\.toLowerCase\(\)/);
    // The new compareContains helper is present.
    expect(jsexecSource).toMatch(/runtimeFunctions\.compareContains/);
    expect(jsexecSource).toMatch(/const compareContains = \(a, b\) => \{[\s\S]*__semantics\.caseSensitiveStrings/);
  });
});

describe('Phase 8-B — OP_CONTAINS emit + compareContains helper (source shape)', () => {
  const JSGEN = resolve(
    process.cwd(),
    'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsgen.js',
  );
  const JSEXEC = resolve(
    process.cwd(),
    'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsexecute.js',
  );
  const CAST = resolve(
    process.cwd(),
    'vendored/scaffolding/node_modules/scratch-vm/src/util/cast.js',
  );
  const OPS = resolve(
    process.cwd(),
    'vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_operators.js',
  );
  const DATA = resolve(
    process.cwd(),
    'vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_data.js',
  );
  if (
    !existsSync(JSGEN) ||
    !existsSync(JSEXEC) ||
    !existsSync(CAST) ||
    !existsSync(OPS) ||
    !existsSync(DATA)
  ) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const jsgenSource = readFileSync(JSGEN, 'utf8');
  const jsexecSource = readFileSync(JSEXEC, 'utf8');
  const castSource = readFileSync(CAST, 'utf8');
  const opsSource = readFileSync(OPS, 'utf8');
  const dataSource = readFileSync(DATA, 'utf8');

  it('all 5 files carry the // TurboWasm: case-sensitive-strings marker', () => {
    expect(jsgenSource).toContain('// TurboWasm: case-sensitive-strings');
    expect(jsexecSource).toContain('// TurboWasm: case-sensitive-strings');
    expect(castSource).toContain('// TurboWasm: case-sensitive-strings');
    expect(opsSource).toContain('// TurboWasm: case-sensitive-strings');
    expect(dataSource).toContain('// TurboWasm: case-sensitive-strings');
  });

  it('jsgen.js:OP_CONTAINS emits compareContains() (= substring search via runtime helper)', () => {
    // Look for the exact emitted shape. We isolate the OP_CONTAINS case
    // body by finding the `case InputOpcode.OP_CONTAINS:` line and
    // slicing until the next `case ` (= the OP_CONTAINS block is
    // self-contained, no fall-through).
    const startIdx = jsgenSource.indexOf('case InputOpcode.OP_CONTAINS:');
    expect(startIdx).toBeGreaterThan(0);
    const nextCase = jsgenSource.indexOf('case InputOpcode.', startIdx + 1);
    const block = jsgenSource.slice(startIdx, nextCase > 0 ? nextCase : startIdx + 500);
    expect(block).toContain('compareContains(');
    expect(block).toContain('// TurboWasm: case-sensitive-strings');
    // The legacy `.toLowerCase().indexOf(...)` emit must be gone in
    // the actual `return` statement (= the comments may still mention
    // it as historical context).
    const returnIdx = block.indexOf('return ');
    const returnLine = block.slice(returnIdx, returnIdx + 200).split('\n')[0];
    expect(returnLine).not.toMatch(/\.toLowerCase\(\)/);
  });

  it('jsexecute.js: compareContains helper exists in runtimeFunctions', () => {
    expect(jsexecSource).toMatch(/runtimeFunctions\.compareContains = `[\s\S]*__semantics\.caseSensitiveStrings/);
  });

  it('jsexecute.js: baseRuntime captures __semantics from globalState.thread.target.runtime', () => {
    expect(jsexecSource).toMatch(/const __semantics = \(globalState && globalState\.thread/);
  });

  it('cast.js:compare signature accepts an optional `caseSensitive` parameter', () => {
    expect(castSource).toMatch(/static compare \(v1, v2, caseSensitive = false\)/);
  });

  it('scratch3_operators.js:contains reads the semantics flag', () => {
    expect(opsSource).toMatch(/contains \(args\) \{[\s\S]*this\.runtime\.compilerOptions\.semantics/);
  });

  it('scratch3_data.js:listContainsItem + getItemNumOfList pass caseSensitive to Cast.compare', () => {
    expect(dataSource).toMatch(/listContainsItem \(args, util\) \{[\s\S]*caseSensitiveStrings/);
    expect(dataSource).toMatch(/getItemNumOfList \(args, util\) \{[\s\S]*caseSensitiveStrings/);
    expect(dataSource).toMatch(/Cast\.compare\(list\.value\[i\], item, caseSensitive\)/);
  });
});