/**
 * Generate `test/.test-fixtures/propagate-nan-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 9C target: NaN propagation through chained operators.
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-propagate-nan' });
  // Phase 9C will exercise chained NaN propagation across the
  // arithmetic operators. Phase 0 ships the schema-valid shell.
  return project;
}

export async function makePropagateNanFixture() {
  return writeSb3Fixture('propagate-nan-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makePropagateNanFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-propagate-nan-fixture] wrote', p);
  });
}