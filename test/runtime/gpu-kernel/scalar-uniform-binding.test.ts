/**
 * §Phase 3 — scalar uniform binding helper tests.
 *
 * カバー範囲:
 *   - createScalarUniformBindings: filter / rename / dtype / 順序 / undefined = 'list'
 *   - packScalarUniformBuffer: 16-byte header + 16-byte stride / f32 / i32 / missing value
 *   - scalarUniformBufferSize: 数式一致
 *   - readScalarUniformBuffer: f32 / i32 round-trip
 *
 * 仕様参照: nested-parallelization-04-phase3 §3.4
 */
import { describe, expect, it } from 'vitest';
import {
  createScalarUniformBindings,
  packScalarUniformBuffer,
  readScalarUniformBuffer,
  SCALAR_UNIFORM_FIELD_STRIDE_BYTES,
  SCALAR_UNIFORM_HEADER_BYTES,
  scalarUniformBufferSize,
  type ScalarUniformBinding,
} from '@/runtime/gpu-kernel/scalar-uniform-binding';
import type { BindDirective } from '@/runtime/gpu-kernel/types';

function makeBind(
  name: string,
  slot: number,
  opts: { kind?: 'list' | 'scalar'; dtype?: 'f32' | 'i32' | 'byte' } = {},
): BindDirective {
  return {
    kind: 'bind',
    name,
    slot,
    readOnly: false,
    storageKind: opts.kind,
    dtype: opts.dtype ?? 'f32',
    line: 0,
    column: 0,
  };
}

describe('createScalarUniformBindings', () => {
  it('creates bindings for scalar directives', () => {
    const directives = [
      makeBind('aabb_idx0', 4, { kind: 'scalar', dtype: 'i32' }),
      makeBind('aabb_tmp0', 10, { kind: 'scalar', dtype: 'f32' }),
    ];
    const result = createScalarUniformBindings(directives, {});
    expect(result).toEqual([
      { name: 'aabb_idx0', wgslName: 'aabb_idx0', dtype: 'i32' },
      { name: 'aabb_tmp0', wgslName: 'aabb_tmp0', dtype: 'f32' },
    ]);
  });

  it('ignores non-scalar directives (storageKind: "list")', () => {
    const directives = [makeBind('buff_r', 1, { kind: 'list', dtype: 'f32' })];
    expect(createScalarUniformBindings(directives, {})).toEqual([]);
  });

  it('ignores storageKind undefined (= legacy list)', () => {
    const directives: BindDirective[] = [
      {
        kind: 'bind',
        name: 'buff_r',
        slot: 1,
        readOnly: false,
        dtype: 'f32',
        line: 0,
        column: 0,
        // storageKind 省略
      },
    ];
    expect(createScalarUniformBindings(directives, {})).toEqual([]);
  });

  it('keeps `storageKind: undefined` and `storageKind: "list"` equivalent for canonicalisation', () => {
    const listVersion = [makeBind('a', 0, { kind: 'list' })];
    const legacyVersion: BindDirective[] = [
      {
        kind: 'bind',
        name: 'a',
        slot: 0,
        readOnly: false,
        dtype: 'f32',
        line: 0,
        column: 0,
      },
    ];
    expect(createScalarUniformBindings(listVersion, {})).toEqual(
      createScalarUniformBindings(legacyVersion, {}),
    );
  });

  it('uses renameTable when present (Phase E+ quoted names)', () => {
    const directives = [makeBind('aabb idx0', 4, { kind: 'scalar', dtype: 'i32' })];
    const renameTable = { 'aabb idx0': '__tw_abc123' };
    const result = createScalarUniformBindings(directives, renameTable);
    expect(result[0]?.wgslName).toBe('__tw_abc123');
  });

  it('maps `byte` dtype to i32 (host ABI simplification)', () => {
    const directives = [makeBind('byte_var', 5, { kind: 'scalar', dtype: 'byte' })];
    const result = createScalarUniformBindings(directives, {});
    expect(result[0]?.dtype).toBe('i32');
  });

  it('preserves parser output order (= directive order)', () => {
    const directives = [
      makeBind('c', 2, { kind: 'scalar' }),
      makeBind('a', 0, { kind: 'scalar' }),
      makeBind('b', 1, { kind: 'scalar' }),
    ];
    // parser 出力順 (= slot 順ではなく出現順) を維持
    expect(createScalarUniformBindings(directives, {}).map((b) => b.name)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('does not include non-bind directives (max / repeat / map / workgroup_size)', () => {
    const directives: BindDirective[] = [
      makeBind('a', 0, { kind: 'scalar' }),
      {
        kind: 'max',
        name: 'length',
        value: 1024,
        line: 0,
        column: 0,
      } as unknown as BindDirective,
    ];
    const result = createScalarUniformBindings(directives, {});
    expect(result.length).toBe(1);
    expect(result[0]?.name).toBe('a');
  });
});

describe('packScalarUniformBuffer', () => {
  it('produces 16-byte header + 16-byte stride for one binding', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'x', wgslName: 'x', dtype: 'f32' },
    ];
    const buf = packScalarUniformBuffer(bindings, { x: 1.0 });
    expect(buf.byteLength).toBe(SCALAR_UNIFORM_HEADER_BYTES + 16);
  });

  it('packs f32 values via DataView (little-endian)', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'x', wgslName: 'x', dtype: 'f32' },
      { name: 'y', wgslName: 'y', dtype: 'f32' },
    ];
    const values = new Map<string, number>([
      ['x', 1.5],
      ['y', -2.25],
    ]);
    const buf = packScalarUniformBuffer(bindings, values);
    const view = new DataView(buf);
    expect(view.getFloat32(SCALAR_UNIFORM_HEADER_BYTES, true)).toBe(1.5);
    expect(view.getFloat32(SCALAR_UNIFORM_HEADER_BYTES + 16, true)).toBe(-2.25);
  });

  it('packs i32 values via Math.trunc', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'i', wgslName: 'i', dtype: 'i32' },
    ];
    const buf = packScalarUniformBuffer(bindings, { i: 42.7 });
    const view = new DataView(buf);
    expect(view.getInt32(SCALAR_UNIFORM_HEADER_BYTES, true)).toBe(42);
  });

  it('truncates i32 negative values toward zero', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'i', wgslName: 'i', dtype: 'i32' },
    ];
    const buf = packScalarUniformBuffer(bindings, { i: -3.9 });
    const view = new DataView(buf);
    expect(view.getInt32(SCALAR_UNIFORM_HEADER_BYTES, true)).toBe(-3);
  });

  it('falls back to 0 when value is missing', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'missing', wgslName: 'missing', dtype: 'f32' },
    ];
    const buf = packScalarUniformBuffer(bindings, {});
    const view = new DataView(buf);
    expect(view.getFloat32(SCALAR_UNIFORM_HEADER_BYTES, true)).toBe(0);
  });

  it('accepts both Map and plain Record (parameter polymorphism)', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'x', wgslName: 'x', dtype: 'f32' },
    ];
    const mapInput = new Map([['x', 3.14]]);
    const recordInput = { x: 3.14 };
    const mapBuf = packScalarUniformBuffer(bindings, mapInput);
    const recordBuf = packScalarUniformBuffer(bindings, recordInput);
    expect(mapBuf.byteLength).toBe(recordBuf.byteLength);
    expect(new DataView(mapBuf).getFloat32(SCALAR_UNIFORM_HEADER_BYTES, true)).toBe(
      new DataView(recordBuf).getFloat32(SCALAR_UNIFORM_HEADER_BYTES, true),
    );
  });

  it('writes nothing to the 16-byte header (always zero)', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'x', wgslName: 'x', dtype: 'f32' },
    ];
    const buf = packScalarUniformBuffer(bindings, { x: 99 });
    const view = new DataView(buf);
    expect(view.getUint32(0, true)).toBe(0);
    expect(view.getUint32(4, true)).toBe(0);
    expect(view.getUint32(8, true)).toBe(0);
    expect(view.getUint32(12, true)).toBe(0);
  });
});

