/**
 * End-to-end regression test for the Stage 1 (Phase 4 removal) invariant:
 * sprite rendering output must be bit-identical between the default
 * PerformanceMode and `legacy-only`.
 *
 * This test shells out to `scripts/verify-turbowarp-equivalent.mjs`
 * which spins up `vite preview` + Playwright Chromium and compares
 * ImageData captures from both modes. It is gated behind `RUN_E2E=1`
 * because the harness needs a built `dist/` and a Chromium binary.
 *
 * Run locally with:
 *   npm run build
 *   RUN_E2E=1 npx vitest run test/e2e/turbowarp-equivalent.test.ts
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('TurboWarp-equivalent sprite rendering', () => {
  const runE2E = process.env.RUN_E2E === '1';

  it.skipIf(!runE2E)(
    'default PerformanceMode and legacy-only produce bit-identical sprite output',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'node.exe' : 'node',
        ['scripts/verify-turbowarp-equivalent.mjs'],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      if (result.status !== 0) {
        // eslint-disable-next-line no-console
        console.error('[turbowarp-equivalent] harness output:\n', stdout, stderr);
      }
      expect(result.status, 'verify-turbowarp-equivalent.mjs exited non-zero').toBe(0);
      expect(
        stdout.includes('OK: default and legacy-only rendered bit-identically.'),
        'verify-turbowarp-equivalent.mjs did not report bit-identity',
      ).toBe(true);
    },
  );
});