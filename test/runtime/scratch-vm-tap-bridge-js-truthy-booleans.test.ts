import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 9-B — `semantics.jsTruthyBooleans`.
 *
 * Verifies the runtime gate that flips `Cast.toBoolean` (= interpreter
 * path) and `runtimeFunctions.toBoolean` (= compiled path) to JS
 * standard truthy / falsy semantics when
 * `runtime.compilerOptions.semantics.jsTruthyBooleans` is true.
 *
 * The Phase 9-B patch in `patches/vendored/scratch-vm.patch` wires
 * three files:
 *
 *  - `cast.js:toBoolean` — interpreter-side static flag
 *    (`Cast._jsTruthyFlag`) mirroring `runtime.compilerOptions
 *    .semantics.jsTruthyBooleans`. `setSemanticFlags(sem)` is the
 *    helper called from `runtime.setCompilerOptions` immediately
 *    before `resetAllCaches()`.
 *  - `jsexecute.js:runtimeFunctions.toBoolean` — compiled-side 2-path
 *    branch on `__semantics.jsTruthyBooleans` captured at compile
 *    time. Cache invalidation guarantees freshly-compiled scripts
 *    pick up the new flag.
 *  - `runtime.js:setCompilerOptions` — calls `Cast.setSemanticFlags`
 *    so the interpreter-side static flag is refreshed in lockstep
 *    with the cache invalidation.
 *
 * All three carry the same `// TurboWasm: js-truthy-booleans` marker
 * (= the source/patch/UMD probes in
 * `test/runtime/scratch-vm-patches-symbols.test.ts` are the registry
 * enforcement; this file pins the runtime-level contracts).
 */

const here = dirname(fileURLToPath(import.meta.url));
// test/runtime/scratch-vm-tap-bridge-js-truthy-booleans.test.ts
//   → .. = test/
//   → ../.test-fixtures/js-truthy-fixture.sb3
const FIXTURE_PATH = resolve(here, '../.test-fixtures/js-truthy-fixture.sb3');

const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);

const STEP_FRAMES = 600;

function loadFixtureBuffer(): Buffer {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `js-truthy-fixture.sb3 missing at ${FIXTURE_PATH}; run \`npm run fixtures:setup\``,
    );
  }
  return readFileSync(FIXTURE_PATH);
}

const SEMANTICS_OFF = {
  strictNumericEquality: false,
  caseSensitiveStrings: false,
  propagateNaN: false,
  truncatedModulo: false,
  jsTruthyBooleans: false,
};
const SEMANTICS_ON: typeof SEMANTICS_OFF = {
  ...SEMANTICS_OFF,
  jsTruthyBooleans: true,
};

/**
 * Expected `{if, and, or}` results per input value, per semantics
 * mode. The fixture appends one row per `VALUE_MATRIX` entry (= 7
 * rows). JS standard truthy / falsy flips the divergence rows
 * (`"0"`, `"false"`, `"FALSE"`, `" "`) from 0 to 1; everything else
 * stays stable. The matrices are duplicated here from the fixture
 * generator so the runtime assertions can verify without re-parsing
 * the sb3.
 */
const VALUE_MATRIX: readonly unknown[] = [
  '',
  'false',
  'FALSE',
  ' ',
  '00',
  'true',
  'anything',
];

function expectedIf(value: unknown, jsTruthy: boolean): 0 | 1 {
  // `if <value> then 1 else 0`. OFF = legacy Scratch truthy
  // (`''`, `'0'`, `'false'` are false; everything else true —
  // note that `' '` is true in both modes since `Cast.toBoolean`'s
  // OFF path matches only `''`, `'0'`, `'false'`, not arbitrary
  // whitespace). ON = JS standard `!!value`.
  if (jsTruthy) return value ? 1 : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  if (typeof value === 'string') {
    if (value === '' || value === '0' || value.toLowerCase() === 'false') return 0;
    return 1;
  }
  return value ? 1 : 0;
}

function expectedAnd(value: unknown, jsTruthy: boolean): 0 | 1 {
  // `(value) and (true)` — `operator_and` short-circuits to the
  // boolean cast of the first operand when the second is truthy.
  return expectedIf(value, jsTruthy);
}

function expectedOr(value: unknown, jsTruthy: boolean): 0 | 1 {
  // `(value) or (false)` — `operator_or` short-circuits to the
  // boolean cast of the first operand when the second is falsy.
  return expectedIf(value, jsTruthy);
}

function expectedList(matrix: readonly unknown[], jsTruthy: boolean, fn: (v: unknown, j: boolean) => 0 | 1): number[] {
  return matrix.map((v) => fn(v, jsTruthy));
}

