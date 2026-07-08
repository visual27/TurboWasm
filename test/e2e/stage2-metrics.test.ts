/**
 * End-to-end regression test for the Stage 2 (SVG acceleration)
 * metrics targets from the TurboWasm Acceleration spec (§3).
 *
 * Gates behind `RUN_E2E=1` because the harness needs a built
 * `dist/` and a Chromium binary. Run locally with:
 *
 *   npm run build
 *   RUN_E2E=1 npx vitest run test/e2e/stage2-metrics.test.ts
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('Stage 2 SVG acceleration metrics', () => {
  const runE2E = process.env.RUN_E2E === '1';

  it.skipIf(!runE2E)(
    'cache hit rate ≥ 95%, MIP p95 ≤ 3ms, PSNR ≥ 40 dB, SSIM ≥ 0.99',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'node.exe' : 'node',
        ['scripts/verify-stage2-metrics.mjs'],
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
        console.error('[stage2-metrics] harness output:\n', stdout, stderr);
      }
      expect(result.status, 'verify-stage2-metrics.mjs exited non-zero').toBe(0);
      // Spec §3.2 / §3.3: the harness emits one log line per metric.
      expect(
        stdout,
        'verify-stage2-metrics.mjs did not report PSNR ≥ 40 dB / SSIM ≥ 0.99',
      ).toMatch(/PSNR: \d+(\.\d+)?dB/);
      expect(stdout).toMatch(/SSIM: \d+(\.\d+)?/);
    },
  );
});