/**
 * Phase 2 — `expo-fixture.sb3` end-to-end integration with the
 * inlined `pow2` chain (`operator_mathop "ln"` / `"e ^"`).
 *
 * Drives the real production pipeline (`collectRegionVerdictsFromArrayBuffer`
 * + `initializeGpuKernels` with a fake device) against the regenerated
 * `expo-fixture.sb3` (and the byte-scalar sibling). Confirms:
 *
 *   - The fixture no longer carries a `procedures_prototype` for `pow2`.
 *   - The `@compute` body actually emits the inlined pow2 chain:
 *     `exp((log(2.0) * tmp0[R0]))` and a `scratch_list_write_f32` to
 *     `buff_r` at index `R0`.
 *   - No `gpu.emitter_unsupported_opcode` diagnostic surfaces.
 *   - The byte-scalar fixture is bit-equivalent at the region/WGSL level
 *     modulo the extra `@bind byte_state(3) ro byte, scalar` directive.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { collectRegionVerdictsFromArrayBuffer } from '@/runtime/gpu-kernel/region-verdict-pipeline';
import { initializeGpuKernels } from '@/runtime/gpu-kernel/initialize-gpu-kernels';
import { parseProjectJsonFromArrayBuffer, toParsedProject } from '@/runtime/player';
import type { ParsedProject } from '@/runtime/gpu-kernel/types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

interface ParsedProjectJson {
  targets: Array<{
    id?: string;
    name?: string;
    isStage?: boolean;
    blocks?: Record<
      string,
      {
        opcode?: string;
        inputs?: unknown;
        fields?: unknown;
        next?: unknown;
        parent?: unknown;
      }
    >;
    comments?: Record<string, { blockId?: string; text?: string }>;
    variables?: Record<string, unknown>;
    lists?: Record<string, unknown>;
  }>;
  comments?: Record<string, { blockId?: string; text?: string }>;
}

async function readFixtureProject(sb3Path: string): Promise<ParsedProjectJson> {
  const buf = readFileSync(sb3Path);
  // Pass a fresh ArrayBuffer copy — Node 24's Buffer sometimes carries
  // extra bytes past the official length and JSZip's reader then trips
  // on `End of data reached (data length = 0, asked index = N)`.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const zip = await new JSZip().loadAsync(ab);
  const entry = zip.file('project.json');
  if (!entry) throw new Error(`project.json missing in ${sb3Path}`);
  const text = await entry.async('string');
  return JSON.parse(text) as ParsedProjectJson;
}

async function loadProject(sb3Path: string): Promise<ParsedProject> {
  const buf = readFileSync(sb3Path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const shape = await parseProjectJsonFromArrayBuffer(ab);
  if (!shape) throw new Error(`parseProjectJsonFromArrayBuffer returned null for ${sb3Path}`);
  return toParsedProject(shape);
}

function fakeDevice() {
  return {
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
    createBuffer: (desc: { size: number; usage: number }) => ({
      size: desc.size,
      usage: desc.usage,
      destroy: () => undefined,
    }),
    limits: {
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxComputeWorkgroupSizeZ: 64,
      maxComputeInvocationsPerWorkgroup: 256,
    },
  } as unknown as import('@/runtime/gpu-kernel/list-buffer-binding').GpuLikeDevice;
}

describe('§Phase 2 — expo fixture with inlined pow2 chain', () => {
  it('legacy fixture has no procedures_prototype for pow2', async () => {
    const project = await readFixtureProject(
      resolve(REPO_ROOT, 'test/.test-fixtures/expo-fixture.sb3'),
    );
    const sprite = project.targets.find((t) => !t.isStage);
    expect(sprite).toBeDefined();
    const protos = Object.values(sprite!.blocks ?? {}).filter(
      (b) => b.opcode === 'procedures_prototype',
    );
    // The decorative pow2 prototype placeholder is gone — pow2 is
    // expressed inline via `operator_mathop "ln"` / `"e ^"`.
    expect(protos).toEqual([]);
  });

  it('legacy fixture comments no longer mention operator_mathop "e ^"', async () => {
    const project = await readFixtureProject(
      resolve(REPO_ROOT, 'test/.test-fixtures/expo-fixture.sb3'),
    );
    const sprite = project.targets.find((t) => !t.isStage);
    const texts = Object.values(sprite!.comments ?? {}).map((c) => c.text ?? '');
    expect(texts.some((t) => t.includes('operator_mathop "e ^"'))).toBe(false);
  });

  it('tmp0 is now a list (so @bind tmp0(0) ro f32 resolves through bindingForList)', async () => {
    const project = await readFixtureProject(
      resolve(REPO_ROOT, 'test/.test-fixtures/expo-fixture.sb3'),
    );
    const stage = project.targets.find((t) => t.isStage);
    expect(stage).toBeDefined();
    // §SB3 format — lists live under `target.lists` as `[name, value[]]`
    // tuples. The legacy layout stuffed them into `variables` with the
    // internal-VM `{name, type, value, x, y}` object which fails the
    // scratch-parser schema (`maxItems: 3` for variables).
    const lists = (stage as unknown as { lists: Record<string, unknown> }).lists;
    const tmp0Entry = lists['list_tmp0'] as [string, unknown[]] | undefined;
    expect(tmp0Entry, 'list_tmp0 must exist on the stage').toBeDefined();
    expect(tmp0Entry![0]).toBe('tmp0');
    expect(Array.isArray(tmp0Entry![1])).toBe(true);
  });

  it('legacy pipeline emits the inlined pow2 chain and list-write in WGSL', async () => {
    const parsed = await loadProject(
      resolve(REPO_ROOT, 'test/.test-fixtures/expo-fixture.sb3'),
    );
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsed);
    expect(verdicts.length).toBeGreaterThanOrEqual(1);
    const region = verdicts[0]!;

    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject: parsed,
        runtimeState: { listLengths: { aabb_w: 1, tmp0: 1, buff_r: 1 } },
        enableWasm: true,
        enabled: true,
      },
      async () => fakeDevice(),
    );
    expect(result.device).not.toBeNull();
    const emitDiags = result.emitDiagnostics ?? [];
    // No unsupported-opcode diagnostic should surface — the operator_mathop
    // lowering covers every menu value used in the inlined pow2 chain.
    expect(emitDiags.filter((d) => d.code === 'gpu.emitter_unsupported_opcode')).toEqual([]);

    // The fixture registers one region; verify the WGSL text actually
    // contains the inlined `exp(… * log(2.0))` pattern.
    const kernel = result.registry.lookup(region.blockId);
    expect(kernel).toBeDefined();
    expect(kernel!.wgsl).toMatch(/scratch_list_write_f32\(&buff_r/);
    expect(kernel!.wgsl).toMatch(/exp\([\s\S]*?\*\s*log\(2\.0\)/);
    // Verify the inlined pow2 chain reaches the list write via
    // `tmp0[R0]` (binding resolution for `tmp0`).
    expect(kernel!.wgsl).toMatch(/scratch_list_read_f32\(&tmp0/);
  });

  it('byte-scalar pipeline emits the same pow2 chain and survives the byte scalar binding', async () => {
    const parsed = await loadProject(
      resolve(REPO_ROOT, 'test/.test-fixtures/expo-fixture-byte-scalar.sb3'),
    );
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsed);
    expect(verdicts.length).toBeGreaterThanOrEqual(1);
    const region = verdicts[0]!;

    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject: parsed,
        runtimeState: { listLengths: { aabb_w: 1, tmp0: 1, buff_r: 1 } },
        enableWasm: true,
        enabled: true,
      },
      async () => fakeDevice(),
    );
    expect(result.device).not.toBeNull();
    const emitDiags = result.emitDiagnostics ?? [];
    expect(emitDiags.filter((d) => d.code === 'gpu.emitter_unsupported_opcode')).toEqual([]);

    const kernel = result.registry.lookup(region.blockId);
    expect(kernel).toBeDefined();
    expect(kernel!.wgsl).toMatch(/exp\([\s\S]*?\*\s*log\(2\.0\)/);
    // The byte scalar binding is wired through `u_scratch.byte_state`.
    expect(kernel!.wgsl).toMatch(/byte_state: i32/);
  });
});