/**
 * Decode the per-scenario `i`/`a`/`o` triplet string produced by the
 * fixture (= the stage's `results` variable) into three parallel
 * arrays. Each scenario appends 3 chars (`0` or `1`).
 */
function decodeResultsString(raw: string): RunResult {
  const ifResults: number[] = [];
  const andResults: number[] = [];
  const orResults: number[] = [];
  for (let i = 0; i + 2 < raw.length; i += 3) {
    ifResults.push(raw.charCodeAt(i) - 48);
    andResults.push(raw.charCodeAt(i + 1) - 48);
    orResults.push(raw.charCodeAt(i + 2) - 48);
  }
  return { ifResults, andResults, orResults };
}

interface RunResult {
  ifResults: number[];
  andResults: number[];
  orResults: number[];
}

/**
 * Build a fresh VM, load the fixture, set compiler + semantics
 * options, fire the green flag, step STEP_FRAMES times, and read
 * the three result lists. The fixture encodes 7 inputs and
 * appends one row per input to each list.
 */
async function runFixtureOnce(
  compile: boolean,
  semantics: typeof SEMANTICS_OFF,
  VirtualMachine: unknown,
): Promise<RunResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const VM = VirtualMachine as any;
  const vm = new VM();
  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  vm.setCompilerOptions({ enabled: compile, semantics });
  const projectBuffer = loadFixtureBuffer();
  const ab = new ArrayBuffer(projectBuffer.byteLength);
  new Uint8Array(ab).set(projectBuffer);
  await vm.loadProject(ab);
  vm.runtime.greenFlag();
  for (let i = 0; i < STEP_FRAMES; i += 1) {
    vm.runtime._step();
  }
  // The fixture encodes results into the stage-level `results`
  // variable as a fixed-width 3-character string per scenario
  // (= `i`, `a`, `o` for if/and/or, each `0` or `1`). 7 scenarios
  // × 3 chars = 21 characters total. Reading lists via `data_addtolist`
  // shadow primitives is unreliable on the vendored SHA (= the
  // shadow's id re-rolls), so we use stage variable accumulation.
  const stage = vm.runtime.targets[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stageVars = stage.variables as Record<string, any>;
  const resultsVar = Object.values(stageVars).find(
    (v) => v && v.name === 'results',
  ) as { value: string } | undefined;
  const raw = (resultsVar && resultsVar.value) || '';
  const ifResults: number[] = [];
  const andResults: number[] = [];
  const orResults: number[] = [];
  for (let i = 0; i + 2 < raw.length; i += 3) {
    ifResults.push(raw.charCodeAt(i) - 48);
    andResults.push(raw.charCodeAt(i + 1) - 48);
    orResults.push(raw.charCodeAt(i + 2) - 48);
  }
  return { ifResults, andResults, orResults };
}

describe('Phase 9-B — Cast.toBoolean (interpreter path)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // Capture the initial flag value so the test restores it after
  // (other suites share the same VM module cache).
  const originalFlag = vm.cast._jsTruthyFlag;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Cast = vm.cast as any;
  const toBooleanWith = (flag: boolean) => {
    Cast._jsTruthyFlag = flag;
    return (value: unknown): boolean => Cast.toBoolean(value);
  };

  // Restore the flag at the end of the suite via afterAll.
  const restore = () => {
    Cast._jsTruthyFlag = originalFlag;
  };

  it('Cast.toBoolean OFF (= _jsTruthyFlag=false): legacy Scratch truthy table', () => {
    const off = toBooleanWith(false);
    expect(off('')).toBe(false);
    expect(off('0')).toBe(false);
    expect(off('false')).toBe(false);
    expect(off('FALSE')).toBe(false);
    expect(off('False')).toBe(false);
    expect(off(' ')).toBe(true);
    expect(off('00')).toBe(true);
    expect(off('true')).toBe(true);
    expect(off('anything')).toBe(true);
    expect(off(0)).toBe(false);
    expect(off(1)).toBe(true);
    expect(off(-1)).toBe(true);
    expect(off(Infinity)).toBe(true);
    expect(off(true)).toBe(true);
    expect(off(false)).toBe(false);
    restore();
  });

  it('Cast.toBoolean ON (= _jsTruthyFlag=true): JS standard truthy table', () => {
    const on = toBooleanWith(true);
    expect(on('')).toBe(false);
    expect(on('0')).toBe(true);
    expect(on('false')).toBe(true);
    expect(on('FALSE')).toBe(true);
    expect(on('False')).toBe(true);
    expect(on(' ')).toBe(true);
    expect(on('00')).toBe(true);
    expect(on('true')).toBe(true);
    expect(on('anything')).toBe(true);
    expect(on(0)).toBe(false);
    expect(on(1)).toBe(true);
    expect(on(-1)).toBe(true);
    expect(on(Infinity)).toBe(true);
    expect(on(true)).toBe(true);
    expect(on(false)).toBe(false);
    restore();
  });

  it('Cast.setSemanticFlags mirrors the semantics bag into _jsTruthyFlag', () => {
    Cast.setSemanticFlags(SEMANTICS_OFF);
    expect(Cast._jsTruthyFlag).toBe(false);
    Cast.setSemanticFlags(SEMANTICS_ON);
    expect(Cast._jsTruthyFlag).toBe(true);
    Cast.setSemanticFlags({ jsTruthyBooleans: false });
    expect(Cast._jsTruthyFlag).toBe(false);
    Cast.setSemanticFlags(undefined);
    expect(Cast._jsTruthyFlag).toBe(false);
    restore();
  });
});

