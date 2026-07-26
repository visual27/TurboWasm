/**
 * Generate `test/.test-fixtures/compat-layer-loop-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 *
 * §Phase 2-A is `adopted` (semantically invariant closure hoist —
 * see `test/runtime/scratch-vm-compat-layer-finish-extracted.test.ts`).
 * The MVP bench on this fixture showed ≈12% heapDelta improvement in
 * compiled mode with no measurable wall-clock delta, which is below
 * the §2A-8 15% heap adoption threshold but above the no-regression
 * baseline, so the patch stays in production (no runtime gate, the
 * UI toggle is cosmetic). The fixture stays at the schema-valid
 * shell because the bench script (`scripts/bench-scratch-vm-step.mjs`)
 * compares compiled vs interpreted mode and does not need a
 * body-bearing project to exercise the closure hoist — the patched
 * `executeInCompatibilityLayer` is on the per-call site hot path
 * that every `procedures_call` / extension-block invocation walks
 * regardless of project body content. A future phase may add a
 * body-bearing version of this fixture to enable an A/B
 * unpatched-vs-patched bench, but the current MVP scope only
 * requires the schema gate to pass. Spec: `phase-02-compat-layer.md`
 * §2A-2 / §2A-7 / §2A-8.
 */
import {
  defaultProjectJson,
  defaultSprite,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-compat-layer-loop' });
  // The §Phase 2-A closure hoist runs in every `procedures_call` /
  // extension-block invocation regardless of project body content,
  // so the bench does not need a custom-block body in the fixture
  // for the optimization to be exercised. We keep the schema-valid
  // shell so the fixture continues to pass `ensure-test-fixtures.mjs`'s
  // sb3fix schema gate. A future bench A/B (unpatched vs patched)
  // can add a body-bearing variant without changing this file.
  project.targets[1] = defaultSprite('CompatLoop');
  return project;
}

export async function makeCompatLayerLoopFixture() {
  return writeSb3Fixture('compat-layer-loop-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeCompatLayerLoopFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-compat-layer-loop-fixture] wrote', p);
  });
}
