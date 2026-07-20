/**
 * §Phase 3 — WGSL dispatch formula evaluator tests.
 *
 * カバー範囲:
 *   - reduceListReads (f32 / u32 / clamping)
 *   - reduceStorageRefs / reduceListLengthRefs / reduceLenSugar
 *   - reduceScalarNames (with word boundary)
 *   - reduceMathHelpers (scratch_div / scratch_mod / scratch_index_clamp / ceil / max)
 *   - 統合: `ceil(scratch_list_read_f32(&aabb_h, aabb_idx0, u_scratch.aabb_h_length) / 64)`
 *   - エラーハンドリング (空 / SyntaxError → 0 + warn / 非有限 → 0)
 *
 * 仕様参照: nested-parallelization-04-phase3 §3.6.3
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateDispatchFormula,
  type DispatchFormulaContext,
} from '@/runtime/gpu-kernel/dispatch-formula-evaluator';
import type { ScalarUniformBinding } from '@/runtime/gpu-kernel/scalar-uniform-binding';
import { useErrorLogStore } from '@/stores/useErrorLogStore';

interface ContextOptions {
  scalars?: Array<{ name: string; dtype?: 'f32' | 'i32' }>;
  scalarValues?: Map<string, number>;
  listLengths?: Record<string, number>;
  listData?: Record<string, Float32Array | Int32Array | Uint8Array>;
}

function makeContext(opts: ContextOptions = {}): DispatchFormulaContext {
  const scalarBindings: ScalarUniformBinding[] = (opts.scalars ?? []).map(
    (s): ScalarUniformBinding => ({
      name: s.name,
      wgslName: s.name,
      dtype: s.dtype ?? 'f32',
    }),
  );
  const scalarValues = opts.scalarValues ?? new Map();
  const listLengths = opts.listLengths ?? {};
  const listData = opts.listData ?? {};
  return {
    scalarBindings,
    scalarValues,
    listLength: (name) => listLengths[name] ?? 0,
    readList: (name, length, dtype) => {
      const data = listData[name];
      if (data) return data;
      if (dtype === 'i32') return new Int32Array(length);
      if (dtype === 'byte') return new Uint8Array(length);
      return new Float32Array(length);
    },
  };
}

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
});
afterEach(() => {
  useErrorLogStore.setState({ entries: [] });
});

describe('reduceScalarNames', () => {
  it('replaces scalar name with scalarValues entry', () => {
    const ctx = makeContext({
      scalars: [{ name: 'aabb_idx0' }],
      scalarValues: new Map([['aabb_idx0', 5]]),
    });
    expect(evaluateDispatchFormula('aabb_idx0', ctx)).toBe(5);
  });

  it('respects word boundary (aabb_idx0 vs aabb_idx0_x)', () => {
    const ctx = makeContext({
      scalars: [{ name: 'aabb_idx0' }],
      scalarValues: new Map([['aabb_idx0', 5]]),
    });
    // `aabb_idx0` を置換するときに `aabb_idx0_x` には触れない
    expect(evaluateDispatchFormula('aabb_idx0_x', ctx)).toBe(0);
  });

  it('returns 0 when scalar missing in scalarValues', () => {
    const ctx = makeContext({
      scalars: [{ name: 'aabb_idx0' }],
      scalarValues: new Map(),
    });
    expect(evaluateDispatchFormula('aabb_idx0', ctx)).toBe(0);
  });

  it('handles multiple scalars in one expression', () => {
    const ctx = makeContext({
      scalars: [{ name: 'a' }, { name: 'b' }],
      scalarValues: new Map([
        ['a', 3],
        ['b', 7],
      ]),
    });
    expect(evaluateDispatchFormula('a + b', ctx)).toBe(10);
    expect(evaluateDispatchFormula('a * b', ctx)).toBe(21);
  });

  it('matches the binding wgslName for quoted scalar bindings (§15.11)', () => {
    // §Phase 3 §15.11 — quoted @bind ... scalar binding has a hashed
    // `wgslName`. The dispatch formula is rewritten to that hashed
    // name by the emitter, so the evaluator must match the formula
    // against `wgslName` while still looking up the runtime value via
    // `name` (= surface name, the runtime adapter key).
    const ctx = makeContext({
      scalars: [{ name: 'my idx', dtype: 'f32' }],
      scalarValues: new Map([['my idx', 7]]),
    });
    // Manually override the binding's wgslName to simulate the rename
    // pass that the WGSL emitter applies before dispatch.
    ctx.scalarBindings = [{ name: 'my idx', wgslName: '__tw_deadbeef', dtype: 'f32' }];
    expect(evaluateDispatchFormula('__tw_deadbeef', ctx)).toBe(7);
  });
});

describe('reduceLenSugar', () => {
  it('replaces len(list_name) with host listLength', () => {
    const ctx = makeContext({ listLengths: { my_list: 100 } });
    expect(evaluateDispatchFormula('len(my_list)', ctx)).toBe(100);
  });
});

describe('reduceListLengthRefs', () => {
  it('replaces u_scratch.<list>_length with host length', () => {
    const ctx = makeContext({ listLengths: { my_list: 42 } });
    expect(evaluateDispatchFormula('u_scratch.my_list_length', ctx)).toBe(42);
  });
});

describe('reduceStorageRefs', () => {
  it('replaces &<name> with host listLength', () => {
    const ctx = makeContext({ listLengths: { my_list: 7 } });
    expect(evaluateDispatchFormula('&my_list', ctx)).toBe(7);
  });
});

describe('reduceListReads', () => {
  it('reads f32 list element at index', () => {
    const ctx = makeContext({
      listData: { my_list: new Float32Array([10, 20, 30, 40]) },
      listLengths: { my_list: 4 },
    });
    expect(
      evaluateDispatchFormula(
        'scratch_list_read_f32(&my_list, 2, u_scratch.my_list_length)',
        ctx,
      ),
    ).toBe(30);
  });

  it('reads u32 list element (byte ABI mapping)', () => {
    const ctx = makeContext({
      listData: { byte_list: new Uint8Array([5, 10, 15, 20]) },
      listLengths: { byte_list: 4 },
    });
    expect(
      evaluateDispatchFormula(
        'scratch_list_read_u32(&byte_list, 1, u_scratch.byte_list_length)',
        ctx,
      ),
    ).toBe(10);
  });

  it('clamps out-of-range index (>= len) to len - 1', () => {
    const ctx = makeContext({
      listData: { my_list: new Float32Array([10, 20]) },
      listLengths: { my_list: 2 },
    });
    expect(
      evaluateDispatchFormula(
        'scratch_list_read_f32(&my_list, 99, u_scratch.my_list_length)',
        ctx,
      ),
    ).toBe(20);
  });

  it('clamps negative index to 0', () => {
    const ctx = makeContext({
      listData: { my_list: new Float32Array([10, 20]) },
      listLengths: { my_list: 2 },
    });
    expect(
      evaluateDispatchFormula(
        'scratch_list_read_f32(&my_list, -5, u_scratch.my_list_length)',
        ctx,
      ),
    ).toBe(10);
  });

  it('returns 0 when readList yields null', () => {
    const ctx = makeContext({
      // listLengths を設定しない → safeListLength が 0 → clampedIdx = 0 → data[0] = 0 (default)
      listLengths: {},
    });
    expect(
      evaluateDispatchFormula(
        'scratch_list_read_f32(&unknown_list, 0, u_scratch.unknown_list_length)',
        ctx,
      ),
    ).toBe(0);
  });
});

describe('reduceMathHelpers', () => {
  it('expands scratch_div to (a)/(b)', () => {
    const ctx = makeContext();
    expect(evaluateDispatchFormula('scratch_div(10, 4)', ctx)).toBe(2.5);
    expect(evaluateDispatchFormula('scratch_div(0, 5)', ctx)).toBe(0);
  });

  it('expands scratch_mod with positive-modulo convention', () => {
    const ctx = makeContext();
    // scratch_mod(-1, 5) → ((-1 % 5) + 5) % 5 = (-1 + 5) % 5 = 4
    expect(evaluateDispatchFormula('scratch_mod(-1, 5)', ctx)).toBe(4);
    // scratch_mod(7, 3) → ((7 % 3) + 3) % 3 = (1 + 3) % 3 = 1
    expect(evaluateDispatchFormula('scratch_mod(7, 3)', ctx)).toBe(1);
    // scratch_mod(0, 5) → 0
    expect(evaluateDispatchFormula('scratch_mod(0, 5)', ctx)).toBe(0);
  });

  it('expands scratch_index_clamp to host-side clamp', () => {
    const ctx = makeContext();
    // scratch_index_clamp(5, 3) → Math.max(0, Math.min(5, Math.max(0, 3-1))) = 2
    expect(evaluateDispatchFormula('scratch_index_clamp(5, 3)', ctx)).toBe(2);
    // scratch_index_clamp(99, 10) → Math.min(99, 9) = 9
    expect(evaluateDispatchFormula('scratch_index_clamp(99, 10)', ctx)).toBe(9);
  });

  it('expands ceil to Math.ceil', () => {
    const ctx = makeContext();
    expect(evaluateDispatchFormula('ceil(3.2)', ctx)).toBe(4);
    expect(evaluateDispatchFormula('ceil(10)', ctx)).toBe(10);
  });

  it('expands max with multiple arguments', () => {
    const ctx = makeContext();
    expect(evaluateDispatchFormula('max(1, 2, 3)', ctx)).toBe(3);
    expect(evaluateDispatchFormula('max(0.5, 0)', ctx)).toBe(0.5);
    expect(evaluateDispatchFormula('max(1, 2)', ctx)).toBe(2);
  });
});

describe('integration: nested compound formula', () => {
  it("evaluates ceil(scratch_list_read_f32(&aabb_h, aabb_idx0, u_scratch.aabb_h_length) / 64)", () => {
    // aabb_idx0 = 2 (scalar uniform), aabb_h = [10, 20, 30] → aabb_h[2] = 30
    const ctx = makeContext({
      scalars: [{ name: 'aabb_idx0' }],
      scalarValues: new Map([['aabb_idx0', 2]]),
      listData: { aabb_h: new Float32Array([10, 20, 30]) },
      listLengths: { aabb_h: 3 },
    });
    // ceil(30 / 64) = ceil(0.46875) = 1
    expect(
      evaluateDispatchFormula(
        'ceil(scratch_list_read_f32(&aabb_h, aabb_idx0, u_scratch.aabb_h_length) / 64)',
        ctx,
      ),
    ).toBe(1);
  });

  it('evaluates aabb_tmp0 / 64 with dynamic scalar (no list ref)', () => {
    const ctx = makeContext({
      scalars: [{ name: 'aabb_tmp0', dtype: 'f32' }],
      scalarValues: new Map([['aabb_tmp0', 256]]),
    });
    expect(evaluateDispatchFormula('ceil(aabb_tmp0 / 64)', ctx)).toBe(4);
  });
});

describe('error handling', () => {
  it('returns 0 for empty expression', () => {
    const ctx = makeContext();
    expect(evaluateDispatchFormula('', ctx)).toBe(0);
    expect(evaluateDispatchFormula('   ', ctx)).toBe(0);
  });

  it('emits gpu.dispatch_formula_eval_failed on SyntaxError', () => {
    const ctx = makeContext();
    // "(((" は parser で "(((" のまま残り、Function() で構文エラーになる
    const result = evaluateDispatchFormula('(((', ctx);
    expect(result).toBe(0);
    const errors = useErrorLogStore.getState().entries;
    expect(errors.some((e) => e.message.includes('gpu.dispatch_formula_eval_failed'))).toBe(
      true,
    );
  });

  it('returns 0 for non-finite result (division by zero)', () => {
    const ctx = makeContext();
    expect(evaluateDispatchFormula('1/0', ctx)).toBe(0);
  });
});