describe('Phase 9-B — runtimeFunctions.toBoolean (compiled path, OFF)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // `jsexecute.scopedEval` injects `globalState` without
  // `compilerOptions.semantics`, so the captured `__semantics` falls
  // back to the default (= all OFF, scratch-compatible).
  const toBoolean = vm.jsexecute.scopedEval('toBoolean') as (v: unknown) => boolean;

  it('OFF path (= default captured __semantics): legacy Scratch truthy table', () => {
    expect(toBoolean('')).toBe(false);
    expect(toBoolean('0')).toBe(false);
    expect(toBoolean('false')).toBe(false);
    expect(toBoolean('FALSE')).toBe(false);
    expect(toBoolean(' ')).toBe(true);
    expect(toBoolean('00')).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
  });
});

describe('Phase 9-B — runtimeFunctions.toBoolean (compiled path, ON via __semantics injection)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // Re-create the helper with a custom `__semantics` const (= reads
  // `jsTruthyBooleans` from the side-channel). This mirrors the
  // pattern in `scratch-vm-tap-bridge-strict-numeric-equality.test.ts`.
  const compileHelper = (sourceCode: string): ((v: unknown) => boolean) => {
    const sandbox = `
      const __semantics = {
        strictNumericEquality: false,
        caseSensitiveStrings: false,
        propagateNaN: false,
        truncatedModulo: false,
        jsTruthyBooleans: true,
      };
      ${sourceCode}
    `;
    return new Function(sandbox)() as (v: unknown) => boolean;
  };

  // Copy of `runtimeFunctions.toBoolean` with `__semantics.jsTruthyBooleans=true`.
  const toBoolean = compileHelper(
    'return (value) => { if (__semantics.jsTruthyBooleans) return !!value; if (typeof value === "boolean") return value; if (typeof value === "string") { if (value === "" || value === "0" || value.toLowerCase() === "false") return false; return true; } return !!value; };',
  );

  it('ON path: JS standard truthy table', () => {
    expect(toBoolean('')).toBe(false);
    expect(toBoolean('0')).toBe(true);
    expect(toBoolean('false')).toBe(true);
    expect(toBoolean('FALSE')).toBe(true);
    expect(toBoolean(' ')).toBe(true);
    expect(toBoolean('00')).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
  });
});

