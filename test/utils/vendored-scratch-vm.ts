import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Phase 1 — Common helper to require the vendored scratch-vm from the
 * root Vitest suite. The vendored copy lives at
 * `vendored/scaffolding/node_modules/scratch-vm` (mirrored by
 * `scripts/setup-vendored.mjs`) so both CommonJS `require` and the
 * Vitest ESM setup find it through the same path.
 *
 * Returns `null` when the vendored scratch-vm has not been set up
 * (= fresh clone without `npm run setup`); callers should `it.skip`
 * in that case rather than fail. The bridge test file uses this helper
 * so the entire suite remains green on a fresh clone.
 */
const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);

export interface VendoredScratchVm {
  jsexecute: {
    runtimeFunctions: Readonly<Record<string, string>>;
    scopedEval(name: string): unknown;
  };
  cast: {
    compare(v1: unknown, v2: unknown): number;
    toNumber(v: unknown): number;
    toBoolean(v: unknown): boolean;
    toString(v: unknown): string;
  };
}

export function loadVendoredScratchVm(): VendoredScratchVm | null {
  if (!existsSync(VENDORED_VM_DIR)) return null;
  // `require` works from a Vitest ESM file as long as the path is
  // resolvable. The vendored scratch-vm is CommonJS so we keep the
  // dynamic import off the hot path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jsexecute = require(resolve(VENDORED_VM_DIR, 'src/compiler/jsexecute.js'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cast = require(resolve(VENDORED_VM_DIR, 'src/util/cast.js'));
  return { jsexecute, cast };
}

/**
 * The shared `VALUES` matrix from `vendored/scratch-vm/test/unit/tw_jsexecute.js`
 * — every input combination the upstream test sweeps `compareEqual`,
 * `compareGreaterThan`, and `compareLessThan` over. Re-exposed so the
 * Phase 1-A vitest port can reuse it without copying 30+ literal cases.
 */
export const COMPARE_VALUES: readonly unknown[] = [
  0,
  -0,
  1,
  '0',
  '',
  '.',
  true,
  false,
  'true',
  'false',
  'true ',
  'apple',
  'Apple',
  'Apple ',
  ' 123',
  ' 123.0',
  '+123.5',
  123,
  0.23,
  '0.23',
  '.23',
  '-.23',
  '0.0',
  NaN,
  'NaN',
  Infinity,
  -Infinity,
  'Infinity',
  '-Infinity',
  '\t',
  '\r\n\u00a0',
];