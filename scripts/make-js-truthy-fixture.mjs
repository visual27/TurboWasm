/**
 * Generate `test/.test-fixtures/js-truthy-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 9B target: JS-truthy booleans ("0" / "false" / empty strings).
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-js-truthy' });
  // Phase 9B will exercise the boolean cast boundary cases.
  // Phase 0 ships the schema-valid shell.
  return project;
}

export async function makeJsTruthyFixture() {
  return writeSb3Fixture('js-truthy-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeJsTruthyFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-js-truthy-fixture] wrote', p);
  });
}