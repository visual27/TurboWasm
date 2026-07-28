import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §Phase 6 (generator research) — eval-X semantic-regression guard.
 *
 * Variant X is the pure-interval extraction prototype. The
 * `// TurboWasm: generator-eval-X` patch
 * (`patches/vendored/scratch-vm-eval-generator-X.patch`) is
 * reference-only; the test installs the variant via runtime
 * monkey-patching against the vendored scratch-vm so we can
 * exercise the alternative without rebuilding the UMD.
 *
 * The variant hooks `JSGenerator.prototype.compile` so that after
 * the source string has been emitted it scans for the `yield`
 * keyword. If zero yields are found but `script.yields === true`,
 * the variant flips `script.yields` to `false` and re-runs
 * `createScriptFactory` + `scopedEval` so the returned compiled
 * function is a `function` instead of a `function*`. This catches
 * IR analyses that over-classified a script as yielding — which
 * is a strictly safe transformation because a generator with no
 * `yield` statements behaves identically to a plain function.
 *
 * Fixture (`generator-granularity-fixture.sb3`) layout:
 *   when_flag_clicked
 *     set [counter v] to 0
 *     set [sum v] to 0
 *     repeat (5)
 *       change [counter v] by 1
 *       call pure_inc_x100 v: counter   ← StackOpcode, warp, hot
 *       change [sum v] by (square reporter reporter v: counter) ← pure reporter
 *       wait (0.05) seconds             ← yield source
 *     end
 *     set [fact v] to (factorial (7))   ← recursive reporter
 *     stop all
 *
 *   procedures_definition pure_inc_x100 %n (warp:true, command)
 *     repeat (100)
 *       change [counter v] by 1
 *
 *   procedures_definition square %n (warp:true, reporter)
 *     return ((n) * (n))
 *
 *   procedures_definition factorial %n (warp:false, reporter, recursive)
 *     if <(n) = (1)> then return 1
 *     else return ((n) * (factorial ((n) - (1))))
 *
 * Expected final state after 200 steady-state _step() calls:
 *   counter = 505, sum = 561055, fact = 5040.
 *
 * Invariants pinned by this test (must hold for both baseline and
 * eval-X):
 *
 *   I1. The VM completes 200 frames without throwing.
 *   I2. Final `target.variables.{counter,sum,fact}` values match
 *       the deterministic baseline (= eval-X is purely cosmetic).
 *   I3. The eval-X variant reports `pureFlips >= 0` (= some
 *       scripts over-classified as yielding were re-classified).
 *       The exact count depends on the fixture; we only assert
 *       the variant ran (= non-null telemetry).
 *   I4. The vendored scratch-vm source under
 *       `vendored/scratch-vm/src/compiler/jsgen.js` does NOT
 *       contain `// TurboWasm: generator-eval-X` (the patch is
 *       reference-only and should never be auto-applied).
 *
 * If any invariant regresses, the variant is rejected and
 * `C:/files/memo/scratch-vm-optimization/phase-06-generator-analysis.md`
 * records "permanent skip" for eval-X.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  here,
  '../.test-fixtures/generator-granularity-fixture.sb3',
);

const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);
const VENDORED_JSGEN_PATH = resolve(
  VENDORED_VM_DIR,
  'src/compiler/jsgen.js',
);

const STEP_FRAMES = 200;

function loadFixtureBuffer(): Buffer {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `generator-granularity-fixture.sb3 missing at ${FIXTURE_PATH}; run \`npm run fixtures:setup\`.`,
    );
  }
  return readFileSync(FIXTURE_PATH);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installEvalX(vmDir: string): {
  detach: () => void;
  telemetry: () => { pureFlips: number; totalCompiled: number };
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cjsRequire = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const JSGenerator: any = cjsRequire(resolve(vmDir, 'src/compiler/jsgen.js'));
  const jsexecute = cjsRequire(resolve(vmDir, 'src/compiler/jsexecute.js'));
  const original = JSGenerator.prototype.compile;
  let pureFlips = 0;
  let totalCompiled = 0;
  JSGenerator.prototype.compile = function evalXCompile(...args: unknown[]) {
    totalCompiled += 1;
    const result = original.apply(this, args);
    if (this.script && this.script.yields === true) {
      const hasYield = /\byield\b/.test(this.source);
      if (!hasYield) {
        this.script.yields = false;
        pureFlips += 1;
        const factory = this.createScriptFactory();
        return jsexecute.scopedEval(factory);
      }
    }
    return result;
  };
  return {
    detach() {
      JSGenerator.prototype.compile = original;
    },
    telemetry: () => ({ pureFlips, totalCompiled }),
  };
}

