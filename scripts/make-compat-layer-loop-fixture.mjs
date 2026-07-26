/**
 * Generate `test/.test-fixtures/compat-layer-loop-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 *
 * §Phase 2-A was permanently skipped at MVP. The proposed hoisting
 * of the per-call `finish(returnValue)` closure out of
 * `executeInCompatibilityLayer` produced a marginal heapDelta
 * improvement (≈12% in compiled mode) but **no wall-clock win**
 * against the legacy shape on this fixture (200-iteration
 * `motion_movesteps` repeat; n=30, warmup=5, frames=600). The
 * fixture stays at the schema-valid shell so a future phase can
 * re-evaluate the optimization with browser-side / `--trace-opt`
 * data. Spec: `phase-02-compat-layer.md` §2A-2 / §2A-7 / §2A-8.
 */
import {
  defaultProjectJson,
  defaultSprite,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-compat-layer-loop' });
  // Phase 1+ will add a long-lived custom-block thread + a repeat
  // loop here so the compatibility-layer closure-reuse patch has
  // something to exercise. Phase 0 only ships the schema-valid shell.
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
