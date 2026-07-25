import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Phase 0 — Foundation skeleton. The Phase 0 deliverable for P0-1-A
 * is the bridge file's existence + the Phase 1+ roadmap that drives
 * what content lives inside it. Phase 1+ will replace this file with
 * the actual `expect().toBe(...)` assertions derived from the
 * vendored scratch-vm tap tests, using a `vmFactory` helper that
 * builds a vendored VM with `setCompatibilityMode(false)` and
 * `setTurboMode(false)` pinned.
 *
 * Real files that will eventually populate this bridge:
 *
 *   - vendored/scratch-vm/test/unit/tw_jsexecute.js
 *     (compareEqual / compareGreaterThan / compareLessThan)
 *   - vendored/scratch-vm/test/integration/tw-block-stop-thread.js
 *   - vendored/scratch-vm/test/integration/tw-hats-and-events.js
 *     (_edgeActivatedHatValues section — the historical
 *     `hat-threads-run-every-frame.js` was renamed upstream)
 *   - vendored/scratch-vm/test/integration/tw-last-block-in-loop-returns-promise.js
 *     (filename varies — confirm against vendored tree)
 *
 * Files mentioned in the Phase 0 spec that no longer exist
 * upstream are skipped: `tw_stop_this_script.js` and the original
 * `hat-threads-run-every-frame.js`.
 */
describe('scratch-vm tap bridge (Phase 0 skeleton)', () => {
  it('placeholder: see src/runtime/scratch-vm/ for the actual bridge implementations', () => {
    // The P0-7 deliverable requires this file to be present and
    // green even when empty. The actual tap-to-vitest rewrites
    // land in Phase 1+ as their respective scratch-vm patches
    // mature.
    expect(true).toBe(true);
  });

  it('notes that vendored scratch-vm is on disk so Phase 1+ can import it', () => {
    // The vendored tree is gitignored; a fresh clone has no
    // vendored/scratch-vm/. We don't fail in that case — the
    // existence check is informational so the bridge test can run
    // before `npm run setup` completes.
    const vendoredVmPkg = resolve(
      process.cwd(),
      'vendored/scratch-vm/package.json',
    );
    if (!existsSync(vendoredVmPkg)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[scratch-vm-tap-bridge] vendored scratch-vm missing; Phase 1+ tests will skip.',
      );
      return;
    }
    expect(existsSync(vendoredVmPkg)).toBe(true);
  });
});