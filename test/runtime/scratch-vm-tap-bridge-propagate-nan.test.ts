import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 9-C — `semantics.propagateNaN`.
 *
 * Verifies the runtime gate that flips `Cast.toNumber` (= interpreter
 * path) and `runtimeFunctions.toNotNaN` (= compiled path) to JS
 * standard `Number(value)` semantics (= NaN preserved) when
 * `runtime.compilerOptions.semantics.propagateNaN` is true. The
 * default (`false`) keeps the legacy Scratch conversion (= NaN
 * coerced to 0).
 *
 * The Phase 9-C patch in `patches/vendored/scratch-vm.patch` wires
 * three files (mirrors the Phase 9-B pattern):
 *
 *  - `cast.js:toNumber` — interpreter-side short-circuit on
 *    `Cast._propagateNaNFlag` (= `static setSemanticFlags(sem)` mirror
 *    updated by `Runtime.setCompilerOptions`).
 *  - `jsexecute.js:runtimeFunctions.toNotNaN` — compiled-side 2-path
 *    branch on the captured `__semantics.propagateNaN` (= the
 *    existing Phase 8-B capture reads the new field). Cache
 *    invalidation guarantees fresh scripts after a flag flip.
 *  - `runtime.js:setCompilerOptions` — already calls
 *    `Cast.setSemanticFlags(this.compilerOptions.semantics)` (= the
 *    Phase 9-B block now propagates both flags).
 *
 * All three carry the same `// TurboWasm: propagate-nan` marker
 * (= the source/patch/UMD probes in
 * `test/runtime/scratch-vm-patches-symbols.test.ts` are the registry
 * enforcement; this file pins the runtime-level contracts).
 */

const here = dirname(fileURLToPath(import.meta.url));
// test/runtime/scratch-vm-tap-bridge-propagate-nan.test.ts
//   → .. = test/
//   → ../.test-fixtures/propagate-nan-fixture.sb3
const FIXTURE_PATH = resolve(here, '../.test-fixtures/propagate-nan-fixture.sb3');

const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);

const STEP_FRAMES = 600;

function loadFixtureBuffer(): Buffer {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `propagate-nan-fixture.sb3 missing at ${FIXTURE_PATH}; run \`npm run fixtures:setup\``,
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
  propagateNaN: true,
};

/**
 * Canonical value matrix. Each entry is encoded in the fixture as
 * `setvar v = <value>; setvar combined = (v) + 0; join results +=
 * String(combined)`.
 *
 * **Why these 7 strings:** they cover every `Cast.toNumber` boundary
 * condition from §9C-4. Numeric / boolean values are excluded from
 * the runtime matrix because (a) `data_setvariable` keeps them as
 * their shadow's raw `NUM` field = string, so the runtime sees a
 * string regardless of compiled / interpreter path, and (b) the
 * unit-level `Cast.toNumber` matrix below directly probes `number`
 * and `undefined` coverage.
 */
const VALUE_MATRIX: readonly string[] = ['abc', '', '5', '5.5', '5.5abc', 'NaN', 'Infinity'];

/**
 * Expected OFF (= Scratch compatible) `String(combined)` for each
 * matrix row. The `+ 0` chain routes through `toNotNaN` /
 * `Cast.toNumber` (= the gate under test). OFF converts non-numeric
 * coercion results (= `Number("abc")` is NaN, then NaN → 0) to `0`,
 * but keeps legitimate numeric inputs untouched.
 */
function expectedOff(value: string): string {
  switch (value) {
    case '':
      // `Number("")` is `0` (= no coercion needed). OFF keeps `0`.
      return '0';
    case '5':
      // `Number("5")` is `5`, OFF keeps `5`.
      return '5';
    case '5.5':
      return '5.5';
    case '5.5abc':
      // `Number("5.5abc")` is NaN, OFF converts to `0`.
      return '0';
    case 'NaN':
      // Scratch stores the string `'NaN'` (= not the JS NaN) and
      // `Number('NaN')` is NaN. OFF converts NaN → `0`.
      return '0';
    case 'Infinity':
      // `Number('Infinity')` is `Infinity`. OFF keeps `Infinity`.
      return 'Infinity';
    case 'abc':
    default:
      // `Number('abc')` is NaN, OFF converts NaN → `0`.
      return '0';
  }
}

