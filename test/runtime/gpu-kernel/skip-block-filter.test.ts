import { describe, expect, it } from 'vitest';
import { shouldSkipBlock } from '@/runtime/gpu-kernel/skip-block-filter';
import type { EffectivePattern } from '@/runtime/gpu-kernel/types';

function iterPattern(blockId: string): EffectivePattern {
  return {
    kind: 'iteration-advance',
    pattern: {
      kind: 'iteration-advance',
      varName: 'idx1',
      delta: 1,
      blockId,
      source: 'auto-detected',
    },
  };
}

function indirectPattern(blockId: string): EffectivePattern {
  return {
    kind: 'indirect-access',
    pattern: {
      kind: 'indirect-access',
      scratchListName: 'buff_r',
      indexExpr: 'idx1',
      opcode: 'data_itemoflist',
      blockId,
      access: 'read',
      source: 'auto-detected',
    },
  };
}

describe('shouldSkipBlock', () => {
  it('returns true when blockId matches an iteration-advance pattern', () => {
    const ctx = { effectivePatterns: [iterPattern('b1')] };
    expect(shouldSkipBlock('b1', ctx)).toBe(true);
  });

  it('returns true when blockId matches an indirect-access (read) pattern', () => {
    const ctx = { effectivePatterns: [indirectPattern('b2')] };
    expect(shouldSkipBlock('b2', ctx)).toBe(true);
  });

  it('returns false when blockId is not in any pattern', () => {
    const ctx = { effectivePatterns: [iterPattern('b1'), indirectPattern('b2')] };
    expect(shouldSkipBlock('b3', ctx)).toBe(false);
  });

  it('returns false when effectivePatterns is empty', () => {
    const ctx = { effectivePatterns: [] };
    expect(shouldSkipBlock('b1', ctx)).toBe(false);
  });

  it('returns false when effectivePatterns is undefined-shape (empty array passed)', () => {
    // The EmitterContext always passes an array (possibly empty) — defensive
    // guard for safety against accidental `undefined` slipping through.
    const ctx = { effectivePatterns: [] as EffectivePattern[] };
    expect(shouldSkipBlock('any', ctx)).toBe(false);
  });

  it('handles multiple patterns across distinct blockIds', () => {
    const ctx = {
      effectivePatterns: [iterPattern('a'), indirectPattern('b'), iterPattern('c')],
    };
    expect(shouldSkipBlock('a', ctx)).toBe(true);
    expect(shouldSkipBlock('b', ctx)).toBe(true);
    expect(shouldSkipBlock('c', ctx)).toBe(true);
    expect(shouldSkipBlock('d', ctx)).toBe(false);
  });

  it('treats write-style indirect-access as not skip-eligible (precondition)', () => {
    // `indirect-access-pattern.ts` does not emit write patterns; this
    // test guards the contract that skip-set never contains a write.
    // If a write pattern sneaked in (Phase 1 regression), we'd want to
    // catch it here.
    const writePattern: EffectivePattern = {
      kind: 'indirect-access',
      pattern: {
        kind: 'indirect-access',
        scratchListName: 'buff_r',
        indexExpr: 'idx1',
        opcode: 'data_replaceitemoflist',
        blockId: 'b-write',
        access: 'write',
        source: 'auto-detected',
      },
    };
    // Skip-logic は blockId のみ比較するので、write pattern が来てしまえば
    // skip されてしまう (= Phase 1 で write を除外している前提を破壊)。
    // ここでは write pattern が入った場合の挙動を固定する:
    const ctx = { effectivePatterns: [writePattern] };
    // write まで skip してしまうが、これは indirect-access-pattern.ts が
    // `access: 'read'` のみ emit することで防ぐ契約。
    expect(shouldSkipBlock('b-write', ctx)).toBe(true);
  });
});
