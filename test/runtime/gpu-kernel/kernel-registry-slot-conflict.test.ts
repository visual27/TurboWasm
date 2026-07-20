/**
 * §Phase 3 (gpu-kernel-dsl-phase3-spec §3.2) — per-region and
 * cross-region `@bind` slot collision detection wired into
 * `region-verdict-pipeline.ts`.
 *
 * Two paths under test:
 *
 *   1. Same-region slot collision → `gpu.bind_slot_collision`
 *      (severity `error`, in `PARSER_ERROR_CODES`) is pushed into the
 *      region's `parsedDiagnostics` BEFORE
 *      `buildBlockSubsetVerdict` consumes them. The region D1-demotes.
 *
 *   2. Cross-region slot overlap is allowed; the region-verdict
 *      pipeline emits a `console.debug` line under the
 *      `[gpu-kernel] cross-region slot overlap:` prefix. The test
 *      spies on `console.debug` to observe this without polluting the
 *      ErrorLog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectRegionVerdictsFromArrayBuffer } from '@/runtime/gpu-kernel/region-verdict-pipeline';
import type { ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

function mkBlock(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return {
    id,
    opcode,
    next: null,
    parent: null,
    inputs: {},
    fields: {},
    ...opts,
  };
}

function mkProject(
  blocks: RawBlock[],
  comments: { id: string; text: string; blockId: string }[],
): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  const commentsMap: Record<string, { text: string; blockId: string }> = {};
  for (const c of comments) commentsMap[c.id] = c;
  return {
    targets: [{ id: 'sprite1', isStage: false, blocks: blockMap }],
    comments: commentsMap,
  };
}

describe('region-verdict-pipeline: per-region @bind slot uniqueness (§Phase 3 §3.2)', () => {
  it('emits gpu.bind_slot_collision when the same region declares two @bind at slot 0', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      {
        id: 'cmt1',
        // Two @bind at slot 0 in the same region → collision.
        text:
          '@compute\n@bind foo(0) ro f32\n@bind bar(0) rw f32\n@workgroup_size(64)\n@repeat R0:global_x = 4\n@map R0 <- 0\n',
        blockId: 'a',
      },
    ]);
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(project);
    expect(verdicts).toHaveLength(1);
    const slotDiag = verdicts[0]!.diagnostics.find(
      (d) => d.code === 'gpu.bind_slot_collision' && d.severity === 'error',
    );
    expect(slotDiag).toBeDefined();
    expect(slotDiag?.message).toContain('foo');
    expect(slotDiag?.message).toContain('bar');
    expect(slotDiag?.message).toContain('slot 0');
    // The diagnostic lives on the region's diagnostic list — folded
    // through `parsedDiagnostics` into `blockSubset.diagnostics` so
    // the demote path picks it up.
    expect(verdicts[0]!.blockSubset.diagnostics).toContainEqual(slotDiag);
    // The region demotes to D1 via PARSER_ERROR_CODES.
    expect(verdicts[0]!.blockSubset.valid).toBe(false);
    expect(verdicts[0]!.blockSubset.demoteReason).toBe('d1');
  });

  it('allows @bind at distinct slots within the same region', () => {
    const repeat = mkBlock('repeat0', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const project = mkProject([repeat, a], [
      {
        id: 'cmt1',
        text:
          '@compute\n@bind foo(0) ro f32\n@bind bar(1) rw f32\n@bind baz(2) ro f32\n@workgroup_size(64)\n@repeat R0:global_x = 4\n@map R0 <- 0\n',
        blockId: 'a',
      },
    ]);
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(project);
    expect(verdicts).toHaveLength(1);
    const slotDiag = verdicts[0]!.diagnostics.find(
      (d) => d.code === 'gpu.bind_slot_collision',
    );
    expect(slotDiag).toBeUndefined();
    // No PARSER_ERROR_CODES trigger → region stays valid (modulo other
    // demote sources like unsafe opcodes; here the body is clean).
    expect(verdicts[0]!.blockSubset.valid).toBe(true);
  });
});

describe('region-verdict-pipeline: cross-region @bind slot overlap (§Phase 3 §3.2)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it('logs to console.debug when two regions share the same @bind slot', () => {
    const repeatA = mkBlock('repeatA', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const repeatB = mkBlock('repeatB', 'control_repeat', {
      inputs: { SUBSTACK: 'b' },
    });
    const b = mkBlock('b', 'data_setvariableto');
    const project: ParsedProject = {
      targets: [
        { id: 'sprite1', isStage: false, blocks: { repeatA, a, repeatB, b } },
      ],
      comments: {
        cmtA: {
          text:
            '@compute\n@bind tmp0(0) ro f32\n@bind shared(2) rw f32\n@workgroup_size(64)\n@repeat R0:global_x = 4\n@map R0 <- 0\n',
          blockId: 'a',
        },
        cmtB: {
          text:
            '@compute\n@bind tmp1(1) ro f32\n@bind shared(2) ro f32\n@workgroup_size(32)\n@repeat R1:global_x = 4\n@map R1 <- 0\n',
          blockId: 'b',
        },
      },
    };
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(project);
    expect(verdicts).toHaveLength(2);
    // No ErrorLogPanel surface — the diagnostic code does not exist on
    // the per-region diagnostic list.
    for (const v of verdicts) {
      const colliding = v.diagnostics.find(
        (d) => d.code === 'gpu.cross_region_slot_overlap',
      );
      expect(colliding).toBeUndefined();
    }
    // One console.debug line with the expected prefix and slot info.
    const overlapLines = debugSpy.mock.calls.filter((call: unknown[]) => {
      const msg = call[0];
      return typeof msg === 'string' && msg.includes('cross-region slot overlap');
    });
    expect(overlapLines).toHaveLength(1);
    expect(String(overlapLines[0]?.[0])).toContain('slot 2');
    expect(String(overlapLines[0]?.[0])).toContain('shared');
  });

  it('stays silent when the two regions have no overlapping slots', () => {
    const repeatA = mkBlock('repeatA', 'control_repeat', {
      inputs: { SUBSTACK: 'a' },
    });
    const a = mkBlock('a', 'data_setvariableto');
    const repeatB = mkBlock('repeatB', 'control_repeat', {
      inputs: { SUBSTACK: 'b' },
    });
    const b = mkBlock('b', 'data_setvariableto');
    const project: ParsedProject = {
      targets: [
        { id: 'sprite1', isStage: false, blocks: { repeatA, a, repeatB, b } },
      ],
      comments: {
        cmtA: {
          text:
            '@compute\n@bind tmp0(0) ro f32\n@bind onlyA(2) rw f32\n@workgroup_size(64)\n@repeat R0:global_x = 4\n@map R0 <- 0\n',
          blockId: 'a',
        },
        cmtB: {
          text:
            '@compute\n@bind tmp1(1) ro f32\n@bind onlyB(3) ro f32\n@workgroup_size(32)\n@repeat R1:global_x = 4\n@map R1 <- 0\n',
          blockId: 'b',
        },
      },
    };
    collectRegionVerdictsFromArrayBuffer(project);
    const overlapLines = debugSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0] ?? '').includes('cross-region slot overlap'),
    );
    expect(overlapLines).toHaveLength(0);
  });
});