import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 4B — Blocks._cache.compiledScripts Map backing (markers + parity probe).
 *
 * Pins the patched scratch-vm's compiledScripts Map shape at three layers:
 *
 *   1. Vendored source — `// TurboWasm: blocks-cache-map` markers exist in
 *      `engine/blocks.js` (4 sites: cache init comment, getCachedCompileResult,
 *      cacheCompileResult, cacheCompileError, resetCache) + `engine/runtime.js`
 *      (compilerOptions gate). The gate reads `runtime.compilerOptions
 *      .mapConversionEnabled` (= NOT the never-set `this._cache` field that
 *      an earlier prototype used).
 *   2. Shipped UMD — same markers exist in
 *      `vendored/scaffolding/dist/scaffolding-min.js` (= the bundle Vite loads).
 *      A patch that only lands on source is silently ignored at runtime.
 *   3. Constructor wire-up — `Blocks` registers a `COMPILER_OPTIONS_CHANGED`
 *      listener that calls `resetCache()`, so a toggle change mid-session
 *      migrates the cache shape between `{}` and `Map()` instead of leaving
 *      a stale `{}` with `Map.set()` callers (= TypeError).
 *
 * The runtime behaviour is semantically invariant (= the Map branch and the
 * `{}` branch return the same `{success, value}` shape for every blockId).
 * `scratch-vm-tap-bridge` covers the compile-result end-to-end; this file
 * pins the marker SHAPE only.
 */

const VENDORED_SOURCE_BLOCKS = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm/src/engine/blocks.js',
);
const VENDORED_SOURCE_RUNTIME = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm/src/engine/runtime.js',
);
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

