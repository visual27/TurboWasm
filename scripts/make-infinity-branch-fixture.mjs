/**
 * Generate `test/.test-fixtures/infinity-branch-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 1C target: Infinity branch removal (signed consistency).
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-infinity-branch' });
  // Phase 1C will exercise the +/-Infinity edge cases for
  // compareGreaterThan / compareLessThan. Phase 0 ships the
  // schema-valid shell.
  return project;
}

export async function makeInfinityBranchFixture() {
  return writeSb3Fixture('infinity-branch-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeInfinityBranchFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-infinity-branch-fixture] wrote', p);
  });
}