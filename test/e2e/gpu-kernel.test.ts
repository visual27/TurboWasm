/**
 * End-to-end regression test for the GPU compute kernel browser harness
 * (M7).
 *
 * This test shells out to `scripts/verify-gpu-kernel.mjs` which spins
 * up `vite preview` + Playwright Chromium and:
 *
 *   - Loads `test/.test-fixtures/expo-fixture.sb3` with
 *     `enableWasm: true` (the v8 default), captures the GPU pipeline's
 *     bootstrap log line (`[gpu-kernel] bootstrapped ... device=...`),
 *     and the `kernelRegistry` snapshot.
 *   - Loads the same fixture with `enableWasm: false` and captures the
 *     (empty) registry.
 *   - When WebGPU was observed, compares the canvas pixels from both
 *     passes within 1e-6 absolute tolerance. When WebGPU was *not*
 *     observed (CI without GPU hardware), the harness exits 0 with a
 *     placeholder PNG — we still consider the run green because the
 *     pre-parse pipeline is the load-bearing layer per spec §16.
 *
 * Gated behind `RUN_E2E=1` because the harness needs a built `dist/`
 * and a Chromium binary. The default `npm test` skips it.
 *
 * Run locally with:
 *   npm run build
 *   RUN_E2E=1 npx vitest run test/e2e/gpu-kernel.test.ts
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('GPU kernel browser-verify harness', () => {
  const runE2E = process.env.RUN_E2E === '1';

  it.skipIf(!runE2E)(
    'verify-gpu-kernel.mjs boots vite preview + Playwright Chromium and emits a summary',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'node.exe' : 'node',
        ['scripts/verify-gpu-kernel.mjs'],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 600_000,
        },
      );
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      if (result.status !== 0) {
        // eslint-disable-next-line no-console
        console.error('[gpu-kernel] harness output:\n', stdout, stderr);
      }
      // The harness reports either an OK line (when WebGPU was
      // observed) or a "no WebGPU adapter" skip line (when WebGPU was
      // absent). Either is a green exit per the harness contract.
      expect(result.status, 'verify-gpu-kernel.mjs exited non-zero').toBe(0);
      const sawOkOrSkip =
        stdout.includes('OK: GPU and legacy-only renderings agree') ||
        stdout.includes('no WebGPU adapter');
      expect(
        sawOkOrSkip,
        'verify-gpu-kernel.mjs did not report a clean outcome',
      ).toBe(true);
    },
  );
});
