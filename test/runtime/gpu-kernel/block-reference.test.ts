import { describe, expect, it } from 'vitest';
import { extractBlockReference } from '@/runtime/gpu-kernel/block-reference';

describe('extractBlockReference (§15.15 shared helper)', () => {
  describe('accepted raw shapes', () => {
    it('accepts a bare string block id', () => {
      expect(extractBlockReference('abc')).toBe('abc');
    });

    it('accepts an empty-string id (callers decide whether to trust it)', () => {
      // `extractBlockReference` does NOT validate; downstream
      // `blocks[id]` lookup will reject empties. This pins the
      // helper's "extract" contract.
      expect(extractBlockReference('')).toBe('');
    });

    it('accepts { id: "abc" }', () => {
      expect(extractBlockReference({ id: 'abc' })).toBe('abc');
    });

    it('accepts { id: "abc", name: "foo" } (vendored VM variable ref shape)', () => {
      expect(extractBlockReference({ id: 'abc', name: 'foo' })).toBe('abc');
    });

    it('accepts { block: "abc", shadow: "xyz" } and prefers `block`', () => {
      expect(extractBlockReference({ block: 'abc', shadow: 'xyz' })).toBe('abc');
    });

    it('accepts { shadow: "xyz" } when `block` is absent (legacy shape)', () => {
      expect(extractBlockReference({ shadow: 'xyz' })).toBe('xyz');
    });

    it('accepts [2, "abc"] (INPUT_BLOCK_NO_SHADOW)', () => {
      expect(extractBlockReference([2, 'abc'])).toBe('abc');
    });

    it('accepts [1, "abc"] (INPUT_SAME_BLOCK_SHADOW)', () => {
      expect(extractBlockReference([1, 'abc'])).toBe('abc');
    });

    it('accepts [3, "abc"] (INPUT_DIFF_BLOCK_SHADOW)', () => {
      expect(extractBlockReference([3, 'abc'])).toBe('abc');
    });

    it('accepts a nested array [2, [2, "abc"]] (recursive)', () => {
      expect(extractBlockReference([2, [2, 'abc']])).toBe('abc');
    });

    it('accepts [2, { id: "abc" }] (array element is an object ref)', () => {
      expect(extractBlockReference([2, { id: 'abc' }])).toBe('abc');
    });

    it('accepts a numeric id (legacy VM serialiser)', () => {
      expect(extractBlockReference(42)).toBe('42');
      expect(extractBlockReference(0)).toBe('0');
    });
  });

  describe('rejected shapes', () => {
    it('returns null for null / undefined', () => {
      expect(extractBlockReference(null)).toBeNull();
      expect(extractBlockReference(undefined)).toBeNull();
    });

    it('returns null for an empty object', () => {
      expect(extractBlockReference({})).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(extractBlockReference([])).toBeNull();
    });

    it('returns null for an object whose fields are the wrong type', () => {
      expect(extractBlockReference({ id: 42 })).toBeNull();
      expect(extractBlockReference({ block: { nested: 'x' } })).toBeNull();
    });

    it('returns null for a literal payload [10, ["math_number", "5"]]', () => {
      // `10` is the SB3 shadow opcode for `math_number`; the array is a
      // primitive literal, NOT a block reference. `extractBlockReference`
      // must reject it so the literal falls through to other code paths
      // (e.g. `axis-analysis.ts:isZeroLiteralShadow`).
      expect(extractBlockReference([10, ['math_number', '5']])).toBeNull();
    });

    it('returns null for a numeric NaN / Infinity', () => {
      expect(extractBlockReference(Number.NaN)).toBeNull();
      expect(extractBlockReference(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('returns null for a boolean', () => {
      expect(extractBlockReference(true)).toBeNull();
      expect(extractBlockReference(false)).toBeNull();
    });
  });

  describe('shape compatibility with downstream helpers', () => {
    // These cases pin the contract that downstream callers depend on.
    // The gpu-kernel pipeline passes inputs/fields through directly from
    // `player.ts:toParsedProject`, so the helper must accept whatever
    // shape the vendored scratch-vm serialiser emits today.

    it('reads the [shadowKind, [opcode, value]] literal as null, leaving `value` accessible separately', () => {
      const input: [number, [string, string]] = [10, ['math_number', '1']];
      expect(extractBlockReference(input)).toBeNull();
    });

    it('recovers a block id from a 3-level nested array [2, [1, [3, "abc"]]]', () => {
      // Defensive fallback: when the shadow kind is unknown, scan children.
      // This shape isn't produced by sb3.js today, but the helper is
      // robust against future serialiser changes.
      expect(extractBlockReference([2, [1, [3, 'abc']]])).toBe('abc');
    });
  });
});
