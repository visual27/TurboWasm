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
 * Pack scalar binding values into a 16-byte-aligned uniform buffer.
 *
 * Layout: `[16-byte header] [16-byte f32/i32 field 0] [16-byte field 1] ...`
 *
 * Returns the bytes via an `ArrayBuffer`. Caller is responsible for
 * uploading via `device.queue.writeBuffer`.
 *
 * `values` is keyed by scratch global variable name (= `ScalarUniformBinding.name`).
 * Missing entries are written as 0 (= runtime fallback contract).
 */
export function packScalarUniformBuffer(
  bindings: readonly ScalarUniformBinding[],
  values: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): ArrayBuffer {
  const size =
    SCALAR_UNIFORM_HEADER_BYTES + bindings.length * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const get = (key: string): number => {
    if (values instanceof Map) return values.get(key) ?? 0;
    return (values as Record<string, number>)[key] ?? 0;
  };
  for (let i = 0; i < bindings.length; i += 1) {
    const binding = bindings[i];
    if (!binding) continue;
    const offset = SCALAR_UNIFORM_HEADER_BYTES + i * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
    const value = get(binding.name);
    if (binding.dtype === 'i32') {
      view.setInt32(offset, Math.trunc(value) | 0, true);
    } else {
      view.setFloat32(offset, value, true);
    }
    // Remaining 12 bytes per field are left as 0 (WGSL uniform buffer
    // alignment padding).
  }
  return buffer;
}

/**
 * Compute the size (in bytes) required to hold `bindings.length` scalars
 * with the standard 16-byte header + 16-byte stride layout. Useful for
 * pre-allocating the GPU buffer.
 */
export function scalarUniformBufferSize(bindings: readonly ScalarUniformBinding[]): number {
  return SCALAR_UNIFORM_HEADER_BYTES + bindings.length * SCALAR_UNIFORM_FIELD_STRIDE_BYTES;
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
