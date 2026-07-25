/**
 * Generate `test/.test-fixtures/constant-folding-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 3 target: compiler constant folding (boolean / arithmetic / string).
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-constant-folding' });
  // Phase 3 will add a script whose inputs are all compile-time
  // literals so the constant-folding pass can be exercised.
  // Phase 0 ships the schema-valid shell.
  return project;
}

export async function makeConstantFoldingFixture() {
  return writeSb3Fixture('constant-folding-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeConstantFoldingFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-constant-folding-fixture] wrote', p);
  });
}