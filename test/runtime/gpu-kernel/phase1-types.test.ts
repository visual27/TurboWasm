import { describe, expect, it } from 'vitest';
import { GPU_DIAGNOSTIC_CODES } from '@/runtime/gpu-kernel/diagnostic-codes';
import { extractRegions } from '@/runtime/gpu-kernel/region-extractor';
import type { ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

/**
 * §Phase 1 (gpu-kernel-dsl-phase1-spec §1.4) — type and diagnostic
 * catalogue contract tests. Pure: no scratch-vm imports, no fixtures.
 *
 * The two suites here pin:
 *   1. The seven new diagnostic codes registered in `diagnostic-codes.ts`.
 *   2. The three new `ExtractedRegion` fields populated by
 *      `extractRegions` to their Phase 1 default values.
 *
 * Behavioural invariants:
 *   - `regionIndex` is `0` in Phase 1 (extractor emits at most one
 *     region per sprite; the per-sprite 0-based numbering lands in
 *     Phase 3).
 *   - `inlinedPrototypeBlockIds` is always `[]` in Phase 1
 *     (`procedure-inliner` is Phase 5 work).
 *   - `commentAnchorBlockId === firstSubstackBlockId` in Phase 1-3
 *     (legacy form: marker on first substack entry block). Phase 4
 *     switches to loose position and breaks this invariant.
 */

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

function minimalProjectWithCompute(): ParsedProject {
  const body = mkBlock('a', 'data_setvariableto');
  const repeat = mkBlock('repeat0', 'control_repeat', {
    inputs: { SUBSTACK: 'a' },
  });
  return {
    targets: [
      {
        id: 'sprite1',
        isStage: false,
        blocks: { a: body, repeat0: repeat },
      },
    ],
    comments: {
      cmt1: { text: '@compute\n@bind tmp0(0) ro\n', blockId: 'a' },
    },
  };
}

describe('Phase 1: ExtractedRegion type extensions', () => {
  it('diagnostic codes are registered with expected string values', () => {
    expect(GPU_DIAGNOSTIC_CODES.KERNEL_CONTAINER_COLLISION).toBe(
      'gpu.kernel_container_collision',
    );
    expect(GPU_DIAGNOSTIC_CODES.BIND_SLOT_COLLISION).toBe('gpu.bind_slot_collision');
    expect(GPU_DIAGNOSTIC_CODES.REGIONAL_BUFFER_MEMORY_PRESSURE).toBe(
      'gpu.regional_buffer_memory_pressure',
    );
    expect(GPU_DIAGNOSTIC_CODES.PROCEDURE_RECURSION_UNSUPPORTED).toBe(
      'gpu.procedure_recursion_unsupported',
    );
    expect(GPU_DIAGNOSTIC_CODES.PROCEDURE_PROTOTYPE_NOT_FOUND).toBe(
      'gpu.procedure_prototype_not_found',
    );
    expect(GPU_DIAGNOSTIC_CODES.LEGACY_COMPUTE_COMMENT_POSITION).toBe(
      'gpu.legacy_compute_comment_position',
    );
    expect(GPU_DIAGNOSTIC_CODES.BOUND_BLOCK_REQUIRED).toBe('gpu.bound_block_required');
  });

  it('extractRegions returns regions with new fields populated to defaults', () => {
    const { regions } = extractRegions(minimalProjectWithCompute());
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    expect(region.regionIndex).toBe(0);
    expect(region.inlinedPrototypeBlockIds).toEqual([]);
    // Phase 1-3 invariant: commentAnchorBlockId === firstSubstackBlockId.
    // Phase 4 will break this when the comment moves to control_repeat
    // itself; the breaking change updates this assertion.
    expect(region.commentAnchorBlockId).toBe(region.firstSubstackBlockId);
  });
});
