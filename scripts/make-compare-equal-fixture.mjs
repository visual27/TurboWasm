/**
 * Generate `test/.test-fixtures/compare-equal-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 1A target: compareEqual short-circuit (NaN/Infinity/-0/型混在).
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-compare-equal' });
  // Phase 1A will add a script that runs through the cartesian
  // product of VALUES (NaN, -0, Infinity, '', '0', 'true', etc.)
  // via compareEqual and emits results to a list. Phase 0 ships
  // the schema-valid shell.
  return project;
}

export async function makeCompareEqualFixture() {
  return writeSb3Fixture('compare-equal-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeCompareEqualFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-compare-equal-fixture] wrote', p);
  });
}