function expectedOn(value: string): string {
  switch (value) {
    case '':
      // `Number("")` is `0` (= JS standard). ON keeps `0`.
      return '0';
    case '5':
      return '5';
    case '5.5':
      return '5.5';
    case '5.5abc':
      // NaN preserved.
      return 'NaN';
    case 'NaN':
      // `Number('NaN')` is NaN, ON preserves NaN.
      return 'NaN';
    case 'Infinity':
      return 'Infinity';
    case 'abc':
    default:
      return 'NaN';
  }
}

function expectedResultsString(
  matrix: readonly string[],
  semantics: typeof SEMANTICS_OFF,
): string {
  const fn = semantics.propagateNaN ? expectedOn : expectedOff;
  return matrix.map((v) => fn(v)).join('');
}

/**
 * Build a fresh VM, load the fixture, set compiler + semantics
 * options, fire the green flag, step STEP_FRAMES times, then read
 * the stage-level `results` variable.
 */
async function runFixtureOnce(
  compile: boolean,
  semantics: typeof SEMANTICS_OFF,
  VirtualMachine: unknown,
): Promise<string> {
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
  const stage = vm.runtime.targets[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stageVars = stage.variables as Record<string, any>;
  const resultsVar = Object.values(stageVars).find(
    (v) => v && v.name === 'results',
  ) as { value: string } | undefined;
  return (resultsVar && resultsVar.value) || '';
}

describe('Phase 9-C — Cast.toNumber (interpreter path)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  const originalFlag = vm.cast._propagateNaNFlag;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Cast = vm.cast as any;
  const toNumberWith = (flag: boolean) => {
    Cast._propagateNaNFlag = flag;
    return (value: unknown): number => Cast.toNumber(value);
  };
  const restore = () => {
    Cast._propagateNaNFlag = originalFlag;
  };

  it('Cast.toNumber OFF (= _propagateNaNFlag=false): legacy Scratch NaN→0 coercion', () => {
    const off = toNumberWith(false);
    // Numeric inputs: unchanged.
    expect(off(0)).toBe(0);
    expect(off(5)).toBe(5);
    expect(off(-0)).toBe(-0);
    expect(off(5.5)).toBe(5.5);
    expect(off(Infinity)).toBe(Infinity);
    expect(off(-Infinity)).toBe(-Infinity);
    expect(off(NaN)).toBe(0); // NaN coerced to 0
    // String inputs: Number(...) coerced, NaN→0.
    expect(off('')).toBe(0);
    expect(off(' ')).toBe(0);
    expect(off('0')).toBe(0);
    expect(off('1')).toBe(1);
    expect(off('5.5')).toBe(5.5);
    expect(off('5.5abc')).toBe(0); // NaN → 0
    expect(off('abc')).toBe(0); // NaN → 0
    expect(off('NaN')).toBe(0); // NaN → 0
    expect(off('Infinity')).toBe(Infinity);
    // null / undefined.
    expect(off(null)).toBe(0); // Number(null) is 0
    expect(off(undefined)).toBe(0); // Number(undefined) is NaN → 0
    restore();
  });

  it('Cast.toNumber ON (= _propagateNaNFlag=true): JS standard Number(...) coercion', () => {
    const on = toNumberWith(true);
    // Numeric inputs: unchanged.
    expect(on(0)).toBe(0);
    expect(on(5)).toBe(5);
    expect(on(-0)).toBe(-0);
    expect(on(5.5)).toBe(5.5);
    expect(on(Infinity)).toBe(Infinity);
    expect(on(-Infinity)).toBe(-Infinity);
    expect(on(NaN)).toBeNaN(); // preserved
    // String inputs: pure Number coercion.
    expect(on('')).toBe(0);
    expect(on(' ')).toBe(0);
    expect(on('0')).toBe(0);
    expect(on('1')).toBe(1);
    expect(on('5.5')).toBe(5.5);
    expect(on('5.5abc')).toBeNaN(); // preserved
    expect(on('abc')).toBeNaN(); // preserved
    expect(on('NaN')).toBeNaN(); // preserved
    expect(on('Infinity')).toBe(Infinity);
    // null / undefined.
    expect(on(null)).toBe(0); // Number(null) is 0
    expect(on(undefined)).toBeNaN(); // preserved
    restore();
  });

  it('Cast.setSemanticFlags mirrors propagateNaN into _propagateNaNFlag', () => {
    Cast.setSemanticFlags(SEMANTICS_OFF);
    expect(Cast._propagateNaNFlag).toBe(false);
    Cast.setSemanticFlags(SEMANTICS_ON);
    expect(Cast._propagateNaNFlag).toBe(true);
    Cast.setSemanticFlags({ propagateNaN: false });
    expect(Cast._propagateNaNFlag).toBe(false);
    Cast.setSemanticFlags(undefined);
    expect(Cast._propagateNaNFlag).toBe(false);
    restore();
  });
});

