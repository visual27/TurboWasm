export function scratchCompatHeader(): string {
  return `// WGSL numeric comparisons involving NaN are ordered; Scratch Cast.compare string coercion is outside this numeric subset.
fn scratch_div(a: f32, b: f32) -> f32 {
  let q = a / b;
  return q;
}

fn scratch_mod(n: f32, m: f32) -> f32 {
  let q = floor(n / m);
  return n - q * m;
}

fn scratch_index_clamp(idx: f32, len: u32) -> f32 {
  if (idx < 1.0 || idx > f32(len)) {
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

fn scratch_list_write_f32(buf_idx: ptr<storage, array<f32>, read_write>, idx: f32, len: u32, value: f32) {
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
  if (idx < 1 || idx > len) return -1;
  return idx;
}

export function jsScratchBool(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x !== 0 ? 1 : 0;
}
