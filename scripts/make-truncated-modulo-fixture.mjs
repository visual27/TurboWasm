/**
 * Generate `test/.test-fixtures/truncated-modulo-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 8A target: truncated modulo (dividend/divisor/-0/Infinity 境界).
 */
import {
  defaultProjectJson,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-truncated-modulo' });
  // Phase 8A will exercise the divisor=0, dividend=-0, +/-Infinity
  // edge cases for the modulo operator. Phase 0 ships the
  // schema-valid shell.
  return project;
}

export async function makeTruncatedModuloFixture() {
  return writeSb3Fixture('truncated-modulo-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeTruncatedModuloFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-truncated-modulo-fixture] wrote', p);
  });
}