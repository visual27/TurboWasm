import { describe, expect, it } from 'vitest';
import { rewriteFormula } from '@/runtime/gpu-kernel/formula-rewrite';
import type { BindDirective } from '@/runtime/gpu-kernel/types';

function makeBinding(name: string, opts: Partial<BindDirective> = {}): BindDirective {
  return {
    kind: 'bind',
    name,
    slot: 0,
    readOnly: false,
    dtype: 'f32',
    line: 0,
    column: 0,
    ...opts,
  };
}

describe('formula-rewrite (§Phase E+)', () => {
  describe('subscript sugar: name[idx]', () => {
    it('rewrites name[idx] to scratch_list_read_f32', () => {
      const result = rewriteFormula('my_list[R0]', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.formula).toBe(
        'scratch_list_read_f32(&my_list, scratch_index_clamp(R0, u_scratch.my_list_length), u_scratch.my_list_length)',
      );
    });

    it('rewrites name[expr] with composite expression', () => {
      const result = rewriteFormula('my_list[R0 + 1]', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.formula).toBe(
        'scratch_list_read_f32(&my_list, scratch_index_clamp(R0 + 1, u_scratch.my_list_length), u_scratch.my_list_length)',
      );
    });

    it('respects dtype for subscript target', () => {
      const result = rewriteFormula('my_bytes[R0]', {
        bindings: [makeBinding('my_bytes', { dtype: 'byte' })],
      });
      expect(result.formula).toBe(
        'scratch_list_read_u32(&my_bytes, scratch_index_clamp(R0, u_scratch.my_bytes_length), u_scratch.my_bytes_length)',
      );
    });

    it('emits a diagnostic when subscript target is not a @bind', () => {
      const result = rewriteFormula('unknown[R0]', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe('gpu.formula_sugar_undeclared_target');
      expect(result.formula).toBe('unknown[R0]');
    });

    it('leaves bare identifier references alone', () => {
      const result = rewriteFormula('R0 + 1', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.formula).toBe('R0 + 1');
    });

    it('uses renameTable entry when present', () => {
      const result = rewriteFormula('my_list[R0]', {
        bindings: [makeBinding('my_list')],
        renameTable: { my_list: '__tw_hashed' },
      });
      expect(result.formula).toBe(
        'scratch_list_read_f32(&__tw_hashed, scratch_index_clamp(R0, u_scratch.__tw_hashed_length), u_scratch.__tw_hashed_length)',
      );
    });

    it('uses internalName for quoted bindings via binding name lookup', () => {
      // §Phase 3 §15.11 — quoted binding surfaces now resolve through
      // `bindingBySurface` even when the user keeps the surface name
      // on the formula without quotes (because `preprocessQuotedReferences`
      // walks every quoted segment first and renames matching
      // references to the `internalName` form before lexing).
      const result = rewriteFormula('my_list[R0]', {
        bindings: [makeBinding('my list', { internalName: '__tw_aaaa1111' })],
      });
      // The unquoted `my_list` identifier does not match the binding
      // surface `my list`; no sugar rewrite applies and a diagnostic
      // is surfaced. The user must use `"my list"[R0]` for the
      // quoted form to resolve.
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(result.formula).toBe('my_list[R0]');
    });

    it('rewrites "quoted list"[idx] to scratch_list_read via internalName (§15.11)', () => {
      const result = rewriteFormula('"my list"[R0]', {
        bindings: [makeBinding('my list', { internalName: '__tw_aaaa1111', dtype: 'f32' })],
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.formula).toBe(
        'scratch_list_read_f32(&__tw_aaaa1111, scratch_index_clamp(R0, u_scratch.__tw_aaaa1111_length), u_scratch.__tw_aaaa1111_length)',
      );
    });

    it('recursively rewrites nested quoted subscript targets (§15.11)', () => {
      // §Phase 3 §15.11 — `bool("my list"[R0])` should expand the
      // inner quoted target to its scratch_list_read_f32 form before
      // being wrapped in `select(...)`.
      const result = rewriteFormula('bool("my list"[R0])', {
        bindings: [makeBinding('my list', { internalName: '__tw_bbbb2222' })],
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.formula).toBe(
        'select(0.0, 1.0, scratch_list_read_f32(&__tw_bbbb2222, scratch_index_clamp(R0, u_scratch.__tw_bbbb2222_length), u_scratch.__tw_bbbb2222_length) != 0.0)',
      );
    });
  });

  describe('len sugar: len(name)', () => {
    it('rewrites len(my_list) to u_scratch.my_list_length', () => {
      const result = rewriteFormula('len(my_list)', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.formula).toBe('u_scratch.my_list_length');
    });

    it('rewrites len("my list") to u_scratch.<hashed>_length (§15.11)', () => {
      const result = rewriteFormula('len("my list")', {
        bindings: [makeBinding('my list', { internalName: '__tw_bbbb2222' })],
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.formula).toBe('u_scratch.__tw_bbbb2222_length');
    });

    it('surfaces a diagnostic when a quoted len() target is undeclared (§15.11)', () => {
      const result = rewriteFormula('len("missing")', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.formula).toBe('len("missing")');
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    });

    it('emits a diagnostic when len() target is not a @bind', () => {
      const result = rewriteFormula('len(unknown)', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.formula).toBe('len(unknown)');
    });

    it('leaves len() alone when it has zero or multiple args', () => {
      const zero = rewriteFormula('len()', { bindings: [makeBinding('my_list')] });
      expect(zero.formula).toBe('len()');
      const multi = rewriteFormula('len(a, b)', { bindings: [makeBinding('a'), makeBinding('b')] });
      expect(multi.formula).toBe('len(a, b)');
      expect(multi.diagnostics.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('bool sugar: bool(x)', () => {
    it('rewrites bool(x) to select(0.0, 1.0, x != 0.0)', () => {
      const result = rewriteFormula('bool(R0)', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.formula).toBe('select(0.0, 1.0, R0 != 0.0)');
    });

    it('rewrites bool(expr) with composite expression', () => {
      const result = rewriteFormula('bool(R0 + 1)', {
        bindings: [],
      });
      expect(result.formula).toBe('select(0.0, 1.0, R0 + 1 != 0.0)');
    });

    it('leaves bare bool identifier alone', () => {
      const result = rewriteFormula('bool', {
        bindings: [],
      });
      expect(result.formula).toBe('bool');
    });
  });

  describe('combined sugar', () => {
    it('rewrites len(my_list) + bool(my_list[R0])', () => {
      const result = rewriteFormula('len(my_list) + bool(my_list[R0])', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.formula).toBe(
        'u_scratch.my_list_length + select(0.0, 1.0, scratch_list_read_f32(&my_list, scratch_index_clamp(R0, u_scratch.my_list_length), u_scratch.my_list_length) != 0.0)',
      );
    });
  });

  describe('lexical safety', () => {
    it('does not match inside string literals', () => {
      const result = rewriteFormula('"my_list[R0]"', {
        bindings: [makeBinding('my_list')],
      });
      expect(result.formula).toBe('"my_list[R0]"');
      expect(result.diagnostics).toEqual([]);
    });

    it('handles nested brackets by recursing into the subscript', () => {
      // §Phase E+: the inner expression of `outer[...]` is itself
      // recursively rewritten. Because `R0` is a binding, the inner
      // subscript expands to its own scratch_list_read_f32 call. This
      // composes naturally — `outer[R0[0]]` reads the value at the
      // index stored in `R0` of the list `outer`, then uses that as the
      // index into `outer`. (In practice the user would write this only
      // when `R0` is itself a list of indices.)
      const result = rewriteFormula('outer[R0[0]]', {
        bindings: [makeBinding('outer'), makeBinding('R0')],
      });
      expect(result.formula).toBe(
        'scratch_list_read_f32(&outer, scratch_index_clamp(scratch_list_read_f32(&R0, scratch_index_clamp(0, u_scratch.R0_length), u_scratch.R0_length), u_scratch.outer_length), u_scratch.outer_length)',
      );
    });

    it('passes through empty formulas unchanged', () => {
      const result = rewriteFormula('', { bindings: [] });
      expect(result.formula).toBe('');
      expect(result.diagnostics).toEqual([]);
    });
  });
});