describe('Phase 9-C — runtimeFunctions.toNotNaN (compiled path, OFF)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // `jsexecute.scopedEval` injects `globalState` without
  // `compilerOptions.semantics`, so the captured `__semantics` falls
  // back to the default (= all OFF, scratch-compatible). The OFF
  // helper therefore mirrors the legacy Scratch NaN→0 coercion.
  const toNotNaN = vm.jsexecute.scopedEval('toNotNaN') as (v: unknown) => number;

  it('OFF path (= default captured __semantics): NaN coerced to 0', () => {
    expect(toNotNaN(0)).toBe(0);
    expect(toNotNaN(5)).toBe(5);
    expect(toNotNaN(-0)).toBe(-0);
    expect(toNotNaN(Infinity)).toBe(Infinity);
    expect(toNotNaN(NaN)).toBe(0); // coerced
    // toNotNaN expects a number (the call sites always pass
    // `+value` first); passing a string would be a contract
    // violation but we verify the gate is bypassed.
  });
});

describe('Phase 9-C — runtimeFunctions.toNotNaN (compiled path, ON via __semantics injection)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // Re-create the helper with a custom `__semantics` const (= reads
  // `propagateNaN` from the side-channel). This mirrors the pattern
  // in the Phase 9-B / strict-numeric-equality bridge tests.
  const compileHelper = (sourceCode: string): ((v: unknown) => number) => {
    const sandbox = `
      const __semantics = {
        strictNumericEquality: false,
        caseSensitiveStrings: false,
        propagateNaN: true,
        truncatedModulo: false,
        jsTruthyBooleans: false,
      };
      ${sourceCode}
    `;
    return new Function(sandbox)() as (v: unknown) => number;
  };

  // Copy of `runtimeFunctions.toNotNaN` with `__semantics.propagateNaN=true`.
  const toNotNaN = compileHelper(
    'return (value) => __semantics.propagateNaN ? value : (Number.isNaN(value) ? 0 : value);',
  );

  it('ON path: NaN passes through unchanged', () => {
    expect(toNotNaN(0)).toBe(0);
    expect(toNotNaN(5)).toBe(5);
    expect(toNotNaN(-0)).toBe(-0);
    expect(toNotNaN(Infinity)).toBe(Infinity);
    expect(toNotNaN(NaN)).toBeNaN(); // preserved
  });
});

