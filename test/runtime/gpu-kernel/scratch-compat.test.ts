import { describe, expect, it } from 'vitest';
import {
  jsScratchBool,
  jsScratchDiv,
  jsScratchIndexClamp,
  jsScratchMod,
  scratchCompatHeader,
} from '@/runtime/gpu-kernel/scratch-compat';

describe('scratch-compat', () => {
  it('preserves NaN for zero divided by zero', () => {
    expect(jsScratchDiv(0, 0)).toBeNaN();
  });

  it('preserves positive infinity for division by zero', () => {
    expect(jsScratchDiv(5, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('computes positive floored modulo', () => {
    expect(jsScratchMod(7, 3)).toBe(1);
  });

  it('computes negative floored modulo', () => {
    expect(jsScratchMod(-7, 3)).toBe(2);
  });

  it('rejects an index below the one-based range', () => {
    expect(jsScratchIndexClamp(0, 10)).toBe(-1);
  });

  it('rejects an index above the list length', () => {
    expect(jsScratchIndexClamp(11, 10)).toBe(-1);
  });

  it('preserves an in-range index', () => {
    expect(jsScratchIndexClamp(5, 10)).toBe(5);
  });

  it('treats NaN as false', () => {
    expect(jsScratchBool(Number.NaN)).toBe(0);
  });

  it('treats zero as false', () => {
    expect(jsScratchBool(0)).toBe(0);
  });

  it('treats non-zero as true', () => {
    expect(jsScratchBool(1)).toBe(1);
  });

  it('contains every WGSL compatibility helper', () => {
    const header = scratchCompatHeader();
    for (const name of [
      'scratch_div',
      'scratch_mod',
      'scratch_index_clamp',
      'scratch_list_read_f32',
      'scratch_list_read_i32',
      'scratch_list_write_f32',
      'scratch_bool',
    ]) {
      expect(header).toContain(`fn ${name}`);
    }
  });
});
