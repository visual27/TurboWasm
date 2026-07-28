import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 7 — semantics compiler-options bag (markers + parity probe).
 *
 * Pins the vendored scratch-vm's `runtime.compilerOptions.semantics`
 * shape at three layers:
 *
 *   1. Vendored source — `// TurboWasm: semantics-compiler-options`
 *      marker exists in `engine/runtime.js` near the
 *      `compilerOptions = { ... }` initializer, and the bag carries
 *      the five flag defaults (`strictNumericEquality` /
 *      `caseSensitiveStrings` / `propagateNaN` / `truncatedModulo` /
 *      `jsTruthyBooleans`) with `false` values (= Scratch-compatible
 *      defaults).
 *   2. Shipped UMD — same marker exists in
 *      `vendored/scaffolding/dist/scaffolding-min.js` (= the bundle
 *      Vite loads). A patch that only lands on source is silently
 *      ignored at runtime.
 *
 * The runtime behaviour (= Phase 8 / 9 wiring the per-flag fields
 * into `compareEqual` / `Cast.compare` / `data_setvariableto`) is
 * out of scope for Phase 7. This file pins the marker SHAPE and
 * default values only.
 */

const VENDORED_SOURCE_RUNTIME = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm/src/engine/runtime.js',
);
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

describe('Phase 7 — semantics-compiler-options (vendored source markers)', () => {
  if (!existsSync(VENDORED_SOURCE_RUNTIME)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }
  const runtimeText = readFileSync(VENDORED_SOURCE_RUNTIME, 'utf8');

  it('runtime.js carries the // TurboWasm: semantics-compiler-options marker', () => {
    expect(runtimeText).toContain('// TurboWasm: semantics-compiler-options');
  });

  it('runtime.js compilerOptions carries the semantics bag', () => {
    expect(runtimeText).toMatch(/semantics:\s*\{/);
  });

  it('runtime.js semantics bag declares all five flag defaults (= all OFF, Scratch-compatible)', () => {
    // Each flag must default to `false` so existing projects are
    // byte-identical to upstream scratch-vm. The `false` default also
    // matches the documented `DEFAULT_SEMANTIC_OPTIONS` shape.
    expect(runtimeText).toMatch(/strictNumericEquality:\s*false/);
    expect(runtimeText).toMatch(/caseSensitiveStrings:\s*false/);
    expect(runtimeText).toMatch(/propagateNaN:\s*false/);
    expect(runtimeText).toMatch(/truncatedModulo:\s*false/);
    expect(runtimeText).toMatch(/jsTruthyBooleans:\s*false/);
  });
});

describe('Phase 7 — semantics-compiler-options (UMD probe)', () => {
  if (!existsSync(UMD_PATH)) {
    it.skip('UMD missing; run `npm run setup` to enable this probe.', () => {});
    return;
  }
  const umd = readFileSync(UMD_PATH, 'utf8');

  it('UMD contains the // TurboWasm: semantics-compiler-options marker', () => {
    expect(umd).toContain('// TurboWasm: semantics-compiler-options');
  });

  it('UMD declares the semantics bag with all five flag keys', () => {
    // Belt-and-braces: even if the comment marker is stripped by a
    // future toolchain, the runtime option key remains as evidence
    // the patch reached the shipped bundle.
    expect(umd).toContain('strictNumericEquality');
    expect(umd).toContain('caseSensitiveStrings');
    expect(umd).toContain('propagateNaN');
    expect(umd).toContain('truncatedModulo');
    expect(umd).toContain('jsTruthyBooleans');
  });
});