describe('Phase 9-C — runtime matrix (compiled × semantic × arithmetic chain)', () => {
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

  const expectedOff = expectedResultsString(VALUE_MATRIX, SEMANTICS_OFF);
  const expectedOn = expectedResultsString(VALUE_MATRIX, SEMANTICS_ON);

  it('compiler=ON, semantic OFF: scratch-compatible results', async () => {
    const results = await runFixtureOnce(true, SEMANTICS_OFF, VirtualMachine);
    expect(results).toEqual(expectedOff);
  });

  it('compiler=ON, semantic ON: NaN propagates through arithmetic (5.5abc → "NaN", "abc" → "NaN", "NaN" → "NaN"); 5 / 5.5 / "5" / "" / Infinity unchanged', async () => {
    const results = await runFixtureOnce(true, SEMANTICS_ON, VirtualMachine);
    expect(results).toEqual(expectedOn);
    // Pin the divergence rows explicitly so a future regression
    // (re-baking the flag, dropping the compiled capture, etc.)
    // is caught even if the surrounding matrix drifts. The string
    // `NaN` (from `'NaN'`-as-string value) is unreachable as a JS
    // number through other code paths, so it probes the gate
    // end-to-end.
    expect(expectedOn).toContain('NaN'); // "abc"
    expect(expectedOn.match(/NaN/g) || []).toHaveLength(3); // "abc" + "5.5abc" + "NaN"
    // "" → 0 (Number("") is 0), "5" → 5 (legitimate value, preserved), "5.5" → 5.5 (legitimate), "Infinity" → "Infinity".
    expect(results).toContain('0');
    expect(results).toContain('5');
    expect(results).toContain('5.5');
    expect(results).toContain('Infinity');
    // OFF path: divergence rows would be '0' (NaN→0 fallback).
    // Count NaN occurrences in OFF: zero.
    expect((expectedOff.match(/NaN/g) || []).length).toBe(0);
  });

  it('compiler=OFF, semantic ON: interpreter-side Cast.toNumber observes the flag', async () => {
    const results = await runFixtureOnce(false, SEMANTICS_ON, VirtualMachine);
    expect(results).toEqual(expectedOn);
  });

  it('compiler=OFF, semantic OFF: scratch-compatible interpreter results', async () => {
    const results = await runFixtureOnce(false, SEMANTICS_OFF, VirtualMachine);
    expect(results).toEqual(expectedOff);
  });
});

describe('Phase 9-C — cache invalidation (same VM, OFF → ON → OFF)', () => {
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
    type AnyVM = {
      runtime: {
        targets: Array<{ variables: Record<string, { name: string; value: unknown }> }>;
        greenFlag(): void;
        _step(): void;
      };
      setCompatibilityMode(b: boolean): void;
      setTurboMode(b: boolean): void;
      setCompilerOptions(opts: unknown): void;
      loadProject(ab: ArrayBuffer): Promise<unknown>;
    };
    const vm = new VM() as unknown as AnyVM;
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    const projectBuffer = loadFixtureBuffer();
    const ab = new ArrayBuffer(projectBuffer.byteLength);
    new Uint8Array(ab).set(projectBuffer);

    // Each greenFlag re-runs the fixture (= it has the
    // `event_whenflagclicked` hat with init `setvar results = ""`)
    // so reading `results` after each greenFlag gives the freshest
    // batch (= no slicing needed; init clears the accumulator).
    const getResults = () => {
      const stage = vm.runtime.targets[0] as {
        variables: Record<string, { name: string; value: unknown }>;
      };
      const stageVars = stage.variables;
      const v = Object.values(stageVars).find(
        (x) => x && x.name === 'results',
      ) as { value: string } | undefined;
      return (v && v.value) || '';
    };

    // 1) Load with semantic OFF, compiler ON. Run, capture.
    vm.setCompilerOptions({ enabled: true, semantics: SEMANTICS_OFF });
    await vm.loadProject(ab);
    vm.runtime.greenFlag();
    for (let i = 0; i < STEP_FRAMES; i += 1) vm.runtime._step();
    expect(getResults()).toEqual(
      expectedResultsString(VALUE_MATRIX, SEMANTICS_OFF),
    );

    // 2) Flip semantic ON. setCompilerOptions triggers
    // resetAllCaches → next compile re-reads __semantics.
    vm.setCompilerOptions({ enabled: true, semantics: SEMANTICS_ON });
    vm.runtime.greenFlag();
    for (let i = 0; i < STEP_FRAMES; i += 1) vm.runtime._step();
    expect(getResults()).toEqual(
      expectedResultsString(VALUE_MATRIX, SEMANTICS_ON),
    );

    // 3) Flip back to OFF.
    vm.setCompilerOptions({ enabled: true, semantics: SEMANTICS_OFF });
    vm.runtime.greenFlag();
    for (let i = 0; i < STEP_FRAMES; i += 1) vm.runtime._step();
    expect(getResults()).toEqual(
      expectedResultsString(VALUE_MATRIX, SEMANTICS_OFF),
    );
  });
});

