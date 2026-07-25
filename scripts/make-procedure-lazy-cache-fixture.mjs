/**
 * Generate `test/.test-fixtures/procedure-lazy-cache-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 2B target: procedure frame lazy cache (recursive / warp / hat).
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-procedure-lazy-cache' });
  // Phase 2B will add a procedures_prototype + a recursive /
  // warpTimer / hat-internal procedure_call chain. Phase 0 ships
  // the schema-valid shell.
  return project;
}

export async function makeProcedureLazyCacheFixture() {
  return writeSb3Fixture('procedure-lazy-cache-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeProcedureLazyCacheFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-procedure-lazy-cache-fixture] wrote', p);
  });
}