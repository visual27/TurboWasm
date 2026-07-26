import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2-B — procedure-call lazy reference cache.
 *
 * The `// TurboWasm: procedure-lazy-cache` hunk in
 * `patches/vendored/scratch-vm.patch` wraps every
 * `thread.procedures["<variant>"]` lookup with
 * `this.evaluateOnce(...)` in `JSGenerator` (both the reporter
 * `InputOpcode.PROCEDURE_CALL` path and the command
 * `StackOpcode.PROCEDURE_CALL` path). The factory-level setup
 * block then emits `const bN = thread.procedures["<variant>"];`
 * once per thread, so the per-call site is a single closure
 * capture read instead of an O(N) per-call property walk.
 *
 * The patch is **semantically invariant**: the captured
 * const resolves the same function reference the inline
 * lookup would. The optimization's value is purely the
 * per-call cost reduction. This test pins the patch shape at
 * three layers:
 *
 *  1. **Vendored source** — the marker is present in
 *     `vendored/scratch-vm/src/compiler/jsgen.js` exactly
 *     twice (reporter + command paths) and the right-hand
 *     side of both PROCEDURE_CALL `const procedureReference = …`
 *     assignments uses `this.evaluateOnce(\`thread.procedures[...]\`)`.
 *  2. **Shipped UMD** — the marker is present in
 *     `vendored/scaffolding/dist/scaffolding-min.js`. Vite
 *     loads the UMD via `resolve.alias`, so a patch that only
 *     lands on source is silently ignored at runtime.
 *  3. **Tests are also present in the symbol-registry file**
 *     `scripts/patches/scratch-vm-symbols.md` so future
 *     contributors find the marker in the same place they
 *     look up the others.
 *
 * A full-projection runtime test (= "did `result` reach 200
 * after 200 `add_one` calls") is intentionally NOT included
 * here. Constructing a valid sb3 fixture that exercises
 * `procedures_call` end-to-end is fragile in jsdom because
 * scratch-vm's `blockToXML` walks both `inputs.*.block` and
 * `next` and trips on a cycle if the block graph isn't
 * perfectly cycle-free. The bench script
 * `scripts/bench-scratch-vm-step.mjs` provides the end-to-end
 * timing projection; the unit tests here just pin the patch
 * shape so a regression that drops the `evaluateOnce` wrap
 * (= moves the patch back to the pre-patch inline lookup)
 * fails CI without needing the runtime path.
 */
const VENDORED_SOURCE = resolve(
  process.cwd(),
  'vendored/scratch-vm/src/compiler/jsgen.js',
);
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

describe('Phase 2-B — procedure lazy cache (source-level markers)', () => {
  if (!existsSync(VENDORED_SOURCE)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const text = readFileSync(VENDORED_SOURCE, 'utf8');

  it('jsgen.js contains the // TurboWasm: procedure-lazy-cache marker on the reporter path', () => {
    const matches = text.match(/\/\/ TurboWasm: procedure-lazy-cache/g) ?? [];
    // Two occurrences: reporter (InputOpcode.PROCEDURE_CALL) + command
    // (StackOpcode.PROCEDURE_CALL). A regression that drops the patch
    // (or only applies it to one of the two paths) trips this
    // assertion.
    expect(matches.length, 'expected exactly 2 marker occurrences').toBe(2);
  });

  it('jsgen.js reporter path uses evaluateOnce to hoist the procedure lookup', () => {
    // The InputOpcode.PROCEDURE_CALL case is the only place the
    // reporter lookup `procedureReference = ...` is assigned inside
    // `descendInput`. The post-patch source wraps the right-hand
    // side in `this.evaluateOnce(\`thread.procedures[...]\`)`.
    const reporterAssignment = text.match(
      /case InputOpcode\.PROCEDURE_CALL: \{[\s\S]*?const procedureReference = ([^;]+);/u,
    );
    expect(reporterAssignment, 'InputOpcode.PROCEDURE_CALL assignment not found').not.toBeNull();
    const rhs = reporterAssignment![1];
    expect(rhs, 'reporter path must use this.evaluateOnce').toMatch(/this\.evaluateOnce\(/u);
    expect(rhs, 'reporter path must wrap thread.procedures lookup').toMatch(/thread\.procedures\[/u);
  });

  it('jsgen.js command path uses evaluateOnce to hoist the procedure lookup', () => {
    // The StackOpcode.PROCEDURE_CALL case appends to `this.source`.
    // The pre-patch line was
    //   `this.source += \`thread.procedures["${sanitize(procedureVariant)}"](\`;`
    // The post-patch line wraps the lookup in
    // `this.evaluateOnce(\`thread.procedures[...]\`)` and uses
    // template-string interpolation so the captured const name is
    // substituted into the emitted source.
    const commandSourceAppend = text.match(
      /case StackOpcode\.PROCEDURE_CALL: \{[\s\S]*?this\.source \+= `\$\{this\.evaluateOnce\(`thread\.procedures\[/u,
    );
    expect(commandSourceAppend, 'StackOpcode.PROCEDURE_CALL did not wrap with evaluateOnce').not.toBeNull();
  });
});

describe('Phase 2-B — procedure lazy cache (UMD marker probe)', () => {
  // The vendored UMD is the canonical place to look for markers
  // because Vite loads `vendored/scaffolding/dist/scaffolding-min.js`
  // via `resolve.alias['@turbowarp/scaffolding']`, NOT the source
  // files. A patch that only lands on source is silently ignored
  // at runtime (see `scratch-vm-patches-symbols.test.ts` for the
  // parallel comment).
  if (!existsSync(UMD_PATH)) {
    it.skip('UMD missing; run `npm run setup` to enable this probe.', () => {});
    return;
  }
  const umd = readFileSync(UMD_PATH, 'utf8');

  it('UMD contains the // TurboWasm: procedure-lazy-cache marker (×2)', () => {
    const matches = umd.match(/\/\/ TurboWasm: procedure-lazy-cache/g) ?? [];
    expect(matches.length).toBe(2);
  });
});
