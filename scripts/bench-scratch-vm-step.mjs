/**
 * Phase 0 — Foundation skeleton for the scratch-vm step bench.
 *
 * Phase 0 ships the `--dry` mode only. Real Playwright bench runs
 * land in Phase 1+ once the underlying scratch-vm optimization
 * patches are stable enough to measure.
 *
 * Usage:
 *   node scripts/bench-scratch-vm-step.mjs --dry
 *   node scripts/bench-scratch-vm-step.mjs <fixture-name>
 *   BENCH_N=20 node scripts/bench-scratch-vm-step.mjs repro.sb3
 *
 * `--dry` skips Playwright entirely: it logs the resolved fixture
 * name and the planned `N` (default 10, override via `BENCH_N` env
 * var), then exits 0. This is the only path the P0-7 deliverable
 * requires to be green.
 *
 * The non-dry path mirrors `scripts/verify-turbowarp-equivalent.mjs`
 * for the structural template (vite preview, Playwright Chromium,
 * N loads) but targets scratch-vm step timing rather than
 * TurboWarp-equivalent Canvas pixel diffs. Phase 1+ adds the real
 * `[gpu-kernel] bootstrapped` / `window.__turbowasm.kernelRegistry.size`
 * measurements and the trace capture.
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const FIXTURE_DIR = resolve(process.cwd(), 'test/.test-fixtures');

function resolveFixture(name) {
  if (!name.endsWith('.sb3')) {
    return resolve(FIXTURE_DIR, `${name}.sb3`);
  }
  return resolve(FIXTURE_DIR, name);
}

async function main() {
  const { values } = parseArgs({
    options: {
      dry: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.dry) {
    // eslint-disable-next-line no-console
    console.log('[bench-scratch-vm-step --dry] BENCH_N =', process.env.BENCH_N ?? 10);
    // eslint-disable-next-line no-console
    console.log(
      '[bench-scratch-vm-step --dry] skipping Playwright; Phase 0 ships the dry path only.',
    );
    return;
  }

  // Phase 1+ will implement the real bench here. Reject the call
  // explicitly so a user who runs without --dry does not silently
  // get a green exit code with no measurements.
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const fixtureName = positional[0] ?? 'repro.sb3';
  const fixturePath = resolveFixture(fixtureName);
  // eslint-disable-next-line no-console
  console.error(
    `[bench-scratch-vm-step] real bench not implemented yet (Phase 1+). ` +
      'Re-run with `--dry` for the Phase 0 placeholder. Requested fixture: ' +
      fixturePath,
  );
  process.exit(1);
}

await main();