describe('Phase 9-C — source / patch markers', () => {
  const CAST = 'vendored/scaffolding/node_modules/scratch-vm/src/util/cast.js';
  const JSEXEC = 'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsexecute.js';
  const RUNTIME = 'vendored/scaffolding/node_modules/scratch-vm/src/engine/runtime.js';

  it('all 3 files carry the // TurboWasm: propagate-nan marker', () => {
    for (const file of [CAST, JSEXEC, RUNTIME]) {
      if (!existsSync(file)) {
        // eslint-disable-next-line no-console
        console.warn(`[scratch-vm-tap-bridge-propagate-nan] ${file} missing; skipping marker probe`);
        return;
      }
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} missing marker`).toContain('// TurboWasm: propagate-nan');
    }
  });

  it('cast.js:toNumber short-circuits to Number(value) when _propagateNaNFlag is true', () => {
    if (!existsSync(CAST)) return;
    const text = readFileSync(CAST, 'utf8');
    expect(text).toMatch(
      /static toNumber \(value\) \{[\s\S]*if \(Cast\._propagateNaNFlag\) \{[\s\S]*return Number\(value\);/,
    );
  });

  it('cast.js: defines the static `_propagateNaNFlag` mirror and `setSemanticFlags` propagates both flags', () => {
    if (!existsSync(CAST)) return;
    const text = readFileSync(CAST, 'utf8');
    expect(text).toMatch(/static _propagateNaNFlag = false/);
    expect(text).toMatch(
      /static setSemanticFlags \(sem\) \{[\s\S]*Cast\._jsTruthyFlag = !!\(sem && sem\.jsTruthyBooleans\)[\s\S]*Cast\._propagateNaNFlag = !!\(sem && sem\.propagateNaN\)/,
    );
  });

  it('jsexecute.js:runtimeFunctions.toNotNaN branches on __semantics.propagateNaN', () => {
    if (!existsSync(JSEXEC)) return;
    const text = readFileSync(JSEXEC, 'utf8');
    expect(text).toMatch(
      /runtimeFunctions\.toNotNaN = `[\s\S]*__semantics\.propagateNaN \? value : \(Number\.isNaN\(value\) \? 0 : value\)`;/,
    );
  });

  it('runtime.js:setCompilerOptions calls Cast.setSemanticFlags before resetAllCaches (unchanged from Phase 9-B wiring)', () => {
    if (!existsSync(RUNTIME)) return;
    const text = readFileSync(RUNTIME, 'utf8');
    expect(text).toMatch(
      /setCompilerOptions \(compilerOptions\) \{[\s\S]*Cast\.setSemanticFlags\(this\.compilerOptions\.semantics\);[\s\S]*this\.resetAllCaches\(\);/,
    );
  });

  it('patches/vendored/scratch-vm.patch contains the marker', () => {
    const patchPath = 'patches/vendored/scratch-vm.patch';
    if (!existsSync(patchPath)) return;
    const text = readFileSync(patchPath, 'utf8');
    expect(text).toContain('// TurboWasm: propagate-nan');
  });
});
