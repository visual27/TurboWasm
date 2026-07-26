/**
 * Generate `test/.test-fixtures/procedure-lazy-cache-fixture.sb3`.
 * Phase 0 — Foundation skeleton.
 * Phase 2B target: procedure frame lazy cache (recursive / warp / hat).
 *
 * §Phase 2-B was permanently skipped at MVP (bench showed NEUTRAL/LOSS
 * verdict on the procedure-call hot path; the JSON-parse cost of
 * `thread.procedures[key]` is amortised by V8 JIT inside the 1%
 * target the spec author considered achievable). Phase 4A precedent
 * applies — the runtime change is reverted from vendored scratch-vm
 * and the patch file, no UI/runtime gate is added, and the fixture
 * stays at the schema-valid shell so Phase 3+ can revisit the
 * optimization with browser-side /w--trace-opt data.
 */
import {
  defaultProjectJson,
  defaultSprite,
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
