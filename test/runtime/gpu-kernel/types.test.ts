import { describe, expect, it } from 'vitest';
import type {
  BindDirective,
  ExtractedRegion,
  MapDirective,
  RepeatDirective,
} from '@/runtime/gpu-kernel/types';
import { GPU_DIAGNOSTIC_CODES } from '@/runtime/gpu-kernel/diagnostic-codes';

/**
 * Structural contract tests for the types touched by §Phase 0
 * (nested-parallelization-01-phase0). These do not exercise the parser
 * or extractor — they only pin the shape so a future refactor that
 * accidentally drops a field will surface here first.
 */
describe('types (§Phase 4)', () => {
  describe('RepeatDirective.repeatPath (§Phase 4)', () => {
    it('is required — a directive without it is not well-typed', () => {
      // @ts-expect-error — Phase 4 removed the optional repeatPath;
      // the parser must always populate it.
      const d: RepeatDirective = {
        kind: 'repeat',
        name: 'R0',
        axis: 'global_x',
        formula: 'N',
        blockId: 'r0',
        line: 0,
        column: 0,
      };
      expect(d).toBeDefined();
    });

    it('is required to be a non-empty string when set', () => {
      const d: RepeatDirective = {
        kind: 'repeat',
        name: 'R0',
        axis: 'global_x',
        formula: 'N',
        blockId: 'r0',
        repeatPath: 'self',
        line: 0,
        column: 0,
      };
      expect(d.repeatPath).toBe('self');
    });
  });

  describe('MapDirective (Phase 4 — no user-facing blockId)', () => {
    it('compiles without boundBlockId (parser no longer accepts user value)', () => {
      const d: MapDirective = {
        kind: 'map',
        var: 'idx',
        formula: 'R0',
        blockId: 'm0',
        line: 0,
        column: 0,
      };
      expect(d.boundBlockId).toBeUndefined();
    });
  });

  describe('ExtractedRegion (§Phase 4 fields)', () => {
    it('carries a repeatPathTable alongside the existing kernel-container metadata', () => {
      const region: ExtractedRegion = {
        regionId: 'region:sprite1:r0:0',
        blockId: 'r0',
        spriteId: 'sprite1',
        commentId: 'cmt1',
        firstSubstackBlockId: 'a',
        bodyBlockIds: ['a'],
        kernelContainerBlockId: 'r0',
        repeatPathTable: { self: 'r0', '0': 'a' },
        regionIndex: 0,
        inlinedPrototypeBlockIds: [],
        commentAnchorBlockId: 'r0',
      };
      expect(region.repeatPathTable['self']).toBe('r0');
      expect(region.repeatPathTable['0']).toBe('a');
      expect(region.commentAnchorBlockId).toBe('r0');
    });

    it('§Phase 4 — commentAnchorBlockId === blockId (kernel container) for Form A', () => {
      const region: ExtractedRegion = {
        regionId: 'region:sprite1:r0:0',
        blockId: 'r0',
        spriteId: 'sprite1',
        commentId: 'cmt1',
        firstSubstackBlockId: 'a',
        bodyBlockIds: ['a'],
        kernelContainerBlockId: 'r0',
        repeatPathTable: { self: 'r0' },
        regionIndex: 0,
        inlinedPrototypeBlockIds: [],
        commentAnchorBlockId: 'r0',
      };
      expect(region.commentAnchorBlockId).toBe(region.blockId);
      expect(region.commentAnchorBlockId).toBe(region.kernelContainerBlockId);
    });

    it('§Phase 4 — nestedRepeatContainerBlockIds field is removed from ExtractedRegion', () => {
      // Type-level guarantee that the v9 legacy field no longer exists.
      // `ExtractedRegion extends { nestedRepeatContainerBlockIds: unknown }`
      // must evaluate to `false`. If a future refactor accidentally
      // re-introduces the field, this test fails to compile.
      type _Assert = ExtractedRegion extends { nestedRepeatContainerBlockIds: unknown }
        ? 'FORBIDDEN'
        : 'OK';
      const assert: _Assert = 'OK';
      expect(assert).toBe('OK');
    });

    it('requires Phase 1 fields: regionIndex, inlinedPrototypeBlockIds, commentAnchorBlockId', () => {
      const region: ExtractedRegion = {
        regionId: 'region:sprite1:r0:0',
        blockId: 'r0',
        spriteId: 'sprite1',
        commentId: 'cmt1',
        firstSubstackBlockId: 'a',
        bodyBlockIds: ['a'],
        kernelContainerBlockId: 'r0',
        repeatPathTable: { self: 'b1' },
        regionIndex: 0,
        inlinedPrototypeBlockIds: [],
        commentAnchorBlockId: 'a',
      };
      expect(region.regionIndex).toBe(0);
      expect(region.inlinedPrototypeBlockIds).toEqual([]);
      expect(region.commentAnchorBlockId).toBe('a');
    });
  });

  describe('diagnostic codes (§Phase 0 + §Phase 1 catalogue)', () => {
    it('exposes the canonical code strings', () => {
      expect(GPU_DIAGNOSTIC_CODES.DSL_SYNTAX_ERROR).toBe('gpu.dsl_syntax_error');
      expect(GPU_DIAGNOSTIC_CODES.BOUND_BLOCK_NOT_FOUND).toBe('gpu.bound_block_not_found');
      expect(GPU_DIAGNOSTIC_CODES.MULTIPLE_COMPUTE_REGIONS).toBe(
        'gpu.multiple_compute_regions',
      );
      expect(GPU_DIAGNOSTIC_CODES.AXIS_AUTO_DETECTED).toBe('gpu.axis_auto_detected');
      expect(GPU_DIAGNOSTIC_CODES.KERNEL_CONTAINER_COLLISION).toBe(
        'gpu.kernel_container_collision',
      );
      expect(GPU_DIAGNOSTIC_CODES.BIND_SLOT_COLLISION).toBe('gpu.bind_slot_collision');
      expect(GPU_DIAGNOSTIC_CODES.REGIONAL_BUFFER_MEMORY_PRESSURE).toBe(
        'gpu.regional_buffer_memory_pressure',
      );
      expect(GPU_DIAGNOSTIC_CODES.LEGACY_COMPUTE_COMMENT_POSITION).toBe(
        'gpu.legacy_compute_comment_position',
      );
      expect(GPU_DIAGNOSTIC_CODES.BOUND_BLOCK_REQUIRED).toBe('gpu.bound_block_required');
      expect(GPU_DIAGNOSTIC_CODES.PROCEDURE_RECURSION_UNSUPPORTED).toBe(
        'gpu.procedure_recursion_unsupported',
      );
      expect(GPU_DIAGNOSTIC_CODES.PROCEDURE_PROTOTYPE_NOT_FOUND).toBe(
        'gpu.procedure_prototype_not_found',
      );
    });
  });

  describe('BindDirective.storageKind (§Phase 3, scalar uniform binding)', () => {
    it('is optional — a directive without it is still well-typed', () => {
      const d: BindDirective = {
        kind: 'bind',
        name: 'tmp0',
        slot: 0,
        readOnly: false,
        dtype: 'f32',
        line: 0,
        column: 0,
      };
      expect(d.storageKind).toBeUndefined();
    });

    it("accepts storageKind='list' explicitly", () => {
      const d: BindDirective = {
        kind: 'bind',
        name: 'buff_r',
        slot: 1,
        readOnly: false,
        dtype: 'f32',
        storageKind: 'list',
        line: 0,
        column: 0,
      };
      expect(d.storageKind).toBe('list');
    });

    it("accepts storageKind='scalar' for scratch variable uniform path", () => {
      const d: BindDirective = {
        kind: 'bind',
        name: 'aabb_idx0',
        slot: 4,
        readOnly: true,
        dtype: 'i32',
        storageKind: 'scalar',
        line: 0,
        column: 0,
      };
      expect(d.storageKind).toBe('scalar');
    });
  });
});