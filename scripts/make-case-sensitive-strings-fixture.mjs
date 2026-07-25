/**
 * Generate `test/.test-fixtures/case-sensitive-strings-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 8B target: case-sensitive string contains / index-of / equals.
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-case-sensitive-strings' });
  // Phase 8B will exercise the contains / index-of / equals paths
  // across ASCII case boundaries. Phase 0 ships the schema-valid
  // shell.
  return project;
}

export async function makeCaseSensitiveStringsFixture() {
  return writeSb3Fixture('case-sensitive-strings-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeCaseSensitiveStringsFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-case-sensitive-strings-fixture] wrote', p);
  });
}