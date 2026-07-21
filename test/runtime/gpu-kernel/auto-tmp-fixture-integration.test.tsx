/**
 * §Phase 6 (gpu-kernel-scratch-temporary-let-binding.md) — fixture
 * load test for `auto-tmp-fixture.sb3`. Drives the SB3 through
 * `collectRegionVerdictsFromArrayBuffer` and asserts that:
 *
 *   - The single `@compute` region adopts with a clean
 *     `autoTmpVerdict` (no cycle / collision).
 *   - The detector surfaces two `AutoTmpBinding`s (`tmp0`, `tmp1`)
 *     in the expected topo order.
 *   - Both bindings are valid WGSL identifiers (no reserved-word
 *     collision on `tmp0` / `tmp1`).
 *   - The two bindings survive D2 (no demote from the
 *     `findVariableWrites` exclusion route).
 *
 * The WGSL emission itself is exercised in `wgsl-emitter.test.ts` /
 * `initialize-gpu-kernels.test.ts`. This test pins the M3 detector's
 * contract against the live fixture so the GPU pipeline smoke run
 * (verify:gpu-kernel / verify:mcp) has a stable regression baseline.
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
const FIXTURE_PATH = resolve(REPO_ROOT, 'test/.test-fixtures/auto-tmp-fixture.sb3');

describe('§Phase 6 — auto-tmp-fixture.sb3', () => {
  it('detects two auto-tmp bindings (tmp0, tmp1) with cross-tmp topo order', async () => {
    const projectJson = await readFixtureProject(FIXTURE_PATH);
    const parsed = toParsedProjectFromJson(projectJson);
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsed);

    // Single `@compute` region adopted.
    expect(verdicts).toHaveLength(1);
    const verdict = verdicts[0]!;

    // Auto-tmp detector ran without demote.
    expect(verdict.autoTmpVerdict.valid).toBe(true);
    expect(verdict.autoTmpVerdict.demoteReason).toBeUndefined();
    expect(verdict.autoTmpVerdict.diagnostics).toEqual([]);

    // Two bindings: `tmp0` (independent, depends on @bind aabb_w only)
    // and `tmp1` (depends on `tmp0`). Topo order must place `tmp0`
    // first so the WGSL `let tmp0` is emitted before `let tmp1`.
    const bindings = verdict.autoTmpVerdict.bindings;
    expect(bindings).toHaveLength(2);
    const names = bindings.map((b) => b.name.toLowerCase());
    expect(names).toEqual(['tmp0', 'tmp1']);

    // Each binding carries a valid WGSL identifier (= either the
    // surface name when WGSL-safe, or the FNV-1a hash form). `tmp0`
    // and `tmp1` are already WGSL-safe so the rename is identity.
    expect(bindings[0]?.emitName).toBe('tmp0');
    expect(bindings[1]?.emitName).toBe('tmp1');

    // The region did not D2-demote — the auto-tmp `tmp0`/`tmp1` writes
    // must be excluded from `findVariableWrites`'s "body writes to Ri"
    // check (= 案 A in the spec). Without the exclusion, the
    // `data_setvariableto(VARIABLE=tmp0)` would be flagged as writing
    // to an unrelated scratch variable, but the loop bound is `R0`
    // (= the @repeat name), and the `tmp0` writes don't shadow `R0`.
    expect(verdict.axes['R0']?.finalAxis).toBe('global_x');
    expect(verdict.axes['R0']?.demoteReason).toBeUndefined();
  });

  it('preserves the block subset pass (auto-tmp writes are not D1-unsafe)', async () => {
    const projectJson = await readFixtureProject(FIXTURE_PATH);
    const parsed = toParsedProjectFromJson(projectJson);
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsed);
    const verdict = verdicts[0]!;
    // `data_setvariableto` is on the D1-safe list (legacy);
    // the auto-tmp detector does NOT change that.
    expect(verdict.blockSubset.valid).toBe(true);
    expect(verdict.blockSubset.demoteReason).toBeUndefined();
  });
});
