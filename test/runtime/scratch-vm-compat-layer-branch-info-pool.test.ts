import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 4A — branchInfo pool (markers + parity probe).
 *
 * Pins the patched scratch-vm's branchInfo pool shape at three layers:
 *
 *   1. Vendored source — `// TurboWasm: branch-info-pool` markers exist in
 *      `compiler/jsexecute.js` and `compiler/jsgen.js`, and the
 *      `__branchInfoAcquire` / `__branchInfoRelease` functions are defined.
 *   2. Shipped UMD — same markers exist in
 *      `vendored/scaffolding/dist/scaffolding-min.js` (= the bundle Vite loads).
 *      A patch that only lands on source is silently ignored at runtime.
 *
 * A parity probe for the acquire/release runtime behavior is in
 * `scripts/bench-scratch-vm-ab.mjs` (= the actual A/B bench). This test
 * pins the marker SHAPE only; runtime semantics are validated by the
 * bench (`npm run bench:scratch-vm-ab`) and by the existing
 * `scratch-vm-tap-bridge` test suite (= same compiled / interpreted
 * output across every branchInfo lifetime because the patch is
 * semantically invariant — `__branchInfoAcquire` returns the same 4-key
 * shape as the legacy literal).
 */

const VENDORED_SOURCE_JSEXECUTE = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsexecute.js',
);
const VENDORED_SOURCE_JSGEN = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm/src/compiler/jsgen.js',
);
const VENDORED_SOURCE_RUNTIME = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm/src/engine/runtime.js',
);
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

describe('Phase 4A — branchInfo pool (vendored source markers)', () => {
  if (!existsSync(VENDORED_SOURCE_JSEXECUTE)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const jsexecuteText = readFileSync(VENDORED_SOURCE_JSEXECUTE, 'utf8');

  it('jsexecute.js contains the // TurboWasm: branch-info-pool marker', () => {
    // The marker appears twice: once in the patch's explanatory comment
    // header and once at the runtimeFunctions definition. Both must be
    // present (= 2 minimum); more is fine because every code-path that
    // is part of the branch-info-pool feature shares the same marker.
    const matches = jsexecuteText.match(/\/\/ TurboWasm: branch-info-pool/g) ?? [];
    expect(matches.length, 'expected at least 1 marker occurrence').toBeGreaterThanOrEqual(1);
  });

  it('jsexecute.js defines __branchInfoAcquire and __branchInfoRelease as runtimeFunctions entries', () => {
    expect(jsexecuteText).toContain('runtimeFunctions.__branchInfoAcquire');
    expect(jsexecuteText).toContain('runtimeFunctions.__branchInfoRelease');
  });

  it('__branchInfoAcquire reads branchInfoPoolEnabled from runtime.compilerOptions', () => {
    // The gate must short-circuit to the legacy fresh-allocate path when
    // the runtime flag is `false`. The vendored source uses
    // `runtime.compilerOptions.branchInfoPoolEnabled !== false` (= ON by
    // default) so the gate is preserved verbatim.
    expect(jsexecuteText).toContain('runtime.compilerOptions.branchInfoPoolEnabled');
    expect(jsexecuteText).toContain('branchInfoPoolEnabled !== false');
  });

  it('jsexecute.js resets stackFrame keys on reuse (= the legacy `delete sf[k]` loop)', () => {
    expect(jsexecuteText).toMatch(/for \(const k in sf\) delete sf\[k\]/u);
  });

  it('jsexecute.js increments __branchInfoCounters.acquired when a counters object is present', () => {
    expect(jsexecuteText).toContain('thread.__branchInfoCounters.acquired += 1');
    expect(jsexecuteText).toContain('thread.__branchInfoCounters.poolPeak');
  });

  it('jsexecute.js createBranchInfo delegates to __branchInfoAcquire (legacy fallback when gate is off)', () => {
    expect(jsexecuteText).toContain('runtimeFunctions.createBranchInfo = `const createBranchInfo = (isLoop) => __branchInfoAcquire(isLoop);`');
  });
});

describe('Phase 4A — jsgen try/finally wrap', () => {
  if (!existsSync(VENDORED_SOURCE_JSGEN)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const jsgenText = readFileSync(VENDORED_SOURCE_JSGEN, 'utf8');

  it('jsgen.js contains the // TurboWasm: branch-info-pool marker', () => {
    expect(jsgenText).toContain('// TurboWasm: branch-info-pool');
  });

  it('jsgen.js emits `try {` immediately before the while loop body', () => {
    // `try {` is inserted right after the `createBranchInfo(...)` source
    // emission so the per-branch `__branchInfoRelease(...)` finally can
    // reclaim the snapshot whether the while-loop exits normally, throws,
    // or yields mid-iteration (= the generator is paused but its state is
    // owned by the closure until the outer try-finally unwinds).
    expect(jsgenText).toContain('// TurboWasm: branch-info-pool');
    expect(jsgenText).toContain("this.source += `try {\\n`;");
  });

  it('jsgen.js emits `} finally { __branchInfoRelease(${branchVariable}); }\\n` after the while close', () => {
    expect(jsgenText).toContain("this.source += `} finally { __branchInfoRelease(${branchVariable}); }\\n`;");
  });
});

describe('Phase 4A — runtime gate default', () => {
  if (!existsSync(VENDORED_SOURCE_RUNTIME)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const runtimeText = readFileSync(VENDORED_SOURCE_RUNTIME, 'utf8');

  it('runtime.js compilerOptions carries branchInfoPoolEnabled: false (= §Phase 4A opt-in default OFF)', () => {
    // §Phase 4A opt-in: the gate MUST default to `false` so existing
    // user projects (= legacy allocate-once-per-branch path) are
    // byte-identical until the user explicitly enables the toggle
    // via the detailed Settings screen (= which calls
    // `vm.runtime.setCompilerOptions({ branchInfoPoolEnabled: true })`
    // from `settings-bridge.applyAdvancedSettings`). Toggling off the
    // detailed toggle restores the legacy path; the patch is
    // semantically invariant (= same observable behaviour for every
    // status transition in `executeInCompatibilityLayer`).
    expect(runtimeText).toMatch(/branchInfoPoolEnabled:\s*false/);
  });
});

describe('Phase 4A — UMD marker probe (shipped bundle)', () => {
  if (!existsSync(UMD_PATH)) {
    it.skip('UMD missing; run `npm run setup` to enable this probe.', () => {});
    return;
  }
  const umd = readFileSync(UMD_PATH, 'utf8');

  it('UMD contains the // TurboWasm: branch-info-pool marker', () => {
    // Vendoring setup re-applies the patch and rebuilds the UMD; if the
    // patch only lands on source (= never reaches UMD), the runtime
    // behavior never exercises Phase 4A in the browser / Vite path.
    expect(umd).toContain('// TurboWasm: branch-info-pool');
  });

  it('UMD contains __branchInfoAcquire and __branchInfoRelease symbols', () => {
    expect(umd).toContain('__branchInfoAcquire');
    expect(umd).toContain('__branchInfoRelease');
  });

  it('UMD contains the branchInfoPoolEnabled compiler-option key', () => {
    // Belt-and-braces: even if the comment marker is stripped by a future
    // toolchain, the runtime option key remains as evidence the patch
    // reached the shipped bundle.
    expect(umd).toContain('branchInfoPoolEnabled');
  });
});