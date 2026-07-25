/**
 * Generate `test/.test-fixtures/strict-equality-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 9A target: strict numeric equality (numeric string + number).
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-strict-equality' });
  // Phase 9A will exercise the `=` operator with numeric-string
  // operands on either side. Phase 0 ships the schema-valid shell.
  return project;
}

export async function makeStrictEqualityFixture() {
  return writeSb3Fixture('strict-equality-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeStrictEqualityFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-strict-equality-fixture] wrote', p);
  });
}