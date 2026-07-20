/**
 * §Phase 3 (nested-parallelization-04-phase3 §3.4) — scalar uniform
 * binding helpers.
 *
 * `@bind ..., scalar` ディレクティブ (= scratch global variable への
 * ポインタ) を WGSL `@group(1) @binding(0)` の uniform buffer に詰める
 * ためのヘルパー。`u_scratch.<wgsl_name>` として dispatch 直前に
 * `runtime.readScalar(name)` で同期取得した値で更新する。
 *
 * メモリ layout:
 *   - 先頭 16 bytes は padding (= WGSL uniform buffer alignment 制約と
 *     既存 list length field との buffer 上での互換性のため)
 *   - 各 scalar は 16 bytes stride (f32 / i32 値 + 12 bytes padding)
 *     で packing。Phase 4 以降で vec4 packing による最適化余地あり。
 *   - §Phase 4 (15.7) — list length field も同一の 16-byte stride で
 *     末尾に続く。WGSL struct 側の `pad: vec3<u32>` 12 bytes padding
 *     と host 側の stride がバイト一致する。
 *
 * canonical key の観点では `ScalarUniformBinding` は `internalName`
 * (`@bind "quoted name"(0) ro f32, scalar`) を持たない。これは
 * `@group(1) @binding(0)` の単一 buffer 内 field 名が surface name
 * (= hashed if quoted) で決まり、canonical key 計算 (`stripDirectiveVolatile`)
 * 側で `storageKind: 'scalar'` が保持される限り区別される。
 */
import type { BindDirective } from './types';

/**
 * Scalar uniform の binding メタデータ (= dispatch 時に GPU へ転送する
 * 単一の f32 / i32 値)。
 *
 * `name` は scratch global variable 名 (= runtime adapter lookup の
 * キー)。`wgslName` は WGSL struct field 名 (= `@bind "quoted name"(0)
 * ..., scalar` の quoted name は `internalName = __tw_<hash>` で置換済)。
 */
export interface ScalarUniformBinding {
  /** Scratch global variable name (e.g. 'aabb_idx0', 'screen_w'). */
  name: string;
  /** WGSL struct field name (e.g. 'aabb_idx0', '__tw_<hash>'). */
  wgslName: string;
  /** Scalar dtype. WGSL side uses `f32` or `i32`; `byte` is mapped to `i32`. */
  dtype: 'f32' | 'i32';
}

/**
 * §Phase 4 (15.7) — list length slot in the uniform buffer. Pure
 * metadata: `name` is the scratch list name (= `runtime.listLength` key)
 * and `wgslName` is the WGSL struct field name (= `<storage_name>_length`,
 * or the hashed `internalName` form for quoted binding names).
 */
export interface ListLengthBinding {
  /** Scratch list name (e.g. 'buff_r', 'aabb_w'). */
  name: string;
  /** WGSL struct field name (e.g. 'buff_r_length', '__tw_<hash>_length'). */
  wgslName: string;
}

/**
 * 16 bytes stride per scalar field (= WGSL uniform buffer alignment の
 * 安全な境界)。各 scalar は 4 bytes (f32 / i32) だが、struct field を
 * 単独で参照する host ABI の互換性のため 16 bytes に pad する。
 */
export const SCALAR_UNIFORM_FIELD_STRIDE_BYTES = 16;

/** Header padding bytes at the start of the uniform buffer. */
export const SCALAR_UNIFORM_HEADER_BYTES = 16;

/**
 * `@bind ..., scalar` ディレクティブから `ScalarUniformBinding[]` を構築する。
 *
 * ソートは slot 昇順 (= parser 出力順) を維持。`storageKind !== 'scalar'`
 * は完全に skip (= list binding 側に混ぜない)。
 *
 * 名前衝突 (同名の scalar binding が複数) は **後勝ち** (= 後続が上書き)
 * — WGSL struct field 名重複は WGSL compile error となるため、binding
 * 出現順で canonical な優先順位を確定する。
 */
export function createScalarUniformBindings(
  directives: readonly BindDirective[],
  renameTable: Readonly<Record<string, string>>,
): ScalarUniformBinding[] {
  const scalars: ScalarUniformBinding[] = [];
  for (const d of directives) {
    if (d.kind !== 'bind') continue;
    if (d.storageKind !== 'scalar') continue;
    const wgslName = renameTable[d.name] ?? d.name;
    // WGSL struct field は i32 / f32 のみ。`byte` は host ABI では
    // Uint8Array だが、scalar 1 値としては i32 で十分。
    const dtype: 'f32' | 'i32' =
      d.dtype === 'i32' || d.dtype === 'byte' ? 'i32' : 'f32';
    scalars.push({ name: d.name, wgslName, dtype });
  }
  return scalars;
}

/**
 * §Phase 4 (15.7) — build `ListLengthBinding[]` from list bindings
 * (`storageKind !== 'scalar'`). Each list binding emits one struct
 * field `<storage_name>_length` (= `wgslName`).
 *
 * The dispatcher (`__dispatch-kernel-sync.ts:writeScalarUniformBuffer`)
 * packs these after the scalar fields using the same 16-byte stride.
 *
 * `lengthNames` is the emitter's binding-to-emitted-WGSL-name map (e.g.
 * `buff_r` → `buff_r_length` or `__tw_<hash>_length` for quoted names).
 */
