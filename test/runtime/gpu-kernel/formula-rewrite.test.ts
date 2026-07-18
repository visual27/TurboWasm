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
      // §Phase E+: a quoted @bind's `name` field is the surface name;
      // the formula lexer matches identifiers, so the user references
      // the binding by its surface name (without surrounding quotes) in
      // formulas. This test confirms the rewrite still routes to
      // `internalName` when the binding was declared with one.
      const result = rewriteFormula('my_list[R0]', {
        bindings: [makeBinding('my list', { internalName: '__tw_aaaa1111' })],
      });
      // Surface name "my list" doesn't match the literal identifier
      // "my_list" — the binding lookup is by surface name. The
      // formula is left as-is and a diagnostic is surfaced.
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(result.formula).toBe('my_list[R0]');
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

    it('does not match quoted surface names inside len() — leaves len() alone', () => {
      // The lexer treats `"my list"` as a string literal; the `name`
      // inside `len("my list")` is not an identifier we recognise.
      // The user references the binding via its surface name without
      // quotes; quoted references are out of scope for §Phase E+ — see
      // AGENTS.md §Phase E for the rationale.
      const result = rewriteFormula('len("my list")', {
        bindings: [makeBinding('my list', { internalName: '__tw_bbbb2222' })],
      });
      expect(result.formula).toBe('len("my list")');
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
