import { describe, expect, it } from 'vitest';
import { validateBoundBlockIds } from '@/runtime/gpu-kernel/bound-block-validator';
import type { MapDirective, ParsedDirective, RepeatDirective } from '@/runtime/gpu-kernel/types';

function repeat(name: string, boundBlockId?: string): RepeatDirective {
  return {
    kind: 'repeat',
    name,
    axis: 'global_x',
    formula: 'formula',
    blockId: 'r0',
    ...(boundBlockId ? { boundBlockId } : {}),
    line: 0,
    column: 0,
  };
}

function mapDirective(varName: string, boundBlockId?: string): MapDirective {
  return {
    kind: 'map',
    var: varName,
    formula: 'formula',
    blockId: 'r0',
    ...(boundBlockId ? { boundBlockId } : {}),
    line: 0,
    column: 0,
  };
}

describe('validateBoundBlockIds', () => {
  it('passes when boundBlockId is in body', () => {
    const directives: ParsedDirective[] = [repeat('Rx', 'abc')];
    const diagnostics = validateBoundBlockIds(directives, ['abc', 'def']);
    expect(diagnostics).toHaveLength(0);
  });

  it('warns when boundBlockId is missing on @repeat', () => {
    const directives: ParsedDirective[] = [repeat('Rx', 'missing')];
    const diagnostics = validateBoundBlockIds(directives, ['abc']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('gpu.bound_block_not_found');
    expect(diagnostics[0]?.severity).toBe('warn');
    expect(diagnostics[0]?.blockId).toBe('missing');
    expect(diagnostics[0]?.message).toMatch(/directive: @repeat Rx/);
  });

  it('warns when boundBlockId is missing on @map', () => {
    const directives: ParsedDirective[] = [mapDirective('idx1', 'missing')];
    const diagnostics = validateBoundBlockIds(directives, ['abc']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('gpu.bound_block_not_found');
    expect(diagnostics[0]?.message).toMatch(/directive: @map idx1/);
  });

  it('validates all directives with boundBlockId', () => {
    const directives: ParsedDirective[] = [
      repeat('R0', 'in_body'),
      repeat('R1', 'missing_1'),
      mapDirective('idx0', 'missing_2'),
    ];
    const diagnostics = validateBoundBlockIds(directives, ['in_body']);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.blockId).toBe('missing_1');
    expect(diagnostics[1]?.blockId).toBe('missing_2');
  });

  it('ignores directives without boundBlockId (auto-detect only)', () => {
    const directives: ParsedDirective[] = [repeat('Rx'), mapDirective('idx1')];
    const diagnostics = validateBoundBlockIds(directives, ['some_block']);
    expect(diagnostics).toHaveLength(0);
  });

  it('handles empty bodyBlockIds when all directives bind externally', () => {
    const directives: ParsedDirective[] = [repeat('Rx', 'missing')];
    const diagnostics = validateBoundBlockIds(directives, []);
    expect(diagnostics).toHaveLength(1);
  });
});
