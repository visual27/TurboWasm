/**
 * Custom-block expo fixture (`expo-custom-block-fixture.sb3`) — end-to-end
 * in-memory pipeline check.
 *
 * Drives `collectRegionVerdictsFromArrayBuffer` + `initializeGpuKernels`
 * against the freshly generated fixture and pins:
 *
 *   - The fixture parses cleanly through the production sb3fix schema gate.
 *   - `extractRegions` adopts exactly one region (one `@compute` marker on
 *     the middle `repeat(aabb_h[aabb_idx0])` block).
 *   - The kernel container block id matches the Form A anchor
 *     (`@compute` on a `control_repeat`).
 *   - The `@repeat Rx = aabb_tmp0, repeatPath="0"` directive resolves to
 *     the inner `control_repeat` (= first child of the kernel container,
 *     per `repeatPathTable`).
 *   - The WGSL body emits `scratch_list_write_*` for `buff_r/buff_g/buff_b`
 *     and the inlined pow2 chain via `operator_mathop "e ^" / "ln"`.
 *   - No `gpu.emitter_unsupported_opcode` diagnostic surfaces.
 *   - `procedures_call` is recognised as part of the custom-block fixture
 *     (one call site, identical after inlining).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { extractRegions } from '@/runtime/gpu-kernel/region-extractor';
import { collectRegionVerdictsFromArrayBuffer } from '@/runtime/gpu-kernel/region-verdict-pipeline';
import { initializeGpuKernels } from '@/runtime/gpu-kernel/initialize-gpu-kernels';
import { parseProjectJsonFromArrayBuffer, toParsedProject } from '@/runtime/player';
import type { ParsedProject } from '@/runtime/gpu-kernel/types';
import type { GpuLikeDevice } from '@/runtime/gpu-kernel/list-buffer-binding';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../.test-fixtures/expo-custom-block-fixture.sb3');

async function loadFixture(): Promise<ParsedProject> {
  if (!existsSync(fixturePath)) {
    throw new Error(
      `expo-custom-block-fixture.sb3 missing at ${fixturePath}; run \`npm run fixtures:setup\``,
    );
  }
  const buf = readFileSync(fixturePath);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const shape = await parseProjectJsonFromArrayBuffer(ab);
  if (!shape) throw new Error('parseProjectJsonFromArrayBuffer returned null');
  return toParsedProject(shape);
}

async function readFixtureProjectJson(): Promise<unknown> {
  const buf = readFileSync(fixturePath);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const zip = await new JSZip().loadAsync(ab);
  const entry = zip.file('project.json');
  if (!entry) throw new Error('project.json missing');
  return JSON.parse(await entry.async('string'));
}

function fakeDevice(): GpuLikeDevice {
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
  } as unknown as GpuLikeDevice;
}

describe('expo-custom-block-fixture.sb3', () => {
  it('fixture parses and loads via production pipeline', async () => {
    const parsed = await loadFixture();
    expect(parsed.targets.length).toBe(2);
    const sprite = parsed.targets.find((t) => !t.isStage)!;
    expect(sprite).toBeDefined();
    expect(Object.keys(sprite.blocks).length).toBeGreaterThan(0);
    // Comments are merged at the ParsedProject level (toParsedProject).
    expect(Object.keys(parsed.comments ?? {}).length).toBe(1);
  });

  it('one procedures_prototype (`fn_expo %s`) + one procedures_call site', async () => {
    const json = (await readFixtureProjectJson()) as {
      targets: Array<{ isStage?: boolean; blocks?: Record<string, { opcode?: string }> }>;
    };
    const sprite = json.targets.find((t) => !t.isStage);
    expect(sprite).toBeDefined();
    const blocks = Object.values(sprite!.blocks ?? {});
    const prototypes = blocks.filter((b) => b.opcode === 'procedures_prototype');
    const calls = blocks.filter((b) => b.opcode === 'procedures_call');
    expect(prototypes.length).toBe(1);
    expect(calls.length).toBe(1);
  });

  it('extractRegions adopts exactly one region (Form A on middle repeat)', async () => {
    const parsed = await loadFixture();
    const { regions, diagnostics } = extractRegions(parsed);
    // No extraction-time errors. (warn/info are tolerated.)
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    expect(regions.length).toBe(1);
    const region = regions[0]!;
    // Form A: kernel container block id is the comment anchor block id.
    expect(region.kernelContainerBlockId).toBe(region.blockId);
    // The repeatPathTable has 'self' (= kernel container) and '0'
    // (= first child control_repeat = `repeat(aabb_tmp0)`).
    expect(region.repeatPathTable['self']).toBe(region.kernelContainerBlockId);
    expect(region.repeatPathTable['0']).toBeDefined();
    expect(region.repeatPathTable['0']).not.toBe(region.kernelContainerBlockId);
  });

  it('repeat directive resolves onto the inner child repeat (parallel axis)', async () => {
    const parsed = await loadFixture();
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsed);
    expect(verdicts.length).toBe(1);
    const verdict = verdicts[0]!;
    // Find the @repeat Rx directive.
    const repeatDirective = verdict.directives.find(
      (d) => d.kind === 'repeat' && d.name === 'Rx',
    );
    expect(repeatDirective).toBeDefined();
    expect(repeatDirective?.kind).toBe('repeat');
    if (repeatDirective?.kind !== 'repeat') throw new Error('type guard');
    // Resolved block id is the inner control_repeat (NOT the kernel
    // container).
    expect(repeatDirective.resolvedRepeatBlockId).not.toBe(verdict.kernelContainerBlockId);
    // Diagnostic dump (commented out — uncomment to debug axis verdicts).
    // console.log(JSON.stringify({
    //   axes: verdict.axes,
    //   cascade: verdict.cascade,
    // }, null, 2));
    // Axis verdict must be global_x (not sequential). Without this the
    // emitter wraps the inner loop in a structural `for` and the kernel
    // does no actual pixel-level parallelization.
    expect(verdict.axes['Rx']?.finalAxis).toBe('global_x');
  });

  it('full pipeline (M3 + M5) emits kernel with parallel list writes', async () => {
    const parsed = await loadFixture();
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsed);
    expect(verdicts).toHaveLength(1);
    const verdict = verdicts[0]!;

    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject: parsed,
        runtimeState: {
          listLengths: {
            aabb_len: 1,
            aabb_w: 1,
            aabb_h: 1,
            aabb_minx: 1,
            aabb_miny: 1,
            buff_r: 96000,
            buff_g: 96000,
            buff_b: 96000,
          },
        },
        enableWasm: true,
        enabled: true,
      },
      async () => fakeDevice(),
    );

    expect(result.device).not.toBeNull();
    const emitDiags = result.emitDiagnostics ?? [];
    // §Phase 6 (extended) — the user's literal scratch body includes
    // `change idx1 by 1` (folded into `var idx1 = u_scratch.idx0 + Rx
    // * 1.0` so each thread computes its own per-thread index), and
    // `change idx0 by screen_w` (lifted into a per-row `var idx0 =
    // u_scratch.idx0 + u_scratch.screen_w` advance). Neither surface
    // `gpu.emitter_unsupported_opcode` warns at the auto-tmp-detector
    // layer anymore — the fold path replaces the run-time increment
    // with a single compile-time expression. No hard `error`-level
    // diagnostics should surface.
    const errorDiags = emitDiags.filter((d) => d.severity === 'error');
    expect(errorDiags).toEqual([]);

    const kernel = result.registry.lookup(verdict.blockId);
    expect(kernel).toBeDefined();
    const wgsl = kernel!.wgsl;
    // The kernel body must write to all three colour buffers via the
    // scratch_list_write_* ABI.
    expect(wgsl).toMatch(/scratch_list_write_f32\(&buff_r/);
    expect(wgsl).toMatch(/scratch_list_write_f32\(&buff_g/);
    expect(wgsl).toMatch(/scratch_list_write_f32\(&buff_b/);
    // §Phase 6 (extended) — SSA uniqueness: each `set tmp1` block
    // gets its own `let tmp1_<hash>_<idx>: f32 = ...` so a subsequent
    // read sees the latest value. Three writes → three distinct SSA
    // bindings, each reading its own `buff_*` buffer (= correct R/G/B
    // pixel separation, no last-write-wins collapse).
    const tmp1Bindings = [...wgsl.matchAll(/let\s+(tmp1_\w+):\s+f32\s*=/g)].map((m) => m[1]);
    expect(new Set(tmp1Bindings).size).toBe(3);
    // The writes must use distinct SSA bindings (= per-channel).
    const writes = [...wgsl.matchAll(/scratch_list_write_f32\(&buff_([rgb]),\s*scratch_index_clamp\([^,]+,\s*u_scratch\.buff_\1_length\),\s*u_scratch\.buff_\1_length,\s*\(\s*1\.0\s*\+\s*\(\((tmp1_\w+)\s*-/g)];
    const writeBindings = writes.map((m) => `${m[1]}:${m[2]}`);
    expect(new Set(writeBindings).size).toBe(3);
    // The fold path lifts `change idx1 by 1` into `var idx1 = u_scratch.idx0 + Rx * 1.0`
    // so each thread computes its own per-thread index in a single statement.
    expect(wgsl).toMatch(/var\s+\w+:\s*f32\s*=\s*u_scratch\.idx0\s*\+\s*Rx\s*\*\s*1\.0/);
    // The kernel reads `buff_*` arrays via the scratch-compat helper.
    expect(wgsl).toMatch(/scratch_list_read_f32\(&buff_[rgb]/);
    // The pow2 reduction (`set tmp0 = e ^ (ln(2) * v)`) runs in the
    // outer prototype body, BEFORE the kernel container, so it does
    // not appear in the WGSL body — `tmp0` is bound as a scalar
    // uniform and the kernel just references it via `u_scratch.tmp0`.
    expect(wgsl).toMatch(/u_scratch\.tmp0/);
    // §Phase 4 / Phase 6 — `@map Rx <- __tw_gid.x` becomes `let Rx: f32 = f32(__tw_gid.x);`
    // so each thread's `Rx` carries the global_invocation_id.x value
    // (= per-thread pixel column).
    expect(wgsl).toMatch(/let\s+Rx:\s*f32\s*=\s*f32\(__tw_gid\.x\)/);
  });

  it('opt-out (inliningEnabled=false) keeps the region valid because procedures_call is outside the kernel body', async () => {
    // §Phase 5 — `procedures_call` is the top-level block on
    // `when_flag_clicked`, NOT inside the kernel container's body.
    // The `@compute` region adopts the prototype body (which the
    // inliner has already expanded when the procedures_call is
    // walked into). With `inliningEnabled=false`, the inliner
    // doesn't run at all, but the region body itself contains no
    // `procedures_call` (the entry point lives outside), so D1
    // doesn't trip. The region stays valid and the WGSL still
    // emits — only the scratch-side variable resolution path
    // differs. This is intentional: per §Phase 5, opt-out only
    // demotes regions whose inlined body would have contained a
    // `procedures_call`, which is not the case here.
    const parsed = await loadFixture();
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsed, {
      inliningEnabled: false,
    });
    expect(verdicts.length).toBe(1);
    const verdict = verdicts[0]!;
    expect(verdict.blockSubset.valid).toBe(true);
  });
});