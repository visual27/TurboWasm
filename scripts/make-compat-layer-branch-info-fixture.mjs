/**
 * Generate `test/.test-fixtures/compat-layer-branch-info-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 4A target: compatibility layer branch info reuse
 * (nested branch / Promise / yield boundaries).
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-compat-layer-branch-info' });
  // Phase 4A will add nested-branch + Promise-returning + yield
  // boundaries so the branch-info reuse patch has something to
  // share. Phase 0 ships the schema-valid shell.
  return project;
}

export async function makeCompatLayerBranchInfoFixture() {
  return writeSb3Fixture('compat-layer-branch-info-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeCompatLayerBranchInfoFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-compat-layer-branch-info-fixture] wrote', p);
  });
}