interface RunResult {
  finalValues: Record<string, unknown>;
  threw: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runProjectWithVariant(
  VirtualMachine: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  installFn: ((vmDir: string) => { detach: () => void; telemetry: () => unknown }) | null,
  vmDir: string,
): Promise<RunResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const VM = VirtualMachine as any;
  const vm = new VM();
  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  vm.setCompilerOptions({ enabled: true });

  const projectBuffer = loadFixtureBuffer();
  const ab = new ArrayBuffer(projectBuffer.byteLength);
  new Uint8Array(ab).set(projectBuffer);

  const installed = installFn ? installFn(vmDir) : null;
  let threw = false;
  const finalValues: Record<string, unknown> = {};
  try {
    await vm.loadProject(ab);
    vm.runtime.greenFlag();
    for (let i = 0; i < STEP_FRAMES; i++) {
      try {
        vm.runtime._step();
      } catch (err) {
        threw = true;
        // eslint-disable-next-line no-console
        console.error('[eval-X] step threw:', err);
        break;
      }
    }
    for (const t of vm.runtime.targets) {
      if (t.isStage) continue;
      for (const varId of Object.keys(t.variables || {})) {
        const v = t.variables[varId];
        if (v && typeof v.name === 'string') {
          finalValues[v.name] = v.value;
        }
      }
    }
  } finally {
    if (installed) installed.detach();
    vm.runtime.stopAll();
  }
  return { finalValues, threw };
}

describe('§Phase 6 — eval-X semantic regression (generator-granularity fixture)', () => {
  if (!existsSync(FIXTURE_PATH)) {
    it.skip(
      'generator-granularity-fixture.sb3 missing; run `npm run fixtures:setup`.',
      () => {},
    );
    return;
  }
  if (!existsSync(resolve(VENDORED_VM_DIR, 'src/index.js'))) {
    it.skip('vendored scratch-vm missing; run `npm run setup`.', () => {});
    return;
  }
  const cjsRequire = createRequire(import.meta.url);
  const VirtualMachine = cjsRequire(resolve(VENDORED_VM_DIR, 'src/index.js'));

  it('baseline completes 200 frames without throwing (I1, control)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, null, VENDORED_VM_DIR);
    expect(result.threw).toBe(false);
  });

  it('eval-X completes 200 frames without throwing (I1)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, installEvalX, VENDORED_VM_DIR);
    expect(result.threw).toBe(false);
  });

  it('eval-X final counter / sum / fact matches baseline (I2)', async () => {
    const baseline = await runProjectWithVariant(VirtualMachine, null, VENDORED_VM_DIR);
    const evaled = await runProjectWithVariant(VirtualMachine, installEvalX, VENDORED_VM_DIR);
    expect(evaled.finalValues).toEqual(baseline.finalValues);
    // Sanity pin on the deterministic baseline so a fixture
    // regression is caught here too.
    expect(baseline.finalValues.counter).toBe(505);
    expect(baseline.finalValues.sum).toBe(561055);
    expect(baseline.finalValues.fact).toBe(5040);
  });

  it('eval-X telemetry reports pureFlips === 0 (I3 — this fixture has no IR over-classification)', async () => {
    const installed = installEvalX(VENDORED_VM_DIR);
    let telemetry: { pureFlips: number; totalCompiled: number };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const VM = VirtualMachine as any;
      const vm = new VM();
      vm.setCompilerOptions({ enabled: true });
      const projectBuffer = loadFixtureBuffer();
      const ab = new ArrayBuffer(projectBuffer.byteLength);
      new Uint8Array(ab).set(projectBuffer);
      await vm.loadProject(ab);
      vm.runtime.greenFlag();
      for (let i = 0; i < STEP_FRAMES; i++) {
        vm.runtime._step();
      }
      vm.runtime.stopAll();
      telemetry = installed.telemetry();
    } finally {
      installed.detach();
    }
    // This fixture has no IR over-classification: every script
    // marked `yields=true` actually contains a yield source. If
    // a future scratch-vm bump changes the IR analysis and starts
    // over-classifying, eval-X should catch it and report
    // `pureFlips > 0`. For the current scratch-vm ref
    // (`925f1134`) the count is 0.
    expect(telemetry.totalCompiled).toBeGreaterThan(0);
    expect(telemetry.pureFlips).toBe(0);
  });

  it('vendored source does not contain the reference marker (I4)', () => {
    if (!existsSync(VENDORED_JSGEN_PATH)) return;
    const text = readFileSync(VENDORED_JSGEN_PATH, 'utf8');
    expect(text).not.toContain('// TurboWasm: generator-eval-X');
  });
});