describe('Phase 9-B — runtime matrix (compiled × semantic × if / and / or)', () => {
  if (!existsSync(VENDORED_VM_DIR)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  if (!existsSync(FIXTURE_PATH)) {
    it.skip('fixture missing; run `npm run fixtures:setup`.', () => {});
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cjsRequire = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const VirtualMachine = cjsRequire(resolve(VENDORED_VM_DIR, 'src/index.js'));

  const expectedIfOff = expectedList(VALUE_MATRIX, false, expectedIf);
  const expectedIfOn = expectedList(VALUE_MATRIX, true, expectedIf);
  const expectedAndOff = expectedList(VALUE_MATRIX, false, expectedAnd);
  const expectedAndOn = expectedList(VALUE_MATRIX, true, expectedAnd);
  const expectedOrOff = expectedList(VALUE_MATRIX, false, expectedOr);
  const expectedOrOn = expectedList(VALUE_MATRIX, true, expectedOr);

  it('compiler=ON, semantic OFF: scratch-compatible results', async () => {
    const { ifResults, andResults, orResults } = await runFixtureOnce(true, SEMANTICS_OFF, VirtualMachine);
    expect(ifResults).toEqual(expectedIfOff);
    expect(andResults).toEqual(expectedAndOff);
    expect(orResults).toEqual(expectedOrOff);
  });

  it('compiler=ON, semantic ON: divergence rows flip (false → true for "false" / "FALSE"); empty string stays false', async () => {
    const { ifResults, andResults, orResults } = await runFixtureOnce(true, SEMANTICS_ON, VirtualMachine);
    expect(ifResults).toEqual(expectedIfOn);
    expect(andResults).toEqual(expectedAndOn);
    expect(orResults).toEqual(expectedOrOn);
    // Pin the divergent rows explicitly so a future regression
    // (re-baking the flag, dropping the compiled capture, etc.) is
    // caught even if the surrounding matrix drifts. The literal
    // `'0'` (string) is probed directly by the `Cast.toBoolean`
    // unit tests at the top of this file because the vendored
    // IR's `createConstantInput` converts it to the JS number `0`
    // (= makes the runtime matrix unable to observe the
    // divergence).
    expect(ifResults[1]).toBe(1); // 'false' → 1
    expect(ifResults[2]).toBe(1); // 'FALSE' → 1
    expect(ifResults[0]).toBe(0); // '' → 0 (stays)
  });

  it('compiler=OFF, semantic ON: interpreter-side Cast.toBoolean observes the flag (string-only matrix)', async () => {
    // The runtime matrix is restricted to string values because the
    // scratch runtime keeps the value of a `data_setvariable` as the
    // raw `NUM` field for `math_number` shadows (= no auto-parse to
    // number). The compiled path converts the shadow to a NUMBER via
    // `irgen.js:toType(NUMBER)` so the two paths observe different
    // JS value types. The runtime matrix restricts to strings so
    // the same `expectedIf` works for both paths (= the value
    // survives both paths unchanged).
    const { ifResults, andResults, orResults } = await runFixtureOnce(false, SEMANTICS_ON, VirtualMachine);
    expect(ifResults).toEqual(expectedIfOn);
    expect(andResults).toEqual(expectedAndOn);
    expect(orResults).toEqual(expectedOrOn);
  });

  it('compiler=OFF, semantic ON: interpreter-side Cast.toBoolean observes the flag', async () => {
    const { ifResults, andResults, orResults } = await runFixtureOnce(false, SEMANTICS_ON, VirtualMachine);
    expect(ifResults).toEqual(expectedIfOn);
    expect(andResults).toEqual(expectedAndOn);
    expect(orResults).toEqual(expectedOrOn);
  });

  it('compiler=OFF, semantic OFF: scratch-compatible interpreter results', async () => {
    const { ifResults, andResults, orResults } = await runFixtureOnce(false, SEMANTICS_OFF, VirtualMachine);
    expect(ifResults).toEqual(expectedIfOff);
    expect(andResults).toEqual(expectedAndOff);
    expect(orResults).toEqual(expectedOrOff);
  });
});

describe('Phase 9-B — cache invalidation (same VM, OFF → ON → OFF)', () => {
  if (!existsSync(VENDORED_VM_DIR)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  if (!existsSync(FIXTURE_PATH)) {
    it.skip('fixture missing; run `npm run fixtures:setup`.', () => {});
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cjsRequire = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const VirtualMachine = cjsRequire(resolve(VENDORED_VM_DIR, 'src/index.js'));

  it('compiled path re-reads the flag after setCompilerOptions (resetAllCaches drops compiledScripts)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const VM = VirtualMachine as any;
    const vm = new VM();
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    const projectBuffer = loadFixtureBuffer();
    const ab = new ArrayBuffer(projectBuffer.byteLength);
    new Uint8Array(ab).set(projectBuffer);

    // 1) Load with semantic OFF, compiler ON. Run, capture results.
    vm.setCompilerOptions({ enabled: true, semantics: SEMANTICS_OFF });
    await vm.loadProject(ab);
    vm.runtime.greenFlag();
    for (let i = 0; i < STEP_FRAMES; i += 1) vm.runtime._step();
    const stage = vm.runtime.targets[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stageVars = stage.variables as Record<string, any>;
    const getResultsTriplets = () => {
      const v = Object.values(stageVars).find(
        (x) => x && x.name === 'results',
      ) as { value: string };
      return decodeResultsString(v.value);
    };
    // The fixture ACCUMULATES `results` across green-flag runs (= the
    // script appends rather than resets), so each green-flag appends a
    // fresh batch of 7 triplets (= 21 chars) to the existing value.
    // Slice the LATEST 7 triplets (= the most recent run's results)
    // to validate that run's behaviour independently.
    const slice = (full: RunResult): RunResult => {
      const slice7 = (arr: number[]) => arr.slice(-VALUE_MATRIX.length);
      return {
        ifResults: slice7(full.ifResults),
        andResults: slice7(full.andResults),
        orResults: slice7(full.orResults),
      };
    };
    const offResults = slice(getResultsTriplets());
    expect(offResults.ifResults).toEqual(expectedList(VALUE_MATRIX, false, expectedIf));

    // 2) Flip semantic ON. setCompilerOptions → resetAllCaches →
    // emit COMPILER_OPTIONS_CHANGED listener in Blocks.resetCache.
    // Next green flag + step must observe the new flag.
    vm.setCompilerOptions({ enabled: true, semantics: SEMANTICS_ON });
    vm.runtime.greenFlag();
    for (let i = 0; i < STEP_FRAMES; i += 1) vm.runtime._step();
    const onResults = slice(getResultsTriplets());
    expect(onResults.ifResults).toEqual(expectedList(VALUE_MATRIX, true, expectedIf));

    // 3) Flip back to OFF. The OFF results must re-appear (not
    // retain the ON results, which would indicate the cache was
    // not invalidated correctly).
    vm.setCompilerOptions({ enabled: true, semantics: SEMANTICS_OFF });
    vm.runtime.greenFlag();
    for (let i = 0; i < STEP_FRAMES; i += 1) vm.runtime._step();
    const offAgainResults = slice(getResultsTriplets());
    expect(offAgainResults.ifResults).toEqual(expectedList(VALUE_MATRIX, false, expectedIf));
  });
});

describe('Phase 9-B — source / patch markers', () => {
  const CAST = 'vendored/scaffolding/node_modules/scratch-vm/src/util/cast.js';
  const JSEXEC = 'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsexecute.js';
  const RUNTIME = 'vendored/scaffolding/node_modules/scratch-vm/src/engine/runtime.js';

  it('all 3 files carry the // TurboWasm: js-truthy-booleans marker', () => {
    for (const file of [CAST, JSEXEC, RUNTIME]) {
      if (!existsSync(file)) {
        // eslint-disable-next-line no-console
        console.warn(`[scratch-vm-tap-bridge-js-truthy-booleans] ${file} missing; skipping marker probe`);
        return;
      }
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} missing marker`).toContain('// TurboWasm: js-truthy-booleans');
    }
  });

  it('cast.js:toBoolean short-circuits to Boolean(value) when _jsTruthyFlag is true', () => {
    if (!existsSync(CAST)) return;
    const text = readFileSync(CAST, 'utf8');
    expect(text).toMatch(/static toBoolean \(value\) \{[\s\S]*if \(Cast\._jsTruthyFlag\) return Boolean\(value\);/);
  });

  it('cast.js: defines the static `_jsTruthyFlag` mirror and `setSemanticFlags` setter', () => {
    if (!existsSync(CAST)) return;
    const text = readFileSync(CAST, 'utf8');
    expect(text).toMatch(/static _jsTruthyFlag = false/);
    expect(text).toMatch(/static setSemanticFlags \(sem\) \{[\s\S]*Cast\._jsTruthyFlag = !!\(sem && sem\.jsTruthyBooleans\)/);
  });

  it('jsexecute.js:runtimeFunctions.toBoolean branches on __semantics.jsTruthyBooleans', () => {
    if (!existsSync(JSEXEC)) return;
    const text = readFileSync(JSEXEC, 'utf8');
    expect(text).toMatch(/runtimeFunctions\.toBoolean = `[\s\S]*if \(__semantics\.jsTruthyBooleans\) return !!value;[\s\S]*if \(typeof value === 'boolean'\) \{[\s\S]*return value/);
  });

  it('runtime.js:setCompilerOptions calls Cast.setSemanticFlags before resetAllCaches', () => {
    if (!existsSync(RUNTIME)) return;
    const text = readFileSync(RUNTIME, 'utf8');
    expect(text).toMatch(/setCompilerOptions \(compilerOptions\) \{[\s\S]*Cast\.setSemanticFlags\(this\.compilerOptions\.semantics\);[\s\S]*this\.resetAllCaches\(\);/);
    expect(text).toMatch(/const Cast = require\('\.\.\/util\/cast'\)/);
  });

  it('patches/vendored/scratch-vm.patch contains the marker', () => {
    const patchPath = 'patches/vendored/scratch-vm.patch';
    if (!existsSync(patchPath)) return;
    const text = readFileSync(patchPath, 'utf8');
    expect(text).toContain('// TurboWasm: js-truthy-booleans');
  });
});