describe('scalarUniformBufferSize', () => {
  it('returns just the header when bindings is empty', () => {
    expect(scalarUniformBufferSize([])).toBe(SCALAR_UNIFORM_HEADER_BYTES);
  });

  it('matches header + bindings.length * stride', () => {
    const bindings = Array.from({ length: 5 }, (_, i) => ({
      name: `x${i}`,
      wgslName: `x${i}`,
      dtype: 'f32' as const,
    }));
    const expected =
      SCALAR_UNIFORM_HEADER_BYTES + 5 * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
    expect(scalarUniformBufferSize(bindings)).toBe(expected);
  });
});

describe('readScalarUniformBuffer (round-trip)', () => {
  it('round-trips f32 values', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'x', wgslName: 'x', dtype: 'f32' },
      { name: 'y', wgslName: 'y', dtype: 'f32' },
    ];
    const buf = packScalarUniformBuffer(bindings, { x: 1.5, y: -2.25 });
    expect(readScalarUniformBuffer(buf, bindings, 0)).toBe(1.5);
    expect(readScalarUniformBuffer(buf, bindings, 1)).toBe(-2.25);
  });

  it('round-trips i32 values', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'i', wgslName: 'i', dtype: 'i32' },
    ];
    const buf = packScalarUniformBuffer(bindings, { i: 42 });
    expect(readScalarUniformBuffer(buf, bindings, 0)).toBe(42);
  });

  it('returns 0 for out-of-range indices', () => {
    const bindings: ScalarUniformBinding[] = [
      { name: 'x', wgslName: 'x', dtype: 'f32' },
    ];
    const buf = packScalarUniformBuffer(bindings, { x: 1 });
    expect(readScalarUniformBuffer(buf, bindings, -1)).toBe(0);
    expect(readScalarUniformBuffer(buf, bindings, 1)).toBe(0);
    expect(readScalarUniformBuffer(buf, bindings, 99)).toBe(0);
  });

  it('returns 0 when bindings is empty', () => {
    const buf = packScalarUniformBuffer([], {});
    expect(readScalarUniformBuffer(buf, [], 0)).toBe(0);
  });
});
