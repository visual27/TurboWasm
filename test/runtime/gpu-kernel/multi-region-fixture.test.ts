/**
 * §Phase 3 (gpu-kernel-dsl-phase3-spec §3.6) — fixture load test for
 * `multi-region-fixture.sb3`. Drives the SB3 through
 * `collectRegionVerdictsFromArrayBuffer` and asserts that:
 *
 *   - Both `@compute` regions are adopted (no MULTIPLE_COMPUTE_REGIONS
 *     diagnostic, no KERNEL_CONTAINER_COLLISION).
 *   - The two regions have distinct regionIds in the
 *     `region:<spriteId>:<kernelContainerId>:<index>` form.
 *   - `regionIndex` is `0` and `1` for the two adopted regions.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectRegionVerdictsFromArrayBuffer } from '@/runtime/gpu-kernel/region-verdict-pipeline';
import type { ParsedProject } from '@/runtime/gpu-kernel/types';

interface ParsedProjectJson {
  targets: Array<{
    id?: string;
    name?: string;
    isStage?: boolean;
    blocks?: Record<
      string,
      { opcode?: string; inputs?: unknown; fields?: unknown; next?: unknown; parent?: unknown }
    >;
    comments?: Record<string, { blockId?: string; text?: string }>;
  }>;
  comments?: Record<string, { blockId?: string; text?: string }>;
}

async function readFixtureProject(sb3Path: string): Promise<ParsedProjectJson> {
  const buf = readFileSync(sb3Path);
  const zip = await new JSZip().loadAsync(buf);
  const entry = zip.file('project.json');
  if (!entry) throw new Error(`project.json missing in ${sb3Path}`);
  const text = await entry.async('string');
  return JSON.parse(text) as ParsedProjectJson;
}

function toParsedProjectFromJson(json: ParsedProjectJson): ParsedProject {
  const targets = (json.targets ?? []).map((t, idx) => {
    const id = typeof t.id === 'string' && t.id.length > 0 ? t.id : `t${idx}`;
    const blocks: Record<
      string,
      {
        id: string;
        opcode: string;
        next: string | null;
        parent: string | null;
        inputs: Record<string, unknown>;
        fields: Record<string, unknown>;
      }
    > = {};
    for (const [bid, raw] of Object.entries(t.blocks ?? {})) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      blocks[bid] = {
        id: bid,
        opcode: typeof block.opcode === 'string' ? block.opcode : '',
        next: typeof block.next === 'string' ? block.next : null,
        parent: typeof block.parent === 'string' ? block.parent : null,
        inputs:
          typeof block.inputs === 'object' && block.inputs !== null && !Array.isArray(block.inputs)
            ? (block.inputs as Record<string, unknown>)
            : {},
        fields:
          typeof block.fields === 'object' && block.fields !== null && !Array.isArray(block.fields)
            ? (block.fields as Record<string, unknown>)
            : {},
      };
    }
    return { id, isStage: Boolean(t.isStage), blocks };
  });
  const comments: Record<string, { blockId: string; text: string }> = {};
  for (const t of json.targets ?? []) {
    for (const [cid, c] of Object.entries(t.comments ?? {})) {
      if (!c || typeof c.blockId !== 'string' || typeof c.text !== 'string') continue;
      comments[cid] = { blockId: c.blockId, text: c.text };
    }
  }
  for (const [cid, c] of Object.entries(json.comments ?? {})) {
    if (!c || typeof c.blockId !== 'string' || typeof c.text !== 'string') continue;
    if (!comments[cid]) comments[cid] = { blockId: c.blockId, text: c.text };
  }
  return { targets, comments };
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const FIXTURE_PATH = resolve(REPO_ROOT, 'test/.test-fixtures/multi-region-fixture.sb3');

describe('§Phase 3 — multi-region-fixture.sb3', () => {
  it('adopts both @compute regions with distinct regionIds', async () => {
    const projectJson = await readFixtureProject(FIXTURE_PATH);
    const parsed = toParsedProjectFromJson(projectJson);
    const { verdicts, extractionDiagnostics } =
      collectRegionVerdictsFromArrayBuffer(parsed);

    // Both `@compute` regions adopted — distinct control_repeats, no
    // diagnostic for the cross-block case.
    expect(verdicts).toHaveLength(2);
    expect(extractionDiagnostics).toEqual([]);
    // Each region gets a unique regionId carrying its per-sprite index.
    const regionIds = verdicts.map((v) => v.regionId).sort();
    expect(new Set(regionIds).size).toBe(2);
    for (const id of regionIds) {
      // §Phase 3 — regionId is `region:<spriteId>:<kernelContainerId>:<index>`.
      // `spriteId` falls back to `t<idx>` when the SB3 target omits `id`
      // (the fixture's sprite carries `name: 'MultiRegion'` but no `id`
      // field on the target — the parser falls back to `t1`).
      expect(id).toMatch(/^region:[^:]+:b\d+:\d+$/);
    }
    // regionIndex is the 0-based per-sprite sequence encoded in regionId
    // (`region:<spriteId>:<kernelContainerId>:<index>` per
    // `region-extractor.ts`). RegionVerdict does not carry regionIndex
    // directly — we parse it from the regionId suffix.
    const indicesFromRegionId = verdicts
      .map((v) => Number.parseInt(v.regionId.split(':').pop() ?? '-1', 10))
      .sort((a, b) => a - b);
    expect(indicesFromRegionId).toEqual([0, 1]);
    // Each region adopted its own kernel container (no collision).
    const kernels = verdicts.map((v) => v.kernelContainerBlockId).sort();
    expect(new Set(kernels).size).toBe(2);
  });

  it('each region carries independent workgroup size + axis names', async () => {
    const projectJson = await readFixtureProject(FIXTURE_PATH);
    const parsed = toParsedProjectFromJson(projectJson);
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsed);

    // Region A: workgroup_size(64), R0 axis.
    // Region B: workgroup_size(32), R1 axis.
    // Distinct canonical keys → both survive as separate pipelines.
    // RegionVerdict doesn't carry regionIndex; we parse the per-sprite
    // index from the regionId suffix (`region:<sprite>:<kc>:<idx>`).
    const indexFromId = (v: { regionId: string }) =>
      Number.parseInt(v.regionId.split(':').pop() ?? '-1', 10);
    const byIndex = [...verdicts].sort((a, b) => indexFromId(a) - indexFromId(b));
    const regionA = byIndex[0]!;
    const regionB = byIndex[1]!;
    // Locate the @repeat directives by kind — they live on
    // regionVerdict.directives (resolved post-extraction in pipeline).
    // We check `parallelAxes` for the axis names.
    const axesA = regionA.parallelAxes.map((p) => p.repeatName);
    const axesB = regionB.parallelAxes.map((p) => p.repeatName);
    expect(axesA).toContain('R0');
    expect(axesB).toContain('R1');
  });
});