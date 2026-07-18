import { describe, expect, it } from 'vitest';
import type {
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
describe('types (§Phase 0)', () => {
  describe('RepeatDirective.boundBlockId', () => {
    it('is optional — a directive without it is still well-typed', () => {
      const d: RepeatDirective = {
        kind: 'repeat',
        name: 'R0',
        axis: 'global_x',
        formula: 'N',
        blockId: 'r0',
        line: 0,
        column: 0,
      };
      expect(d.boundBlockId).toBeUndefined();
    });

    it('is accepted when set to a scratch block id', () => {
      const d: RepeatDirective = {
        kind: 'repeat',
        name: 'R0',
        axis: 'global_x',
        formula: 'N',
        blockId: 'r0',
        boundBlockId: 'abc',
        line: 0,
        column: 0,
      };
      expect(d.boundBlockId).toBe('abc');
    });
  });

  describe('MapDirective.boundBlockId', () => {
    it('is optional — a directive without it is still well-typed', () => {
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

    it('is accepted when set to a scratch block id', () => {
      const d: MapDirective = {
        kind: 'map',
        var: 'idx',
        formula: 'R0',
        blockId: 'm0',
        boundBlockId: 'def',
        line: 0,
        column: 0,
      };
      expect(d.boundBlockId).toBe('def');
    });
  });

  describe('ExtractedRegion (§Phase 0 fields)', () => {
    it('requires kernelContainerBlockId, nestedRepeatContainerBlockIds, duplicateComputeBlockIds', () => {
      const region: ExtractedRegion = {
        regionId: 'region:sprite1:r0',
        blockId: 'r0',
        spriteId: 'sprite1',
        commentId: 'cmt1',
        firstSubstackBlockId: 'a',
        bodyBlockIds: ['a'],
        kernelContainerBlockId: 'r0',
        nestedRepeatContainerBlockIds: [],
        duplicateComputeBlockIds: [],
      };
      expect(region.kernelContainerBlockId).toBe('r0');
      expect(region.nestedRepeatContainerBlockIds).toEqual([]);
      expect(region.duplicateComputeBlockIds).toEqual([]);
    });

    it('allows nestedRepeatContainerBlockIds to carry the @compute candidate id', () => {
      const region: ExtractedRegion = {
        regionId: 'region:sprite1:outer',
        blockId: 'outer',
        spriteId: 'sprite1',
        commentId: 'cmt1',
        firstSubstackBlockId: 'inner_a',
        bodyBlockIds: ['inner_a', 'inner_b'],
        kernelContainerBlockId: 'outer',
        nestedRepeatContainerBlockIds: ['inner'],
        duplicateComputeBlockIds: [],
      };
      expect(region.nestedRepeatContainerBlockIds).toEqual(['inner']);
    });

    it('allows duplicateComputeBlockIds to carry surplus @compute block ids', () => {
      const region: ExtractedRegion = {
        regionId: 'region:sprite1:r1',
        blockId: 'r1',
        spriteId: 'sprite1',
        commentId: 'cmt1',
        firstSubstackBlockId: 'a',
        bodyBlockIds: ['a'],
        kernelContainerBlockId: 'r1',
        nestedRepeatContainerBlockIds: [],
        duplicateComputeBlockIds: ['r2', 'r3'],
      };
      expect(region.duplicateComputeBlockIds).toEqual(['r2', 'r3']);
    });
  });

  describe('diagnostic codes (§Phase 0 catalogue)', () => {
    it('exposes the canonical code strings', () => {
      expect(GPU_DIAGNOSTIC_CODES.DSL_SYNTAX_ERROR).toBe('gpu.dsl_syntax_error');
      expect(GPU_DIAGNOSTIC_CODES.BOUND_BLOCK_NOT_FOUND).toBe('gpu.bound_block_not_found');
      expect(GPU_DIAGNOSTIC_CODES.MULTIPLE_COMPUTE_REGIONS).toBe(
        'gpu.multiple_compute_regions',
      );
      expect(GPU_DIAGNOSTIC_CODES.AXIS_AUTO_DETECTED).toBe('gpu.axis_auto_detected');
    });
  });
});