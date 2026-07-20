/**
 * Integration test — diagnostics fixture → player bootstrap →
 * ErrorLogPanel rendering.
 *
 * §Phase 5 §15.9 / §15.14 — pins the end-to-end flow from the
 * diagnostics SB3 fixture through `bootstrapGpuKernels` to the
 * `ErrorLogPanel` UI:
 *
 *   1. The fixture's duplicate `@compute` marker surfaces as
 *      `gpu.multiple_compute_regions` (severity `error`).
 *   2. The shared `forwardGpuDiagnostics` helper routes the error
 *      into the `useErrorLogStore` store WITHOUT capping.
 *   3. The `ErrorLogPanel` renders the entry when expanded.
 *
 * We exercise the player pipeline directly (without booting the real
 * Scaffolding) by driving the public bootstrap helpers from the
 * exported `__bindEventsForTesting` + `__exposeForBrowserVerify` test
 * seams — see `gpu-kernel-player-wiring.test.ts` for the full
 * in-memory SB3 builder pattern.
 */
import JSZip from 'jszip';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorLogPanel } from '@/features/error-log/ErrorLogPanel';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { collectRegionVerdictsFromArrayBuffer } from '@/runtime/gpu-kernel/region-verdict-pipeline';
import { forwardGpuDiagnostics } from '@/runtime/gpu-kernel/diagnostic-forwarding';
import {
  initializeGpuKernels,
  __resetAdapterUnavailableWarningForTesting,
} from '@/runtime/gpu-kernel/initialize-gpu-kernels';
import type { ParsedProject } from '@/runtime/gpu-kernel/types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  'test/.test-fixtures/gpu-kernel-diagnostics-fixture.sb3',
);

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
  __resetAdapterUnavailableWarningForTesting();
});

describe('§Phase 5 §15.9 / §15.14 — diagnostics fixture → ErrorLogPanel', () => {
  it('surfaces gpu.multiple_compute_regions (error) in the ErrorLogPanel when expanded', async () => {
    const projectJson = await readFixtureProject(FIXTURE_PATH);
    const parsed = toParsedProjectFromJson(projectJson);

    // Drive the same pipeline `bootstrapGpuKernels` runs.
    const { verdicts, extractionDiagnostics } =
      collectRegionVerdictsFromArrayBuffer(parsed);

    // §15.9 — extraction diagnostics surface even when the pipeline
    // registers regions (the duplicate diagnostic folds into the
    // surviving region's verdict.diagnostics).
    forwardGpuDiagnostics(extractionDiagnostics);
    forwardGpuDiagnostics(verdicts.flatMap((v) => v.diagnostics));

    const dupError = useErrorLogStore
      .getState()
      .entries.find(
        (e) =>
          e.severity === 'error' &&
          e.message.includes('gpu.multiple_compute_regions'),
      );
    expect(dupError, 'gpu.multiple_compute_regions should be in the store').toBeDefined();

    // The panel renders only the error entry when expanded.
    render(<ErrorLogPanel />);
    expect(screen.getByText(/^1 error$/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Expand errors/i));
    expect(
      screen.getByText(/gpu\.multiple_compute_regions/),
    ).toBeInTheDocument();
  });

  it('keeps emitter warnings in the store but does not display them in ErrorLogPanel', async () => {
    // §15.14 — the diagnostics fixture declares `@bind let(0) ro f32`,
    // which collides with a WGSL reserved keyword. The emitter renames
    // it and emits `gpu.identifier_collision` (warn). jsdom has no
    // WebGPU device, so the bootstrap's emitter path is bypassed; we
    // call the pipeline functions directly to isolate the warn
    // collection.
    const projectJson = await readFixtureProject(FIXTURE_PATH);
    const parsed = toParsedProjectFromJson(projectJson);
    const { verdicts, extractionDiagnostics } =
      collectRegionVerdictsFromArrayBuffer(parsed);
    expect(verdicts.length).toBeGreaterThan(0);

    // Initialize with a fake device so the emitter actually runs.
    const fakeDevice = {
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
      },
      createBuffer: (desc: { size: number; usage: number }) => ({
        size: desc.size,
        usage: desc.usage,
        destroy: () => undefined,
      }),
    };
    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject: parsed,
        runtimeState: { listLengths: { aabb_w: 1, buff_r: 1 } },
        enableWasm: true,
        enabled: true,
      },
      async () => fakeDevice,
    );
    expect(result.device).not.toBeNull();

    // The collision warning must be collected by the initialize pass.
    const emitDiags = result.emitDiagnostics ?? [];
    expect(
      emitDiags.some((d) => d.code === 'gpu.identifier_collision'),
      'gpu.identifier_collision should be in emitDiagnostics',
    ).toBe(true);

    forwardGpuDiagnostics(emitDiags);
    const storedWarn = useErrorLogStore
      .getState()
      .entries.find(
        (e) =>
          e.severity === 'warn' && e.message.includes('gpu.identifier_collision'),
      );
    expect(storedWarn, 'warn should be in the store even when the panel hides it').toBeDefined();

    // Render the panel — only error-severity entries are visible.
    // The duplicate-`@compute` error from §15.9 should dominate the
    // count, not the warn. Forward the verdict diagnostics AND the
    // extraction diagnostics so the store carries the folded
    // `gpu.multiple_compute_regions` error alongside the warn — the
    // first test already proved the duplicate-error folds in, but
    // here we want to assert that the panel's "errors only" filter
    // suppresses the warn regardless of co-resident severities.
    forwardGpuDiagnostics(extractionDiagnostics);
    forwardGpuDiagnostics(verdicts.flatMap((v) => v.diagnostics));
    render(<ErrorLogPanel />);
    expect(screen.getByText(/^\d+ error/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Expand errors/i));
    expect(screen.queryByText(/gpu\.identifier_collision/)).toBeNull();
  });
});
