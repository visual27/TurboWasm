import { describe, expect, it } from 'vitest';
import { analyzeCascade } from '@/runtime/gpu-kernel/cascade-analysis';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import type { ExtractedRegion, ParsedProject } from '@/runtime/gpu-kernel/types';

function parse(text: string) {
  return parseComputeComment({ blockId: 'a', text }, 'r0');
}

function skeletonRegion(): ExtractedRegion {
  return {
    regionId: 'r0',
    blockId: 'r0',
    spriteId: 's1',
    commentId: 'c1',
    firstSubstackBlockId: 'a',
    bodyBlockIds: ['a'],
    kernelContainerBlockId: 'r0',
    nestedRepeatContainerBlockIds: [],
    duplicateComputeBlockIds: [],
    regionIndex: 0,
    inlinedPrototypeBlockIds: [],
    commentAnchorBlockId: 'a',
  };
}

function project(): ParsedProject {
  return {
    targets: [
      {
        id: 's1',
        isStage: false,
        blocks: {
          a: { id: 'a', opcode: 'data_setvariableto', next: null, parent: null, inputs: {}, fields: {} },
        },
      },
    ],
    comments: {},
  };
}

describe('cascade-analysis (D3)', () => {
  it('accepts a clean DAG with no @map cycles', () => {
    const directives = parse('@repeat R0:global_x = N\n@map R0 <- 0\n@map a <- 1 + R0\n').directives;
    const out = analyzeCascade({
      region: skeletonRegion(),
      directives,
      project: project(),
      survivedAxes: new Set(['R0']),
    });
    expect(out.valid).toBe(true);
    expect(out.topoOrder).toEqual(['R0', 'a']);
  });

  it('demotes (D3) when @repeat has no matching @map', () => {
    const directives = parse('@repeat R0:global_x = N\n').directives;
    const out = analyzeCascade({
      region: skeletonRegion(),
      directives,
      project: project(),
      survivedAxes: new Set(['R0']),
    });
    expect(out.valid).toBe(false);
    expect(out.demoteReason).toBe('d3');
  });

  it('demotes (D3) when @map declarations form a cycle', () => {
    const directives = parse('@map a <- b + 1\n@map b <- a + 1\n').directives;
    const out = analyzeCascade({
      region: skeletonRegion(),
      directives,
      project: project(),
      survivedAxes: new Set(),
    });
    expect(out.valid).toBe(false);
    expect(out.demoteReason).toBe('d3');
  });

  it('warns (not demotes) on identifier collision; emitter renames in M4', () => {
    const directives = parse('@map compute <- 0\n').directives;
    const out = analyzeCascade({
      region: skeletonRegion(),
      directives,
      project: project(),
      survivedAxes: new Set(),
    });
    expect(out.valid).toBe(true);
    expect(out.diagnostics.some((d) => d.code === 'gpu.identifier_collision')).toBe(true);
  });

  describe('quoted names (§Phase 3 §15.11)', () => {
    it('treats a quoted reference as a single surface-name token in DAG', () => {
      // `@map "my axis" <- 0` references the quoted axis name; the DAG
      // should see `my axis` as a token (after escape stripping), not
      // `my` and `axis` separately.
      const directives = parse(
        '@repeat "my axis":global_x = N\n@map "my axis" <- 0\n',
      ).directives;
      const out = analyzeCascade({
        region: skeletonRegion(),
        directives,
        project: project(),
        survivedAxes: new Set(['my axis']),
      });
      expect(out.valid).toBe(true);
      expect(out.topoOrder).toContain('my axis');
    });

    it('detects a @map cycle through a quoted dependency', () => {
      const directives = parse(
        '@map "a" <- "b" + 1\n@map "b" <- "a" + 1\n',
      ).directives;
      const out = analyzeCascade({
        region: skeletonRegion(),
        directives,
        project: project(),
        survivedAxes: new Set(),
      });
      expect(out.valid).toBe(false);
      expect(out.demoteReason).toBe('d3');
    });

    it('unescapes \\" and \\\\ inside quoted references', () => {
      const directives = parse('@map "weird \\"name\\\\" <- 0\n').directives;
      const out = analyzeCascade({
        region: skeletonRegion(),
        directives,
        project: project(),
        survivedAxes: new Set(),
      });
      // No demote (no survived axis → no D3 missing-map check), just
      // ensure no syntax error popped up in tokenisation.
      expect(out.valid).toBe(true);
    });
  });
});
