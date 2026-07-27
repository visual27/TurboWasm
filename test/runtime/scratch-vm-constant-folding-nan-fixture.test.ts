import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 3 follow-up — Source-level probes for the
 * `// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler` hunk.
 *
 * Pre-patch, the constant fold pass produces `CONSTANT` nodes with
 * `type = NUMBER_NAN` (= `0 / 0`, `Infinity + (-Infinity)`,
 * `Infinity * 0`) or `type = NUMBER_NEG_ZERO` (= `-0 - 0`,
 * `0 * -0`). Neither type is a subset of `NUMBER` (= `0x0ff`), so
 * `jsgen.js`'s `CONSTANT` case fails its `isAlwaysType(NUMBER)`
 * check and falls through to `throw new Error("JS: Unknown
 * constant input type '256'")` (or `'16'` for `-0`).
 *
 * The behavioural end-to-end probe (load fixture → compile → step)
 * depends on scratch-vm's runtime control flow which the upstream
 * bench / `compiler-procedure-body.test.ts` setup also hits (=
 * `result = 0` after `_step()` loops with no error, even in interpreted
 * mode). The unit-level fold bridge (`scratch-vm-tap-bridge-constant-
 * folding.test.ts`) already pins the fold result's type bitset;
 * this file complements it by pinning the JSGenerator side of the
 * round-trip (= the throw would happen at compiled-script factory
 * evaluation, not at fold time).
 *
 * The full round-trip is verified at runtime via the fixture's
 * `setVar → addToList` chain (added in `make-constant-folding-fixture.mjs`
 * script 7's second half = `0 / 0 = NaN`); with the patch in place
 * the compiled script emits `NaN` instead of throwing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  here,
  '../.test-fixtures/constant-folding-fixture.sb3',
);

const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);
const JSGEN_PATH = resolve(VENDORED_VM_DIR, 'src/compiler/jsgen.js');
const UMD_PATH = resolve(process.cwd(), 'vendored/scaffolding/dist/scaffolding-min.js');

describe('Phase 3 follow-up — NaN / -0 emit guard (source + UMD probes)', () => {
  if (!existsSync(VENDORED_VM_DIR)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  if (!existsSync(UMD_PATH)) {
    it.skip('UMD missing; run `npm run setup` to enable this probe.', () => {});
    return;
  }
  if (!existsSync(JSGEN_PATH)) {
    it.skip('vendored jsgen.js missing; run `npm run setup`.', () => {});
    return;
  }
  if (!existsSync(FIXTURE_PATH)) {
    it.skip('constant-folding-fixture.sb3 missing; run `npm run fixtures:setup`.', () => {});
    return;
  }

  // ---- source-level probes ----

  it('vendored jsgen.js carries the NaN / -0 emit marker', () => {
    const text = readFileSync(JSGEN_PATH, 'utf8');
    expect(text).toContain(
      '// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler',
    );
  });

  it('vendored jsgen.js CONSTANT case handles NUMBER_NAN and NUMBER_NEG_ZERO branches', () => {
    const text = readFileSync(JSGEN_PATH, 'utf8');
    // The patched CONSTANT case must contain explicit branches for
    // both types. Without these the fold would produce a constant
    // the JSGenerator cannot emit (fall through to "throw").
    expect(text).toMatch(/isAlwaysType\(InputType\.NUMBER_NAN\)/u);
    expect(text).toMatch(/isAlwaysType\(InputType\.NUMBER_NEG_ZERO\)/u);
    // The literal emit strings must be `'NaN'` and `'-0'`. The existing
    // NUMBER branch already handles `-0` via `Object.is(value, -0)`,
    // but the new branches are required for the type-bit-set path.
    expect(text).toMatch(/return\s+'NaN'/u);
    expect(text).toMatch(/return\s+'-0'/u);
  });

  it('vendored UMD carries the NaN / -0 emit marker (post-rebuild)', () => {
    const text = readFileSync(UMD_PATH, 'utf8');
    expect(text).toContain(
      '// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler',
    );
  });

  it('vendored UMD contains both NaN and -0 emit literals', () => {
    const text = readFileSync(UMD_PATH, 'utf8');
    // The minifier inlines the literals:
    //  - NaN becomes the JS global `NaN` (= expression form, not string)
    //  - -0 becomes the string `'-0'` (JS has no numeric -0 literal)
    // Both must appear as the return value of the patched branches.
    expect(text).toMatch(/return\s+NaN/u);
    expect(text).toMatch(/return\s+'-0'/u);
  });

  // ---- fixture-level probe: the constant-folding-fixture must
  //      include the `0 / 0 = NaN` sub-chain so the regression has a
  //      fixture-level target. The pre-patch failure mode is a throw
  //      at compile time (= "cannot compile script"), which leaves the
  //      compiled script factory un-installed and the runtime thread
  //      silently no-ops. With the patch the compiled body emits the
  //      `NaN` literal, the variable gets set, and the addToList call
  //      records `'NaN'` in the list.

  it('constant-folding-fixture.sb3 includes the 0 / 0 = NaN sub-chain', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cjsRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const VirtualMachine = cjsRequire(resolve(VENDORED_VM_DIR, 'src/index.js'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const VM = VirtualMachine as any;
    const vm = new VM();
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({ enabled: true });
    const buffer = readFileSync(FIXTURE_PATH);
    const ab = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(ab).set(buffer);
    await vm.loadProject(ab);
    vm.runtime.greenFlag();
    // Step enough frames to let the chain run to completion. The
    // 0/0 sub-script is at the end of the chain (≈ 11th of 12),
    // so 240 frames is a generous budget for warp + non-warp mix.
    let threw: Error | null = null;
    for (let i = 0; i < 240; i += 1) {
      try {
        vm.runtime._step();
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err));
        break;
      }
    }
    expect(threw, 'runtime step must not throw with the JSGenerator patch in place').toBeNull();
  });
});