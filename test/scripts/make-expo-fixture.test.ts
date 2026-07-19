/**
 * Unit tests for `scripts/make-expo-fixture.mjs`.
 *
 * Scope (Phase 4 nested-parallelization-05-phase4 §3.1 + §4.1):
 *   - Legacy `COMPUTE_COMMENT_TEXT` shape is preserved verbatim (the
 *     legacy fixture is the bit-identical regression baseline).
 *   - Nested `NESTED_COMPUTE_COMMENT_TEXT` carries the new DSL
 *     additions: `@bind ..., scalar`, implicit 2D axes (`Ry:global_y`,
 *     `Rx:global_x`), and the `aabb_*` / `screen_w` scalar bindings
 *     that drive Phase 3 Tier 2 uniform injection.
 *   - `makeNestedExpoFixture()` writes a well-formed SB3 file at the
 *     documented path that `scripts/ensure-test-fixtures.mjs`
 *     registers.
 *   - The generated nested fixture's `project.json` is parseable and
 *     contains the expected block structure: three `control_repeat`s,
 *     with the `@compute` candidate as the innermost repeat whose
 *     substack head carries the comment.
 *
 * Mirrors the `test/scripts/gen-bench-sb3.test.ts` pattern (JS module
 * imported via `@ts-expect-error` so the test file stays in lockstep
 * with the script's exports).
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- make-expo-fixture.mjs is JS without a sidecar .d.ts
import * as ExpoFixture from '../../scripts/make-expo-fixture.mjs';

const { makeExpoFixture, makeNestedExpoFixture } = ExpoFixture as unknown as {
  makeExpoFixture: () => Promise<string>;
  makeNestedExpoFixture: () => Promise<string>;
};

import JSZip from 'jszip';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURE_DIR = resolve(REPO_ROOT, 'test/.test-fixtures');

interface ParsedBlock {
  id: string;
  opcode: string;
  parent: string | null;
  next: string | null;
  inputs?: Record<string, unknown>;
}

interface ParsedComment {
  blockId: string;
  text: string;
}

interface ParsedProjectJson {
  targets: Array<{
    name: string;
    isStage: boolean;
    blocks: Record<string, ParsedBlock>;
    comments: Record<string, ParsedComment>;
  }>;
}

async function readProjectJson(sb3Path: string): Promise<ParsedProjectJson> {
  const buf = readFileSync(sb3Path);
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('project.json');
  if (!entry) throw new Error(`project.json missing in ${sb3Path}`);
  const text = await entry.async('string');
  return JSON.parse(text) as ParsedProjectJson;
}

describe('make-expo-fixture.mjs: legacy COMPUTE_COMMENT_TEXT shape', () => {
  it('legacy fixture regenerates to a valid SB3', async () => {
    const out = await makeExpoFixture();
    expect(existsSync(out)).toBe(true);
    const head = readFileSync(out).subarray(0, 2).toString('ascii');
    expect(head).toBe('PK');
  });

  it('legacy fixture project.json carries the @compute marker on the body entry', async () => {
    const out = await makeExpoFixture();
    const project = await readProjectJson(out);
    const sprite = project.targets.find((t) => !t.isStage);
    expect(sprite).toBeDefined();
    const computeComment = Object.values(sprite!.comments).find((c) =>
      c.text.split('\n')[0]?.trim().startsWith('@compute'),
    );
    expect(computeComment, 'no @compute comment found').toBeDefined();
    // §Phase 2 (15.3): the inline `, max=<uint>` suffix is removed
    // alongside the @max directive. The dispatch cap is now derived
    // from the runtime list length.
    expect(computeComment!.text).toContain('@repeat R0:global_x = aabb_w');
    expect(computeComment!.text).not.toContain(', max=');
    expect(computeComment!.text).toContain('@map R0 <- 0');
    // Phase 3 Tier 2 additions must NOT be in the legacy comment
    // (legacy fixture must remain bit-identical with the pre-Phase-4
    // regression baseline).
    expect(computeComment!.text).not.toContain(', scalar');
  });
});

describe('make-expo-fixture.mjs: nested COMPUTE_COMMENT_TEXT shape', () => {
  it('nested fixture regenerates to a valid SB3 at the documented path', async () => {
    const out = await makeNestedExpoFixture();
    expect(out).toBe(resolve(FIXTURE_DIR, 'expo-fixture-nested.sb3'));
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
    const head = readFileSync(out).subarray(0, 2).toString('ascii');
    expect(head).toBe('PK');
  });

  it('nested @compute comment carries scalar uniform bindings and 2D implicit axes', async () => {
    const out = await makeNestedExpoFixture();
    const project = await readProjectJson(out);
    const sprite = project.targets.find((t) => t.name === 'ExpoNested');
    expect(sprite).toBeDefined();
    const computeComment = Object.values(sprite!.comments).find((c) =>
      c.text.split('\n')[0]?.trim().startsWith('@compute'),
    );
    expect(computeComment, 'no @compute comment found in nested fixture').toBeDefined();
    // Phase 3 Tier 2 — scalar uniform bindings.
    expect(computeComment!.text).toContain('@bind aabb_idx0(4) ro i32, scalar');
    expect(computeComment!.text).toContain('@bind aabb_tmp0(10) ro f32, scalar');
    expect(computeComment!.text).toContain('@bind screen_w(8) ro f32, scalar');
    // Phase 2 — implicit 2D axes.
    expect(computeComment!.text).toContain('@repeat Ry:global_y = aabb_h[aabb_idx0]');
    expect(computeComment!.text).toContain('@repeat Rx:global_x = aabb_tmp0');
  });

  it('nested fixture has three nested control_repeats (outer + kernel + candidate)', async () => {
    const out = await makeNestedExpoFixture();
    const project = await readProjectJson(out);
    const sprite = project.targets.find((t) => t.name === 'ExpoNested');
    expect(sprite).toBeDefined();
    const repeats = Object.values(sprite!.blocks).filter((b) => b.opcode === 'control_repeat');
    expect(repeats.length).toBe(3);
    // The three repeats must form a chain via `next` / parent pointers
    // so `region-extractor.findKernelContainer` can walk the parent
    // chain and find a non-candidate ancestor.
    const parents = new Set(repeats.map((r) => r.parent));
    // Two of the three repeats have a non-null parent (the outer
    // scratch loop's parent is the hat).
    const nonNullParents = [...parents].filter((p): p is string => p !== null);
    expect(nonNullParents.length).toBeGreaterThanOrEqual(2);
  });

  it('nested fixture scratch lists + variables are seeded with deterministic sizes', async () => {
    const out = await makeNestedExpoFixture();
    const project = await readProjectJson(out);
    const stage = project.targets.find((t) => t.isStage);
    expect(stage).toBeDefined();
    // scratch-vm encodes lists under `variables` with a `list_` prefix
    // on the key (`list_aabb_len` -> { name: 'aabb_len', type: 'list',
    // value: [...] }). Scalar variables share the same map without the
    // prefix.
    const variables = (stage as unknown as { variables: Record<string, unknown> }).variables;
    // aabb_* lists declared with non-zero `value` arrays in the generator.
    for (const listName of ['aabb_len', 'aabb_w', 'aabb_h', 'aabb_minx', 'aabb_miny']) {
      const key = `list_${listName}`;
      expect(key in variables, `missing list ${listName}`).toBe(true);
      const entry = variables[key] as { name: string; type: string; value: unknown[] };
      expect(entry.name).toBe(listName);
      expect(entry.type).toBe('list');
      expect(Array.isArray(entry.value)).toBe(true);
      expect(entry.value.length).toBeGreaterThan(0);
    }
    // Phase 3 Tier 2 scalar uniforms — declared as plain variables.
    for (const scalarName of ['aabb_idx0', 'aabb_tmp0', 'screen_w']) {
      expect(scalarName in variables, `missing scalar variable ${scalarName}`).toBe(true);
    }
  });
});