describe('Phase 4B — vendored source markers (blocks.js)', () => {
  if (!existsSync(VENDORED_SOURCE_BLOCKS)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const blocksText = readFileSync(VENDORED_SOURCE_BLOCKS, 'utf8');

  it('blocks.js carries the compiledScripts comment describing the Map opt-in', () => {
    // The compiledScripts cache field JSDoc must mention both shapes (`{}` and
    // `Map<...>`) so future readers know the runtime can flip between them.
    // The marker appears at the JSDoc header (= not the implementation sites)
    // so a single regex match is enough to pin the wire-up contract.
    expect(blocksText).toMatch(/turboWasm:\s*blocks-cache-map/i);
  });

  it('blocks.js compiledScripts JSDoc lists the Map shape', () => {
    // `@type {object<string, object>|Map<string, object>}` — the dual type
    // signals that the cache is a Map when the runtime flag is on.
    expect(blocksText).toMatch(
      /@type\s*\{\s*object\s*<\s*string\s*,\s*object\s*>\s*\|\s*Map\s*<\s*string\s*,\s*object\s*>\s*\}/,
    );
  });

  it('blocks.js getCachedCompileResult gates on runtime.compilerOptions.mapConversionEnabled', () => {
    // The Map branch must read the runtime flag, NOT a stale
    // `this._cache.mapConversionEnabled` (= the original prototype that was
    // never wired up and silently fell through to the legacy `{}` path).
    expect(blocksText).toContain('this.runtime.compilerOptions.mapConversionEnabled');
  });

  it('blocks.js getCachedCompileResult returns null for missing Map keys', () => {
    // `Map.get()` returns `undefined` for missing keys, but the contract is
    // `null` (= legacy `hasOwnProperty` + missing → return null). The patch
    // must normalize `undefined` → `null` so callers can use `=== null` to
    // detect a cache miss.
    expect(blocksText).toMatch(
      /this\._cache\.compiledScripts\.get\([\s\S]*?typeof v === ['"]undefined['"] \? null : v/s,
    );
  });

  it('blocks.js cacheCompileResult writes through Map.set when the flag is on', () => {
    expect(blocksText).toMatch(
      /cacheCompileResult[\s\S]*?this\.runtime\.compilerOptions\.mapConversionEnabled[\s\S]*?this\._cache\.compiledScripts\.set\(/,
    );
  });

  it('blocks.js cacheCompileError writes through Map.set when the flag is on', () => {
    expect(blocksText).toMatch(
      /cacheCompileError[\s\S]*?this\.runtime\.compilerOptions\.mapConversionEnabled[\s\S]*?this\._cache\.compiledScripts\.set\(/,
    );
  });

  it('blocks.js resetCache re-initializes the cache shape based on the runtime flag', () => {
    // The reset path must drop both shapes (`{}` and `Map()`) so previous-
    // frame entries never leak into a fresh project / compile result.
    expect(blocksText).toMatch(
      /resetCache[\s\S]*?this\._cache\.compiledScripts = new Map\(\)[\s\S]*?this\._cache\.compiledScripts = \{\}/,
    );
  });
});

describe('Phase 4B — runtime gate default (opt-in OFF)', () => {
  if (!existsSync(VENDORED_SOURCE_RUNTIME)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const runtimeText = readFileSync(VENDORED_SOURCE_RUNTIME, 'utf8');

  it('runtime.js compilerOptions carries mapConversionEnabled: false (= §Phase 4B opt-in default OFF)', () => {
    // §Phase 4B opt-in: the gate MUST default to `false` so existing user
    // projects (= legacy plain-`{}` lookup) are byte-identical until the
    // user explicitly enables the toggle via the detailed Settings screen
    // (= which calls `vm.runtime.setCompilerOptions({ mapConversionEnabled: true })`
    // from `settings-bridge.applyAdvancedSettings`). Toggling off the
    // detailed toggle restores the legacy path; the patch is semantically
    // invariant (= same observable behaviour for every blockId across cache
    // hit, miss, error path).
    expect(runtimeText).toMatch(/mapConversionEnabled:\s*false/);
  });

  it('runtime.js mapConversionEnabled comment cites the blocks-cache-map marker', () => {
    // Belt-and-braces: the wire-up contract is bidirectional (runtime.js
    // declares the flag, blocks.js reads it). The comment in runtime.js
    // should reference the marker so a grep finds both ends.
    expect(runtimeText).toMatch(/blocks-cache-map/);
  });
});

describe('Phase 4B — constructor wire-up (COMPILER_OPTIONS_CHANGED listener)', () => {
  if (!existsSync(VENDORED_SOURCE_BLOCKS)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const blocksText = readFileSync(VENDORED_SOURCE_BLOCKS, 'utf8');

  it('Blocks constructor subscribes to COMPILER_OPTIONS_CHANGED → resetCache', () => {
    // Without this listener, a toggle change mid-session would leave
    // `this._cache.compiledScripts` as a stale `{}` while the accessors
    // call `Map.set()` / `Map.get()` (= TypeError on every compile).
    expect(blocksText).toMatch(
      /this\.runtime\.on\(\s*['"]COMPILER_OPTIONS_CHANGED['"][\s\S]*?this\.resetCache\(\)/,
    );
  });

  it('Blocks constructor listener is registered AFTER forceNoGlow (= inside the constructor body)', () => {
    // The listener must live in the constructor (not in resetCache) so it
    // fires exactly once per Blocks instance, not on every resetCache call.
    const listenerIdx = blocksText.search(
      /this\.runtime\.on\(\s*['"]COMPILER_OPTIONS_CHANGED['"]/,
    );
    const forceNoGlowIdx = blocksText.indexOf('this.forceNoGlow = optNoGlow');
    expect(listenerIdx).toBeGreaterThan(forceNoGlowIdx);
  });
});

describe('Phase 4B — UMD marker probe (shipped bundle)', () => {
  if (!existsSync(UMD_PATH)) {
    it.skip('UMD missing; run `npm run setup` to enable this probe.', () => {});
    return;
  }
  const umd = readFileSync(UMD_PATH, 'utf8');

  it('UMD contains the // TurboWasm: blocks-cache-map marker', () => {
    // Vendoring setup re-applies the patch and rebuilds the UMD; if the
    // patch only lands on source (= never reaches UMD), the runtime
    // behavior never exercises Phase 4B in the browser / Vite path.
    expect(umd).toContain('// TurboWasm: blocks-cache-map');
  });

  it('UMD contains the mapConversionEnabled compiler-option key', () => {
    // Belt-and-braces: even if the comment marker is stripped by a future
    // toolchain, the runtime option key remains as evidence the patch
    // reached the shipped bundle.
    expect(umd).toContain('mapConversionEnabled');
  });

  it('UMD contains both `{}` and `Map` branches for the cache accessors', () => {
    // The patch introduces two code paths: `Object.prototype.hasOwnProperty`
    // for the legacy `{}` shape and `Map.get` / `Map.set` for the opt-in
    // shape. Both must survive the UMD minification.
    const hasOwnPattern = /hasOwnProperty\.call\([^,]+,\s*['"]?blockId['"]?\)/;
    const mapGetPattern = /\.compiledScripts\.get\(/;
    expect(umd).toMatch(hasOwnPattern);
    expect(umd).toMatch(mapGetPattern);
  });
});
