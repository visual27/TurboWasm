/**
 * WGSL helpers and their JavaScript reference implementations. The WGSL
 * helpers are emitted at the top of every @compute shader
 * (`scratchCompatHeader`). The JS helpers are the canonical test
 * reference — every GPU output must agree with the JS reference within
 * IEEE-754 tolerance (1e-6 absolute).
 *
 * # NaN handling
 *
 * WGSL numeric comparisons involving NaN are *deterministic* — every
 * comparison involving NaN evaluates to false. `scratch_bool(x)` uses
 * `x != 0.0` which is false for NaN, so `scratch_bool(NaN) === 0`. The
 * JS reference mirrors this with an explicit `Number.isNaN` check
 * because `Number(NaN) !== 0` would be true (NaN is not equal to 0).
 *
 * # List reads with NaN index
 *
 * `scratch_index_clamp` returns `-1.0` for out-of-range indices. We
 * also treat NaN as out-of-range so the subsequent
 * `scratch_list_read_*` sees `-1.0 < 1.0` and returns NaN (which
 * the rest of the pipeline coerces to 0 via `scratch_div`).
 */
export function scratchCompatHeader(): string {
  return `// WGSL NaN comparisons are deterministic-but-always-false; jsScratchBool mirrors this with Number.isNaN.
fn scratch_div(a: f32, b: f32) -> f32 {
  let q = a / b;
  return q;
}

fn scratch_mod(n: f32, m: f32) -> f32 {
  let q = floor(n / m);
  return n - q * m;
}

fn scratch_index_clamp(idx: f32, len: u32) -> f32 {
  if (idx < 1.0 || idx > f32(len) || idx != idx) {
    return -1.0;
  }
  return f32(idx);
}

fn scratch_list_read_f32(buf_idx: ptr<storage, array<f32>, read>, idx: f32, len: u32) -> f32 {
  if (idx < 1.0 || idx > f32(len) || idx != idx) {
    let zero = 0.0;
    return zero / zero;
  }
  return (*buf_idx)[u32(idx) - 1u];
}

fn scratch_list_read_i32(buf_idx: ptr<storage, array<i32>, read>, idx: f32, len: u32) -> i32 {
  if (idx < 1.0 || idx > f32(len) || idx != idx) {
    return 0;
  }
  return (*buf_idx)[u32(idx) - 1u];
}

fn scratch_list_read_u32(buf_idx: ptr<storage, array<u32>, read>, idx: f32, len: u32) -> u32 {
  if (idx < 1.0 || idx > f32(len) || idx != idx) {
    return 0u;
  }
  return (*buf_idx)[u32(idx) - 1u];
}

fn scratch_list_write_f32(buf_idx: ptr<storage, array<f32>, read_write>, idx: f32, len: u32, value: f32) {
  if (idx < 1.0 || idx > f32(len) || idx != idx) {
    return;
  }
  (*buf_idx)[u32(idx) - 1u] = value;
}

fn scratch_list_write_i32(buf_idx: ptr<storage, array<i32>, read_write>, idx: f32, len: u32, value: i32) {
  if (idx < 1.0 || idx > f32(len) || idx != idx) {
    return;
  }
  (*buf_idx)[u32(idx) - 1u] = value;
}

fn scratch_list_write_u32(buf_idx: ptr<storage, array<u32>, read_write>, idx: f32, len: u32, value: u32) {
  if (idx < 1.0 || idx > f32(len) || idx != idx) {
    return;
  }
  (*buf_idx)[u32(idx) - 1u] = value;
}

fn scratch_bool(x: f32) -> f32 {
  return select(0.0, 1.0, x != 0.0);
}`;
}

export function jsScratchDiv(a: number, b: number): number {
  return a / b;
}

export function jsScratchMod(n: number, m: number): number {
  return n - Math.floor(n / m) * m;
}

export function jsScratchIndexClamp(idx: number, len: number): number {
  if (Number.isNaN(idx)) return -1;
  if (idx < 1 || idx > len) return -1;
  return idx;
}

export function jsScratchBool(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x !== 0 ? 1 : 0;
}
