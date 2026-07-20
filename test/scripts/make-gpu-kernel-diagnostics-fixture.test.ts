/**
 * Unit tests for `scripts/make-gpu-kernel-diagnostics-fixture.mjs`.
 *
 * §Phase 5 §15.9 / §15.14 — the fixture exists so the
 * ErrorLogPanel-integration test in
 * `test/runtime/gpu-kernel/diagnostics-fixture-integration.test.tsx`
 * has a real SB3 to drive `bootstrapGpuKernels` against. The fixture
 * must:
 *
 *   - Parse as a valid ZIP / project.json (smoke).
 *   - Carry a sprite with TWO `control_repeat` blocks whose first
 *     substack blocks each carry `@compute` comments — this is what
 *     trips the extractor's `gpu.multiple_compute_regions` diagnostic.
 *   - Use a `@bind let(0) ro f32` directive in one of the comments so
 *     the WGSL emitter emits `gpu.identifier_collision` (warn). Without
 *     that, the §15.14 forward path is never exercised.
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- make-gpu-kernel-diagnostics-fixture.mjs is JS without a sidecar .d.ts
import * as DiagFixture from '../../scripts/make-gpu-kernel-diagnostics-fixture.mjs';

const { makeGpuKernelDiagnosticsFixture } = DiagFixture as unknown as {
  makeGpuKernelDiagnosticsFixture: () => Promise<string>;
};

import JSZip from 'jszip';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURE_DIR = resolve(REPO_ROOT, 'test/.test-fixtures');
const FIXTURE_PATH = resolve(FIXTURE_DIR, 'gpu-kernel-diagnostics-fixture.sb3');

interface ParsedProjectJson {
  targets: Array<{
    id?: string;
    name?: string;
    isStage?: boolean;
    blocks?: Record<string, { opcode?: string; inputs?: unknown; fields?: unknown }>;
    comments?: Record<string, { blockId?: string; text?: string }>;
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

describe('make-gpu-kernel-diagnostics-fixture.mjs', () => {
  it('writes a valid SB3 at the documented path', async () => {
    const out = await makeGpuKernelDiagnosticsFixture();
    expect(out).toBe(FIXTURE_PATH);
    expect(existsSync(out)).toBe(true);
    const head = readFileSync(out).subarray(0, 2).toString('ascii');
    expect(head).toBe('PK');
  });

  it('fixture sprite carries two @compute markers (triggers gpu.multiple_compute_regions)', async () => {
    const project = await readProjectJson(FIXTURE_PATH);
    const sprite = project.targets.find((t) => !t.isStage);
    expect(sprite).toBeDefined();
    const computeComments = Object.values(sprite!.comments ?? {}).filter((c) =>
      (c.text ?? '').trimStart().startsWith('@compute'),
    );
    expect(
      computeComments.length,
      'expected the fixture to expose two @compute comments',
    ).toBeGreaterThanOrEqual(2);
  });

  it('fixture @compute comment declares a reserved-keyword @bind (triggers gpu.identifier_collision)', async () => {
    const project = await readProjectJson(FIXTURE_PATH);
    const sprite = project.targets.find((t) => !t.isStage);
    expect(sprite).toBeDefined();
    const collisionText = Object.values(sprite!.comments ?? {})
      .map((c) => c.text ?? '')
      .find((text) => text.includes('@bind let('));
    expect(
      collisionText,
      'fixture must include `@bind let(0)` somewhere to exercise emitter warns',
    ).toBeDefined();
  });

  it('fixture has two control_repeat blocks under the same hat', async () => {
    const project = await readProjectJson(FIXTURE_PATH);
    const sprite = project.targets.find((t) => !t.isStage);
    expect(sprite).toBeDefined();
    const repeats = Object.values(sprite!.blocks ?? {}).filter(
      (b) => b.opcode === 'control_repeat',
    );
    expect(repeats.length).toBeGreaterThanOrEqual(2);
  });
});
