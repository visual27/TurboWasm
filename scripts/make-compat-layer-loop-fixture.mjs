/**
 * Generate `test/.test-fixtures/compat-layer-loop-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 2A target: compatibility-layer closure reuse regression.
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