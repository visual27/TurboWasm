import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2-A — compat-layer closure finish extraction.
 *
 * The `// TurboWasm: compat-layer-finish-extracted` hunk in
 * `patches/vendored/scratch-vm.patch` rewrites
 * `executeInCompatibilityLayer` so the per-call `finish(returnValue)`
 * closure and the `executeBlock()` closure are both eliminated:
 *
 *   - The body of the old `finish` closure is hoisted into a
 *     baseRuntime-level `finishCompatibilityCall(returnValue, branchInfo,
 *     blockUtility)` function (callable from every return path).
 *   - The body of the old `executeBlock` closure is inlined directly:
 *     `blockUtility.init(thread, blockId, stackFrame);` followed by
 *     `blockFunction(inputs, blockUtility);` — at the function entry
 *     and at every resume point after `yield`.
 *
 * The hunk is **semantically invariant** — every status transition
 * (STATUS_PROMISE_WAIT, STATUS_DONE, STATUS_YIELD, STATUS_YIELD_TICK,
 * promise resolve / reject, branch / loop startBranch returns) takes
 * the same return path with the same value as the legacy closure
 * shape. The optimization's value is purely per-call allocation
 * reduction; the MVP bench on `compat-layer-loop-fixture.sb3` showed
 * a ≈12% heapDelta improvement in compiled mode and no wall-clock
 * delta, which is below the §2A-8 15% heap adoption threshold but
 * above the no-regression baseline, so the hunk ships in production
 * with a cosmetic UI toggle (no runtime gate).
 *
 * This test pins the patch shape at three layers:
 *
 *  1. **Vendored source** — the marker is present in
 *     `vendored/scratch-vm/src/compiler/jsexecute.js` exactly once
 *     and the patched code shape (hoisted function definition,
 *     inlined init + blockFunction, no nested `finish` / `executeBlock`
 *     closures) matches the post-patch source.
 *  2. **Shipped UMD** — the marker is present in
 *     `vendored/scaffolding/dist/scaffolding-min.js`. Vite loads the
 *     UMD via `resolve.alias`, so a patch that only lands on source
 *     is silently ignored at runtime.
 *
 * A full-projection runtime test (= "did `executeInCompatibilityLayer`
 * resolve to the right value across every status transition") is
 * intentionally NOT included here. Constructing valid scratch-vm
 * scenarios for every status code in jsdom is fragile because
 * scratch-vm's `blockToXML` walks both `inputs.*.block` and `next`
 * and trips on a cycle if the block graph isn't perfectly
 * cycle-free. The semantic invariance is verified by the
 * `scratch-vm-tap-bridge-cast-compare.test.ts` style integration
 * tests in Phase 1; for Phase 2-A the unit tests here pin the
 * patch shape so a regression that reintroduces the per-call
 * `finish` / `executeBlock` closures (= moves the patch back to the
 * pre-patch shape) fails CI without needing the runtime path.
 */
const VENDORED_SOURCE = resolve(
  process.cwd(),
  'vendored/scratch-vm/src/compiler/jsexecute.js',
);
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

describe('Phase 2-A — compat-layer closure finish extraction (source-level markers)', () => {
  if (!existsSync(VENDORED_SOURCE)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const text = readFileSync(VENDORED_SOURCE, 'utf8');

  it('jsexecute.js contains the // TurboWasm: compat-layer-finish-extracted marker', () => {
    const matches = text.match(/\/\/ TurboWasm: compat-layer-finish-extracted/g) ?? [];
    // Exactly one occurrence: the marker is attached to the
    // `finishCompatibilityCall` definition at the baseRuntime level.
    // A regression that drops the patch (or accidentally introduces
    // a duplicate marker line) trips this assertion.
    expect(matches.length, 'expected exactly 1 marker occurrence').toBe(1);
  });

  it('jsexecute.js defines finishCompatibilityCall at baseRuntime level', () => {
    // The post-patch source defines the function with the spec'd
    // 3-argument signature. The function lives at the baseRuntime
    // level (i.e. in the `baseRuntime` string passed to
    // `JSGenerator`), not nested inside `executeInCompatibilityLayer`.
    const match = text.match(
      /const finishCompatibilityCall = \(returnValue, branchInfo, blockUtility\) =>/u,
    );
    expect(match, 'finishCompatibilityCall definition not found').not.toBeNull();
  });

  it('jsexecute.js no longer has the legacy per-call `finish` closure inside executeInCompatibilityLayer', () => {
    // The pre-patch source had `const finish = (returnValue) => { ... };`
    // inside `executeInCompatibilityLayer`. The post-patch source
    // hoists the logic out to `finishCompatibilityCall`. The marker
    // is the only `// TurboWasm:` line permitted in jsexecute.js, so
    // a reintroduction of the legacy closure is the only way this
    // pattern can reappear.
    expect(text, 'legacy `const finish = (returnValue) =>` closure must be removed').not.toMatch(
      /const finish = \(returnValue\) =>/u,
    );
  });

  it('jsexecute.js no longer has the legacy `executeBlock` closure', () => {
    // The pre-patch source had `const executeBlock = () => { ... };`
    // inside `executeInCompatibilityLayer`. The post-patch source
    // inlines `blockUtility.init` + `blockFunction(...)` directly.
    expect(text, 'legacy `const executeBlock = () =>` closure must be removed').not.toMatch(
      /const executeBlock = \(\) =>/u,
    );
  });

  it('jsexecute.js calls finishCompatibilityCall in every return path of executeInCompatibilityLayer', () => {
    // Post-patch, every `return` from `executeInCompatibilityLayer`
    // goes through `finishCompatibilityCall(...)` — the patch moves
    // the branchInfo writeback out of the inline `finish(...)` call
    // into a single shared helper. The pre-patch source had `return
    // '';` and `return finish(...);` as inline returns. Count the
    // `finishCompatibilityCall(` call-site occurrences to ensure all
    // paths (initial promise resolve, status=1/4 yield, resume promise
    // resolve, status=1/4 yield again, final return) were rewritten.
    // We expect exactly 5 call sites:
    //   1. initial Promise resolve path
    //   2. STATUS_PROMISE_WAIT / STATUS_DONE yield path (initial)
    //   3. resume Promise resolve path
    //   4. STATUS_PROMISE_WAIT / STATUS_DONE yield path (resumed)
    //   5. final return path
    // The definition itself uses `finishCompatibilityCall = (` (not `(`)
    // so it is not counted by this regex.
    const matches = text.match(/finishCompatibilityCall\(/gu) ?? [];
    expect(
      matches.length,
      'expected exactly 5 call sites — every return path must route through finishCompatibilityCall',
    ).toBe(5);
  });

  it('jsexecute.js has the inlined `blockUtility.init` + `blockFunction` shape at the function entry', () => {
    // The post-patch source opens `executeInCompatibilityLayer` with
    // the inlined init + blockFunction pair, with no wrapping
    // closure. The pre-patch source wrapped these inside
    // `executeBlock()`. Verifying the direct-call shape catches
    // accidental closure re-introductions.
    const entryShape = text.match(
      /const executeInCompatibilityLayer = function\*\(inputs, blockFunction, isWarp, useFlags, blockId, branchInfo\) \{[\s\S]*?blockUtility\.init\(thread, blockId, stackFrame\);[\s\S]*?let returnValue = blockFunction\(inputs, blockUtility\);/u,
    );
    expect(entryShape, 'executeInCompatibilityLayer must inline blockUtility.init + blockFunction at entry').not.toBeNull();
  });
});

describe('Phase 2-A — compat-layer closure finish extraction (UMD marker probe)', () => {
  // The vendored UMD is the canonical place to look for markers
  // because Vite loads `vendored/scaffolding/dist/scaffolding-min.js`
  // via `resolve.alias['@turbowarp/scaffolding']`, NOT the source
  // files. A patch that only lands on source is silently ignored at
  // runtime (see `scratch-vm-patches-symbols.test.ts` for the
  // parallel comment).
  if (!existsSync(UMD_PATH)) {
    it.skip('UMD missing; run `npm run setup` to enable this probe.', () => {});
    return;
  }
  const umd = readFileSync(UMD_PATH, 'utf8');

  it('UMD contains the // TurboWasm: compat-layer-finish-extracted marker', () => {
    const matches = umd.match(/\/\/ TurboWasm: compat-layer-finish-extracted/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('UMD defines finishCompatibilityCall (i.e. the patch is in the shipped bundle, not just the source)', () => {
    expect(umd).toContain('finishCompatibilityCall');
  });
});
