/**
 * Generate `test/.test-fixtures/edge-hat-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 1B target: edge-activated hat sentinel elimination.
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-edge-hat' });
  // Phase 1B will add an edge-activated hat block + a steady-state
  // scratch variable so the sentinel-elimination patch can compare
  // old/new behaviour. Phase 0 ships the schema-valid shell.
  return project;
}

export async function makeEdgeHatFixture() {
  return writeSb3Fixture('edge-hat-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeEdgeHatFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-edge-hat-fixture] wrote', p);
  });
}