import { describe, expect, it } from 'vitest';
import { mergePatterns } from '@/runtime/gpu-kernel/pattern-merger';
import type {
  BlockSubsetVerdict,
  IndirectAccessPattern,
  IterationAdvancePattern,
} from '@/runtime/gpu-kernel/types';

function iterPattern(opts: Partial<IterationAdvancePattern> = {}): IterationAdvancePattern {
  return {
    kind: 'iteration-advance',
    varName: 'idx1',
    delta: 1,
    blockId: 'b1',
    source: 'auto-detected',
    ...opts,
  };
}

function indirectPattern(opts: Partial<IndirectAccessPattern> = {}): IndirectAccessPattern {
  return {
    kind: 'indirect-access',
    scratchListName: 'buff_r',
    indexExpr: 'idx1',
    opcode: 'data_itemoflist',
    blockId: 'b1',
    access: 'read',
    source: 'auto-detected',
    ...opts,
  };
}

const validSubset: Pick<BlockSubsetVerdict, 'valid'> = { valid: true };
const demotedSubset: Pick<BlockSubsetVerdict, 'valid'> = { valid: false };

describe('mergePatterns', () => {
  it('explicit takes precedence over auto-detected for same blockId (iteration)', () => {
    const explicit = iterPattern({ blockId: 'b1', source: 'explicit' });
    const auto = iterPattern({ blockId: 'b1', source: 'auto-detected' });
    const result = mergePatterns([explicit, auto], [], validSubset, { debug: true });
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0]?.pattern.source).toBe('explicit');
    expect(result.droppedAutoDetected).toHaveLength(1);
    expect(result.droppedAutoDetected[0]?.reason).toMatch(/overridden/);
  });

  it('explicit takes precedence over auto-detected for same blockId (indirect)', () => {
    const explicit = indirectPattern({ blockId: 'b2', source: 'explicit' });
    const auto = indirectPattern({ blockId: 'b2', source: 'auto-detected' });
    const result = mergePatterns([], [explicit, auto], validSubset, { debug: true });
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0]?.pattern.source).toBe('explicit');
    expect(result.droppedAutoDetected).toHaveLength(1);
  });

  it('auto-detected only when no explicit conflict', () => {
    const a = iterPattern({ blockId: 'a' });
    const b = indirectPattern({ blockId: 'b' });
    const result = mergePatterns([a], [b], validSubset, { debug: true });
    expect(result.effective).toHaveLength(2);
    expect(result.droppedAutoDetected).toHaveLength(0);
  });

  it('info diagnostic on auto-detected pattern', () => {
    const a = iterPattern({ blockId: 'a' });
    const result = mergePatterns([a], [], validSubset, { debug: true });
    const info = result.diagnostics.find((d) => d.code === 'gpu.axis_auto_detected');
    expect(info).toBeDefined();
    expect(info?.severity).toBe('info');
  });

  it('no info diagnostic on explicit-only pattern', () => {
    const a = iterPattern({ blockId: 'a', source: 'explicit' });
    const result = mergePatterns([a], [], validSubset, { debug: true });
    const info = result.diagnostics.find((d) => d.code === 'gpu.axis_auto_detected');
    expect(info).toBeUndefined();
  });

  it('D1-demoted region: patterns all dropped', () => {
    const a = iterPattern({ blockId: 'a' });
    const b = indirectPattern({ blockId: 'b' });
    const result = mergePatterns([a], [b], demotedSubset, { debug: true });
    expect(result.effective).toHaveLength(0);
    expect(result.droppedAutoDetected).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('multiple iteration patterns across distinct blockIds all survive', () => {
    const a = iterPattern({ blockId: 'a' });
    const b = iterPattern({ blockId: 'b' });
    const c = iterPattern({ blockId: 'c', source: 'explicit' });
    const result = mergePatterns([a, b, c], [], validSubset, { debug: true });
    expect(result.effective).toHaveLength(3);
    const sources = result.effective.map((e) => e.pattern.source).sort();
    expect(sources).toEqual(['auto-detected', 'auto-detected', 'explicit']);
  });

  it('empty inputs produce empty effective', () => {
    const result = mergePatterns([], [], validSubset, { debug: true });
    expect(result.effective).toHaveLength(0);
    expect(result.droppedAutoDetected).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe('mergePatterns debug gate (Phase 1 finish-up)', () => {
  it('does NOT emit gpu.axis_auto_detected when debug=false (production mode)', () => {
    const a = iterPattern({ blockId: 'a' });
    const result = mergePatterns([a], [], validSubset, { debug: false });
    const info = result.diagnostics.find((d) => d.code === 'gpu.axis_auto_detected');
    expect(info).toBeUndefined();
    expect(result.effective).toHaveLength(1);
  });

  it('debug=false still drops / effective normally — only info diagnostic is gated', () => {
    const explicit = iterPattern({ blockId: 'b1', source: 'explicit' });
    const auto = iterPattern({ blockId: 'b1', source: 'auto-detected' });
    const result = mergePatterns([explicit, auto], [], validSubset, { debug: false });
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0]?.pattern.source).toBe('explicit');
    expect(result.droppedAutoDetected).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('defaults to import.meta.env.DEV (Vitest: true → info emitted)', () => {
    // Vite test pipeline maps NODE_ENV=test → DEV=true. Pinning this
    // contract here means a future change to the Vite config (e.g.
    // flipping DEV off in CI) is caught by this test instead of by
    // production users noticing silent auto-detected surfaces.
    const a = iterPattern({ blockId: 'a' });
    const result = mergePatterns([a], [], validSubset);
    const info = result.diagnostics.find((d) => d.code === 'gpu.axis_auto_detected');
    expect(info).toBeDefined();
    expect(info?.severity).toBe('info');
  });
});