export function createListLengthBindings(
  directives: readonly BindDirective[],
  renameTable: Readonly<Record<string, string>>,
  lengthNames: ReadonlyMap<string, string>,
): ListLengthBinding[] {
  const lengths: ListLengthBinding[] = [];
  for (const d of directives) {
    if (d.kind !== 'bind') continue;
    if (d.storageKind === 'scalar') continue;
    const wgslName = lengthNames.get(d.name) ?? renameTable[d.name] ?? `${d.name}_length`;
    lengths.push({ name: d.name, wgslName });
  }
  return lengths;
}

/**
 * Pack scalar binding values (and optionally list length values) into
 * a 16-byte-aligned uniform buffer.
 *
 * Layout: `[16-byte header] [16-byte scalar field 0] ... [16-byte length field 0] ...`
 *
 * Returns the bytes via an `ArrayBuffer`. Caller is responsible for
 * uploading via `device.queue.writeBuffer`.
 *
 * `values` is keyed by scratch global variable name (= `ScalarUniformBinding.name`).
 * `lengthValues` (optional) is keyed by scratch list name (= `ListLengthBinding.name`).
 * Missing entries are written as 0 (= runtime fallback contract).
 *
 * §Phase 4 (15.7) — list length fields pack after the scalar fields
 * using the same 16-byte stride, matching the WGSL struct's
 * `pad: vec3<u32>` padding layout.
 */
export function packScalarUniformBuffer(
  bindings: readonly ScalarUniformBinding[],
  values: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  lengthBindings: readonly ListLengthBinding[] = [],
  lengthValues: ReadonlyMap<string, number> | Readonly<Record<string, number>> = new Map(),
): ArrayBuffer {
  const size = scalarUniformBufferSize(bindings, lengthBindings);
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const get = (
    src: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
    key: string,
  ): number => {
    if (src instanceof Map) return src.get(key) ?? 0;
    return (src as Record<string, number>)[key] ?? 0;
  };
  for (let i = 0; i < bindings.length; i += 1) {
    const binding = bindings[i];
    if (!binding) continue;
    const offset = SCALAR_UNIFORM_HEADER_BYTES + i * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
    const value = get(values, binding.name);
    if (binding.dtype === 'i32') {
      view.setInt32(offset, Math.trunc(value) | 0, true);
    } else {
      view.setFloat32(offset, value, true);
    }
    // Remaining 12 bytes per field are left as 0 (WGSL uniform buffer
    // alignment padding, mirrored by the WGSL `pad: vec3<u32>` field).
  }
  const lengthOffsetBase =
    SCALAR_UNIFORM_HEADER_BYTES +
    bindings.length * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
  for (let i = 0; i < lengthBindings.length; i += 1) {
    const binding = lengthBindings[i];
    if (!binding) continue;
    const offset = lengthOffsetBase + i * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
    const rawValue = get(lengthValues, binding.name);
    // List length is a non-negative integer count; round/truncate to u32.
    const u32Value = Math.max(0, Math.floor(rawValue)) >>> 0;
    view.setUint32(offset, u32Value, true);
    // 12 bytes padding left as 0.
  }
  return buffer;
}

/**
 * Compute the size (in bytes) required to hold `bindings.length` scalars
 * + `lengthBindings.length` list length fields with the standard
 * 16-byte header + 16-byte stride layout. Useful for pre-allocating the
 * GPU buffer.
 *
 * §Phase 4 (15.7) — list length fields extend the buffer after the
 * scalar fields with the same stride. When `lengthBindings` is omitted,
 * the result matches the pre-Phase-4 contract.
 */
export function scalarUniformBufferSize(
  bindings: readonly ScalarUniformBinding[] = [],
  lengthBindings: readonly ListLengthBinding[] = [],
): number {
  return (
    SCALAR_UNIFORM_HEADER_BYTES +
    (bindings.length + lengthBindings.length) * SCALAR_UNIFORM_FIELD_STRIDE_BYTES
  );
}

/**
 * Read a scalar field back from a packed buffer (host-side debug helper).
 * Inverse of `packScalarUniformBuffer`.
 */
export function readScalarUniformBuffer(
  buffer: ArrayBuffer,
  bindings: readonly ScalarUniformBinding[],
  index: number,
): number {
  if (index < 0 || index >= bindings.length) return 0;
  const binding = bindings[index];
  if (!binding) return 0;
  const view = new DataView(buffer);
  const offset = SCALAR_UNIFORM_HEADER_BYTES + index * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
  if (binding.dtype === 'i32') return view.getInt32(offset, true);
  return view.getFloat32(offset, true);
}

/**
 * §Phase 4 (15.7) — read a list length field back from a packed buffer
 * (host-side debug helper). Inverse of the list-length half of
 * `packScalarUniformBuffer`. Returns 0 when the index is out of range.
 */
export function readListLengthUniformBuffer(
  buffer: ArrayBuffer,
  lengthBindings: readonly ListLengthBinding[],
  scalarBindings: readonly ScalarUniformBinding[] = [],
  index: number,
): number {
  if (index < 0 || index >= lengthBindings.length) return 0;
  const view = new DataView(buffer);
  const offset =
    SCALAR_UNIFORM_HEADER_BYTES +
    (scalarBindings.length + index) * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
  return view.getUint32(offset, true);
}
