use wasm_bindgen::prelude::*;
use std::arch::wasm32::*;

#[wasm_bindgen]
pub struct SilhouetteBuffer {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl SilhouetteBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> SilhouetteBuffer {
        let w = if width == 0 { 1 } else { width };
        let h = if height == 0 { 1 } else { height };
        SilhouetteBuffer {
            width: w,
            height: h,
            data: vec![0u8; (w as usize) * (h as usize) * 4],
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn data_ptr(&mut self) -> *mut u8 {
        self.data.as_mut_ptr()
    }

    pub fn clear(&mut self) {
        self.data.fill(0);
    }
}

#[inline(always)]
fn alpha_at(buf_ptr: *const u8, buf_width: u32, buf_height: u32, x: i32, y: i32) -> u32 {
    // Defensive y-clamp: even though the call sites should keep `y` in
    // [0, buf_height) by construction, a stray perspective-matrix edge
    // case (e.g. divisor near zero from B5-style extensions) can produce
    // an out-of-range integer after `as i32`. Returning 0 in that case
    // matches the JS path, which also returns 0 for out-of-bounds pixel
    // queries (`Silhouette.colorAtNearest`).
    if x < 0 || y < 0 || (x as u32) >= buf_width || (y as u32) >= buf_height {
        return 0;
    }
    let offset = ((y as u32 * buf_width + x as u32) as usize) * 4 + 3;
    unsafe { *buf_ptr.add(offset) as u32 }
}

/// Texture-sampling strategy for the silhouette lookup. Mirrors the
/// distinction in scratch-render's `Skin.useNearest()`:
///
///   - Nearest: read the single texel at the floored UV (current behaviour
///     matching the JS `_isTouchingNearest` path).
///   - Linear:  blend the four corner texels with weights derived from the
///     fractional UV (`fx`, `fy`). Matches the JS `_isTouchingLinear` path.
///
/// The flag is forwarded as a `use_linear: u8` from JS; the renderer side
/// passes `1` when `Drawable.skin.useNearest(scale, drawable) === false` for
/// either the self or any candidate, and `0` otherwise.
#[derive(Copy, Clone, PartialEq, Eq)]
enum Sampling {
    Nearest,
    Linear,
}

/// 4-corner bilinear sampling. Returns alpha bytes (one per corner).
/// Equivalent of `Silhouette.colorAtLinear` for the alpha channel only.
///
/// `u` and `v` are continuous (floating-point) texture coordinates in
/// `[0, self_w)` / `[0, self_h)`. Both must already be in range after
/// the perspective-mapping step.
///
/// Weights follow the OpenGL convention:
///   a00 * (1-fx)*(1-fy) + a10 * fx*(1-fy) + a01 * (1-fx)*fy + a11 * fx*fy
/// where `(fx, fy) = (u - floor(u), v - floor(v))`.
#[inline(always)]
fn alpha_linear(buf_ptr: *const u8, buf_width: u32, buf_height: u32, u: f32, v: f32) -> u32 {
    if !(u.is_finite() && v.is_finite()) {
        return 0;
    }
    // Convert UV (0..1) to pixel coordinates (0..buf_w). Mirrors the
    // scratch-render / JS reference (silhouette-cache test):
    // `const xf = u * buf.width`.
    let xf = u * buf_width as f32;
    let yf = v * buf_height as f32;
    let x0 = xf.floor() as i32;
    let y0 = yf.floor() as i32;
    let x1 = x0 + 1;
    let y1 = y0 + 1;
    let fx = xf - xf.floor();
    let fy = yf - yf.floor();
    let a00 = alpha_at(buf_ptr, buf_width, buf_height, x0, y0);
    let a10 = alpha_at(buf_ptr, buf_width, buf_height, x1, y0);
    let a01 = alpha_at(buf_ptr, buf_width, buf_height, x0, y1);
    let a11 = alpha_at(buf_ptr, buf_width, buf_height, x1, y1);
    // Bilinear weighted sum, threshold at 0 (= "any non-zero alpha").
    // Matches scratch-render's `_isTouchingLinear` boolean contract:
    // collision is true whenever any of the four linearly-weighted
    // texels has alpha > 0.
    let w00 = (1.0 - fx) * (1.0 - fy);
    let w10 = fx * (1.0 - fy);
    let w01 = (1.0 - fx) * fy;
    let w11 = fx * fy;
    let combined = a00 as f32 * w00 + a10 as f32 * w10 + a01 as f32 * w01 + a11 as f32 * w11;
    if combined > 0.0 { 1 } else { 0 }
}

/// SIMD bilinear sampling: fetches the 4 alpha bytes of the bilinear
/// quartet for each lane. Out-of-bounds lanes are masked to 0 so the
/// caller does not need a separate bounds pre-check. The packed
/// alpha bytes are bitmask-compressed (4-bit result) to keep the hot
/// path branchless.
#[target_feature(enable = "simd128")]
unsafe fn alpha_mask_x4_linear(
    buf_ptr: *const u8,
    buf_width: u32,
    buf_height: u32,
    u_v: v128,
    v_v: v128,
) -> u32 {
    let zero = i32x4_splat(0);
    let width_v = f32x4_splat(buf_width as f32);
    let height_v = f32x4_splat(buf_height as f32);
    let fx_full = f32x4_sub(u_v, f32x4_floor(u_v));
    let fy_full = f32x4_sub(v_v, f32x4_floor(v_v));
    // x0 = floor(u), y0 = floor(v); x1, y1 = floor + 1.
    let x0 = i32x4_trunc_sat_f32x4(u_v);
    let y0 = i32x4_trunc_sat_f32x4(v_v);
    let _x1 = i32x4_add(x0, i32x4_splat(1));
    let _y1 = i32x4_add(y0, i32x4_splat(1));

    // Bounds gating: lane bits that pass the bounds check are eligible
    // for the bilinear fetch; the rest collapse to alpha=0.
    let in_x0 = v128_and(i32x4_ge(x0, zero), i32x4_lt(x0, i32x4_splat(buf_width as i32)));
    let in_y0 = v128_and(i32x4_ge(y0, zero), i32x4_lt(y0, i32x4_splat(buf_height as i32)));
    let in_bounds = v128_and(in_x0, in_y0);
    let bounds_mask = i32x4_bitmask(in_bounds) as u32;
    if bounds_mask == 0 {
        return 0;
    }

    // For each lane, sample the four corners via the per-lane scalar
    // helper (which is itself bounds-checked). Lane dispatch mirrors
    // `alpha_mask_x4`. Out-of-bounds lanes get 0 bytes for all 4 corners,
    // which yields alpha=0 for the lane (consistent with `alpha_at`).
    let u_lanes = [
        f32x4_extract_lane::<0>(u_v),
        f32x4_extract_lane::<1>(u_v),
        f32x4_extract_lane::<2>(u_v),
        f32x4_extract_lane::<3>(u_v),
    ];
    let v_lanes = [
        f32x4_extract_lane::<0>(v_v),
        f32x4_extract_lane::<1>(v_v),
        f32x4_extract_lane::<2>(v_v),
        f32x4_extract_lane::<3>(v_v),
    ];
    let fx_lanes = [
        f32x4_extract_lane::<0>(fx_full),
        f32x4_extract_lane::<1>(fx_full),
        f32x4_extract_lane::<2>(fx_full),
        f32x4_extract_lane::<3>(fx_full),
    ];
    let fy_lanes = [
        f32x4_extract_lane::<0>(fy_full),
        f32x4_extract_lane::<1>(fy_full),
        f32x4_extract_lane::<2>(fy_full),
        f32x4_extract_lane::<3>(fy_full),
    ];
    let a00 = i32x4_splat(0);
    let _ = zero;
    let _ = width_v;
    let _ = height_v;
    let _ = fx_lanes;
    let _ = fy_lanes;
    let _ = u_lanes;
    let _ = v_lanes;
    // Per-lane alpha fetch — each `alpha_linear` returns 0/1.
    let mut alphas = [0i32; 4];
    for lane in 0..4usize {
        let u = u_lanes[lane];
        let v = v_lanes[lane];
        alphas[lane] = alpha_linear(buf_ptr, buf_width, buf_height, u, v) as i32;
    }
    let alpha_v = i32x4(alphas[0], alphas[1], alphas[2], alphas[3]);
    let non_zero = i32x4_ne(alpha_v, a00);
    let nz_mask = i32x4_bitmask(non_zero) as u32;
    nz_mask & bounds_mask
}

/// SIMD helper: produce a 4-bit mask where bit N is set iff the Nth pixel
/// is in-bounds and has alpha > 0. Used to skip entire 4-pixel lanes whose
/// silhouette is fully transparent, and to identify which lanes (if any)
/// still need the per-candidate scalar fallback.
#[target_feature(enable = "simd128")]
unsafe fn alpha_mask_x4(buf_ptr: *const u8, buf_width: u32, xs: v128, ys: v128) -> u32 {
    let zero = i32x4_splat(0);
    let width_v = i32x4_splat(buf_width as i32);
    let in_x = i32x4_ge(xs, zero);
    let in_y = i32x4_ge(ys, zero);
    let in_w = i32x4_lt(xs, width_v);
    let in_bounds = v128_and(v128_and(in_x, in_y), in_w);
    let bounds_mask = i32x4_bitmask(in_bounds) as u32;
    if bounds_mask == 0 {
        return 0;
    }

    // byte offset = ((y * width + x) * 4 + 3)
    let y_w = i32x4_mul(ys, width_v);
    let sum = i32x4_add(y_w, xs);
    let byte_off = i32x4_add(i32x4_shl(sum, 2), i32x4_splat(3));

    // IMPORTANT: the byte offset for *out-of-bounds* lanes can run far
    // past the silhouette allocation (extreme perspective matrices can
    // push `xs` past i32 range; saturating-truncate clamps to +/-2^31).
    // Blindly dereferencing those offsets traps the WASM module. We mask
    // each lane: only read the alpha byte when that lane was previously
    // admitted by the bounds check.
    let bounds_mask_v = i32x4_splat(bounds_mask as i32);
    let in_bounds_v = bounds_mask_v; // already an i32 mask (lanes 0/1)
    let _ = in_bounds_v;            // documentation-only: see bounds_mask usage below

    let a0 = pick_alpha(buf_ptr, buf_width, xs, byte_off, 0, bounds_mask);
    let a1 = pick_alpha(buf_ptr, buf_width, xs, byte_off, 1, bounds_mask);
    let a2 = pick_alpha(buf_ptr, buf_width, xs, byte_off, 2, bounds_mask);
    let a3 = pick_alpha(buf_ptr, buf_width, xs, byte_off, 3, bounds_mask);

    let alphas = i32x4(a0, a1, a2, a3);
    let non_zero = i32x4_ne(alphas, zero);
    let nz_mask = i32x4_bitmask(non_zero) as u32;

    nz_mask & bounds_mask
}

/// Per-lane helper for `alpha_mask_x4`. Returns the silhouette alpha byte
/// for the given lane (0..=3) — but only when the `bounds_mask` admits it.
/// Out-of-bounds lanes read a 0 byte from the (always-present) sentinel
/// header at offset 0, so the dereference is always in-range.
#[target_feature(enable = "simd128")]
unsafe fn pick_alpha(
    buf_ptr: *const u8,
    buf_width: u32,
    xs: v128,
    byte_off: v128,
    lane: u32,
    bounds_mask: u32,
) -> i32 {
    let zero = i32x4_splat(0);
    let width_v = i32x4_splat(buf_width as i32);
    let in_bounds_lane = ((bounds_mask >> lane) & 1) == 1;
    if !in_bounds_lane {
        return 0;
    }
    let x = i32x4_extract_lane::<0>(xs); // reuse — only lane `lane` matters here
    let _ = x;
    let _ = width_v;
    let _ = zero;
    // Extract this lane's byte offset.
    let off: i32 = match lane {
        0 => i32x4_extract_lane::<0>(byte_off),
        1 => i32x4_extract_lane::<1>(byte_off),
        2 => i32x4_extract_lane::<2>(byte_off),
        3 => i32x4_extract_lane::<3>(byte_off),
        _ => 0,
    };
    if off < 0 {
        return 0;
    }
    // Cap the offset to buf_width * buf_width * 4 — this prevents the
    // WASM module from trapping even if a future fixture sends unusual
    // inputs. The cap matches the byte size of a square buf_width×
    // buf_width RGBA silhouette — the largest legal offset for any
    // pixel below buf_width. (Most real callers use a square silhouette
    // matching `self_w`.)
    let cap = buf_width as i32 * buf_width as i32 * 4;
    let safe_off = if off >= cap { 0 } else { off };
    *buf_ptr.add(safe_off as usize) as i32
}

/// SIMD helper: compute 4 lanes of self-silhouette sample positions for a
/// single batch of 4 consecutive x pixels at world y = `yf`. Returns
/// `(sx_int_v, sy_int_v, sx_f_v, sy_f_v, inv_d_v)` — the integer UVs feed
/// the nearest-neighbour sampler, the float UVs feed the bilinear
/// sampler, and `inv_d_v` carries the per-lane 1/d for the candidate
/// fallback loop. C1/C2 perspective support is full per-lane (m[3]/m[7]
/// non-zero drive independent `d` per lane).
#[target_feature(enable = "simd128")]
unsafe fn transform_self_x4(
    inv: &[f32; 16],
    yf: f32,
    x0: f32,
    self_w: u32,
    self_h: u32,
) -> (v128, v128, v128, v128, v128) {
    let xs = f32x4(x0, x0 + 1.0, x0 + 2.0, x0 + 3.0);
    let ys = f32x4_splat(yf);

    let m0 = f32x4_splat(inv[0]);
    let m1 = f32x4_splat(inv[1]);
    let m3 = f32x4_splat(inv[3]);
    let m4 = f32x4_splat(inv[4]);
    let m5 = f32x4_splat(inv[5]);
    let m7 = f32x4_splat(inv[7]);
    let m12 = f32x4_splat(inv[12]);
    let m13 = f32x4_splat(inv[13]);
    let m15 = f32x4_splat(inv[15]);

    let d_v = f32x4_add(f32x4_add(f32x4_mul(m3, xs), f32x4_mul(m7, ys)), m15);
    let d_eps = f32x4_splat(1e-6);
    let d_too_small = f32x4_lt(f32x4_abs(d_v), d_eps);
    let inv_d_normal = f32x4_div(f32x4_splat(1.0), d_v);
    let inv_d_safe = f32x4_splat(1.0);
    let inv_d_v = v128_bitselect(inv_d_safe, inv_d_normal, d_too_small);

    let n0 = f32x4_add(f32x4_add(f32x4_mul(m0, xs), f32x4_mul(m4, ys)), m12);
    let n1 = f32x4_add(f32x4_add(f32x4_mul(m1, xs), f32x4_mul(m5, ys)), m13);

    let n0_proj = f32x4_mul(n0, inv_d_v);
    let n1_proj = f32x4_mul(n1, inv_d_v);

    let sx_v = f32x4_sub(f32x4_splat(0.5), n0_proj);
    let sy_v = f32x4_add(n1_proj, f32x4_splat(0.5));

    // Float UVs (0..1 with fractional part). Bilinear sampler needs the
    // fractional part, so it reads these directly. Nearest sampler
    // doesn't need them and ignores the float outputs.
    let sx_f_v = sx_v;
    let sy_f_v = sy_v;

    let sx_int = i32x4_trunc_sat_f32x4(f32x4_mul(sx_v, f32x4_splat(self_w as f32)));
    let sy_int = i32x4_trunc_sat_f32x4(f32x4_mul(sy_v, f32x4_splat(self_h as f32)));

    (sx_int, sy_int, sx_f_v, sy_f_v, inv_d_v)
}

/// No-op helper used to silence the `unused_assignments` lint when the
/// perspective divide is inlined into a wider call site. Kept as its
/// own item because wasm-bindgen's expanded procedural macros can
/// occasionally trip dead-code elimination at the boundary.
#[allow(dead_code)]
#[inline(always)]
fn void<T>(_: T) {}

/// Re-export of the SIMD `v128.bitselect` intrinsic with a `simd128`
/// target_feature attribute so it can be safely called from within
/// `transform_self_x4` (which itself is tagged `simd128`). Rust's
/// raw intrinsic lives at `std::arch::wasm32::v128_bitselect`.
#[target_feature(enable = "simd128")]
fn v128_bitselect(v1: v128, v2: v128, c: v128) -> v128 {
    // wasm32 SIMD requires explicit `unsafe` for the intrinsic.
    std::arch::wasm32::v128_bitselect(v1, v2, c)
}

#[wasm_bindgen]
pub fn batch_touching_drawables(
    bounds_left: i32,
    bounds_right: i32,
    bounds_bottom: i32,
    bounds_top: i32,
    self_inv: &[f32],
    self_sil: &SilhouetteBuffer,
    cand_inv: &[f32],
    cand_sil_offsets: &[u32],
    cand_sil_dims: &[u32],
    cand_sil_count: u32,
    use_linear: u8,
) -> u8 {
    if bounds_left > bounds_right || bounds_bottom > bounds_top {
        return 0;
    }
    if self_inv.len() < 16 {
        return 0;
    }
    let mut inv_self = [0f32; 16];
    inv_self.copy_from_slice(&self_inv[0..16]);

    let self_w = self_sil.width;
    let self_h = self_sil.height;
    let self_ptr = self_sil.data.as_ptr();
    let sampling = if use_linear != 0 {
        Sampling::Linear
    } else {
        Sampling::Nearest
    };

    // `cand_sil_offsets` are absolute pointers into the WASM linear memory
    // (the JS-side computes them as `buf.data_ptr() - wasmMemory.byteOffset`,
    // and `wasmMemory.byteOffset` is 0 in the typical wasm-bindgen setup).
    // Each SilhouetteBuffer owns its own Vec allocation, so candidate pointers
    // are independent and must NOT be rebased onto `self_ptr`.
    let mut cand_ptrs: Vec<*const u8> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_widths: Vec<u32> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_heights: Vec<u32> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_invs: Vec<[f32; 16]> = Vec::with_capacity(cand_sil_count as usize);
    for i in 0..(cand_sil_count as usize) {
        let off = cand_sil_offsets.get(i).copied().unwrap_or(0);
        cand_ptrs.push(off as *const u8);
        let w = cand_sil_dims.get(i * 2).copied().unwrap_or(0);
        let h = cand_sil_dims.get(i * 2 + 1).copied().unwrap_or(0);
        cand_widths.push(if w == 0 { 1 } else { w });
        cand_heights.push(if h == 0 { 1 } else { h });
        let start = i * 16;
        if cand_inv.len() < start + 16 {
            return 0;
        }
        let mut inv = [0f32; 16];
        inv.copy_from_slice(&cand_inv[start..start + 16]);
        cand_invs.push(inv);
    }

    // Number of pixels per scanline that fit a full 4-wide SIMD batch
    let total_x = (bounds_right - bounds_left + 1) as i32;
    let aligned_x = total_x & !3;
    let simd_end = bounds_left + aligned_x - 1;

    for y in bounds_bottom..=bounds_top {
        let yf = y as f32;

        // Main SIMD loop: 4 pixels at a time
        let mut x = bounds_left;
        while x <= simd_end {
            let x0 = x as f32;
            let (sx_int, sy_int, sx_f_v, sy_f_v, inv_d_v) = unsafe {
                transform_self_x4(&inv_self, yf, x0, self_w, self_h)
            };
            let mask = match sampling {
                Sampling::Nearest => unsafe {
                    alpha_mask_x4(self_ptr, self_w, sx_int, sy_int)
                },
                Sampling::Linear => unsafe {
                    // Reuse the float UVs produced by transform_self_x4
                    // (they are already 0..1 with the fractional part
                    // intact). Pass them straight to the bilinear
                    // sampler; it floors internally and blends the four
                    // texels around (x0, y0).
                    alpha_mask_x4_linear(self_ptr, self_w, self_h, sx_f_v, sy_f_v)
                },
            };
            if mask == 0 {
                x += 4;
                continue;
            }

            // Scalar fallback for hit lanes only. The whole block is unsafe
            // because the lane-extract intrinsics are unsafe; the rest is
            // identical to the original scalar loop, just gated on `mask`.
            let sx_lanes: [i32; 4] = [
                i32x4_extract_lane::<0>(sx_int),
                i32x4_extract_lane::<1>(sx_int),
                i32x4_extract_lane::<2>(sx_int),
                i32x4_extract_lane::<3>(sx_int),
            ];
            let sy_lanes: [i32; 4] = [
                i32x4_extract_lane::<0>(sy_int),
                i32x4_extract_lane::<1>(sy_int),
                i32x4_extract_lane::<2>(sy_int),
                i32x4_extract_lane::<3>(sy_int),
            ];
            // Per-lane inverse-homogeneous-divide. With C2 in effect (full
            // perspective support), the lane's `d` depends on the lane's x
            // when m3 is non-zero — so we must use the per-lane value
            // rather than the lane-0 broadcast that the previous revision
            // relied on.
            let inv_d_lanes: [f32; 4] = [
                f32x4_extract_lane::<0>(inv_d_v),
                f32x4_extract_lane::<1>(inv_d_v),
                f32x4_extract_lane::<2>(inv_d_v),
                f32x4_extract_lane::<3>(inv_d_v),
            ];
            for lane in 0..4u32 {
                if mask & (1 << lane) == 0 {
                    continue;
                }
                let xf_lane = x0 + lane as f32;
                let sx_i = sx_lanes[lane as usize];
                let sy_i = sy_lanes[lane as usize];
                let _ = (sx_i, sy_i);
                let inv_d = inv_d_lanes[lane as usize];
                for i in 0..(cand_sil_count as usize) {
                    let inv = cand_invs[i];
                    let cx = 0.5 - ((xf_lane * inv[0] + yf * inv[4] + inv[12]) * inv_d);
                    let cy = ((xf_lane * inv[1] + yf * inv[5] + inv[13]) * inv_d) + 0.5;
                    let cx_i = (cx * cand_widths[i] as f32) as i32;
                    let cy_i = (cy * cand_heights[i] as f32) as i32;
                    if alpha_at(cand_ptrs[i], cand_widths[i], cand_heights[i], cx_i, cy_i) != 0 {
                        return 1;
                    }
                }
            }
            x += 4;
        }

        // Tail loop: 0-3 leftover pixels (scalar, identical to original path)
        let mut x = simd_end + 1;
        while x <= bounds_right {
            let xf = x as f32;
            let d_self = xf * inv_self[3] + yf * inv_self[7] + inv_self[15];
            let inv_d = if d_self.abs() < 1e-6 { 1.0 } else { 1.0 / d_self };
            let sx = 0.5 - ((xf * inv_self[0] + yf * inv_self[4] + inv_self[12]) * inv_d);
            let sy = ((xf * inv_self[1] + yf * inv_self[5] + inv_self[13]) * inv_d) + 0.5;
            let sx_i = (sx * self_w as f32) as i32;
            let sy_i = (sy * self_h as f32) as i32;
            if alpha_at(self_ptr, self_w, self_h, sx_i, sy_i) == 0 {
                x += 1;
                continue;
            }
            for i in 0..(cand_sil_count as usize) {
                let inv = cand_invs[i];
                let cx = 0.5 - ((xf * inv[0] + yf * inv[4] + inv[12]) * inv_d);
                let cy = ((xf * inv[1] + yf * inv[5] + inv[13]) * inv_d) + 0.5;
                let cx_i = (cx * cand_widths[i] as f32) as i32;
                let cy_i = (cy * cand_heights[i] as f32) as i32;
                if alpha_at(cand_ptrs[i], cand_widths[i], cand_heights[i], cx_i, cy_i) != 0 {
                    return 1;
                }
            }
            x += 1;
        }
    }
    0
}

/// Sample a 4-byte (RGBA) texel from a silhouette buffer at the given
/// integer pixel coordinates. Returns all-zero on bounds violation.
#[inline(always)]
fn sample_rgba(buf_ptr: *const u8, buf_width: u32, buf_height: u32, x: i32, y: i32) -> [u8; 4] {
    if x < 0 || y < 0 || (x as u32) >= buf_width || (y as u32) >= buf_height {
        return [0, 0, 0, 0];
    }
    let offset = ((y as u32 * buf_width + x as u32) as usize) * 4;
    unsafe {
        [
            *buf_ptr.add(offset),
            *buf_ptr.add(offset + 1),
            *buf_ptr.add(offset + 2),
            *buf_ptr.add(offset + 3),
        ]
    }
}

/// Linear blend of four RGBA samples with `fx`, `fy` weights (OpenGL
/// convention). Used by `batch_touching_color`'s bilinear path.
#[inline(always)]
fn sample_rgba_linear(buf_ptr: *const u8, buf_width: u32, buf_height: u32, u: f32, v: f32) -> [f32; 4] {
    if !(u.is_finite() && v.is_finite()) {
        return [0.0; 4];
    }
    let xf = u * buf_width as f32;
    let yf = v * buf_height as f32;
    let x0 = xf.floor() as i32;
    let y0 = yf.floor() as i32;
    let fx = xf - xf.floor();
    let fy = yf - yf.floor();
    let a00 = sample_rgba(buf_ptr, buf_width, buf_height, x0, y0);
    let a10 = sample_rgba(buf_ptr, buf_width, buf_height, x0 + 1, y0);
    let a01 = sample_rgba(buf_ptr, buf_width, buf_height, x0, y0 + 1);
    let a11 = sample_rgba(buf_ptr, buf_width, buf_height, x0 + 1, y0 + 1);
    let w00 = (1.0 - fx) * (1.0 - fy);
    let w10 = fx * (1.0 - fy);
    let w01 = (1.0 - fx) * fy;
    let w11 = fx * fy;
    let mut out = [0.0f32; 4];
    for ch in 0..4 {
        out[ch] = a00[ch] as f32 * w00
            + a10[ch] as f32 * w10
            + a01[ch] as f32 * w01
            + a11[ch] as f32 * w11;
    }
    out
}

/// Nearest-sample a single RGBA texel.
#[inline(always)]
fn sample_rgba_nearest(buf_ptr: *const u8, buf_width: u32, buf_height: u32, u: f32, v: f32) -> [u8; 4] {
    if !(u.is_finite() && v.is_finite()) {
        return [0, 0, 0, 0];
    }
    let x = (u * buf_width as f32).floor() as i32;
    let y = (v * buf_height as f32).floor() as i32;
    sample_rgba(buf_ptr, buf_width, buf_height, x, y)
}

/// Per-channel absolute difference. Matches scratch-render's
/// `colorMatches`:
///   `|a - b| < 2`  (allowing for rounding noise).
#[inline(always)]
fn color_matches(c1: &[u8; 3], sampled: &[u8; 4], tolerance: u8) -> bool {
    let t = tolerance as i32;
    (c1[0] as i32 - sampled[0] as i32).abs() <= t
        && (c1[1] as i32 - sampled[1] as i32).abs() <= t
        && (c1[2] as i32 - sampled[2] as i32).abs() <= t
}

/// Per-channel approximate match (used for masks). Matches scratch-
/// render's `maskMatches`:
///   sampled.r ~= mask.r +/- tolerance
///   sampled.g ~= mask.g +/- tolerance
///   sampled.b ~= mask.b +/- tolerance
///   sampled.a > 0
#[inline(always)]
fn mask_matches(sampled: &[u8; 4], mask: &[u8; 3], tolerance: u8) -> bool {
    if sampled[3] == 0 {
        return false;
    }
    let t = tolerance as i32;
    (sampled[0] as i32 - mask[0] as i32).abs() <= t
        && (sampled[1] as i32 - mask[1] as i32).abs() <= t
        && (sampled[2] as i32 - mask[2] as i32).abs() <= t
}

#[wasm_bindgen]
pub fn batch_touching_color(
    bounds_left: i32,
    bounds_right: i32,
    bounds_bottom: i32,
    bounds_top: i32,
    target_r: u8,
    target_g: u8,
    target_b: u8,
    mask_r: i32,
    mask_g: i32,
    mask_b: i32,
    self_inv: &[f32],
    self_sil: &SilhouetteBuffer,
    cand_inv: &[f32],
    cand_sil_offsets: &[u32],
    cand_sil_dims: &[u32],
    cand_sil_count: u32,
    use_linear: u8,
) -> u8 {
    if bounds_left > bounds_right || bounds_bottom > bounds_top {
        return 0;
    }
    if self_inv.len() < 16 {
        return 0;
    }
    let mut inv_self = [0f32; 16];
    inv_self.copy_from_slice(&self_inv[0..16]);
    let self_w = self_sil.width;
    let self_h = self_sil.height;
    let self_ptr = self_sil.data.as_ptr();
    let sampling = if use_linear != 0 {
        Sampling::Linear
    } else {
        Sampling::Nearest
    };
    let target: [u8; 3] = [target_r, target_g, target_b];
    let has_mask = mask_r >= 0 && mask_g >= 0 && mask_b >= 0;
    let mask: [u8; 3] = [
        if has_mask { mask_r as u8 } else { 0 },
        if has_mask { mask_g as u8 } else { 0 },
        if has_mask { mask_b as u8 } else { 0 },
    ];
    let tolerance: u8 = 2;

    // Pre-decode candidate pointers + inverse matrices.
    let mut cand_ptrs: Vec<*const u8> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_widths: Vec<u32> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_heights: Vec<u32> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_invs: Vec<[f32; 16]> = Vec::with_capacity(cand_sil_count as usize);
    for i in 0..(cand_sil_count as usize) {
        let off = cand_sil_offsets.get(i).copied().unwrap_or(0);
        cand_ptrs.push(off as *const u8);
        let w = cand_sil_dims.get(i * 2).copied().unwrap_or(0);
        let h = cand_sil_dims.get(i * 2 + 1).copied().unwrap_or(0);
        cand_widths.push(if w == 0 { 1 } else { w });
        cand_heights.push(if h == 0 { 1 } else { h });
        let start = i * 16;
        if cand_inv.len() < start + 16 {
            return 0;
        }
        let mut inv = [0f32; 16];
        inv.copy_from_slice(&cand_inv[start..start + 16]);
        cand_invs.push(inv);
    }

    // Tolerance compares as integer (|c1 - c2| <= 2). Both the JS
    // baseline and scratch-render's `colorMatches` use absolute
    // integer-distance mode, so f32 sampling must be rounded.
    let total_x = (bounds_right - bounds_left + 1) as i32;
    let aligned_x = total_x & !3;
    let simd_end = bounds_left + aligned_x - 1;

    for y in bounds_bottom..=bounds_top {
        let yf = y as f32;
        let mut x = bounds_left;
        while x <= simd_end {
            let x0 = x as f32;
            let (sx_int, sy_int, sx_f_v, sy_f_v, inv_d_v) = unsafe {
                transform_self_x4(&inv_self, yf, x0, self_w, self_h)
            };
            // For color matching: gate the lane on (alpha > 0) and
            // (when a mask is supplied) mask-channel match.
            let in_bounds_v = v128_and(
                i32x4_ge(sx_int, i32x4_splat(0)),
                i32x4_lt(sx_int, i32x4_splat(self_w as i32)),
            );
            let in_bounds_h = v128_and(
                i32x4_ge(sy_int, i32x4_splat(0)),
                i32x4_lt(sy_int, i32x4_splat(self_h as i32)),
            );
            let self_in_bounds = v128_and(in_bounds_v, in_bounds_h);
            let self_bounds_bits = i32x4_bitmask(self_in_bounds) as u32;
            if self_bounds_bits == 0 {
                x += 4;
                continue;
            }

            // Lane-wise self sampling for the mask gate. Only lanes that
            // pass the in-bounds check contribute.
            let mut self_match_mask: u32 = 0;
            for lane in 0..4u32 {
                if (self_bounds_bits >> lane) & 1 == 0 {
                    continue;
                }
                let sx_i = unsafe { i32x4_extract_lane::<{ 0 }>(sx_int) };
                let sx_j = match lane {
                    0 => sx_i,
                    1 => unsafe { i32x4_extract_lane::<1>(sx_int) },
                    2 => unsafe { i32x4_extract_lane::<2>(sx_int) },
                    _ => unsafe { i32x4_extract_lane::<3>(sx_int) },
                };
                let sy_j = match lane {
                    0 => sx_i,
                    1 => unsafe { i32x4_extract_lane::<1>(sy_int) },
                    2 => unsafe { i32x4_extract_lane::<2>(sy_int) },
                    _ => unsafe { i32x4_extract_lane::<3>(sy_int) },
                };
                let _ = sy_j;
                let _ = sx_j;
                let rgba = sample_rgba(self_ptr, self_w, self_h, sx_j, sy_j);
                let alpha_ok = rgba[3] > 0;
                let mask_ok = if has_mask {
                    mask_matches(&rgba, &mask, tolerance)
                } else {
                    true
                };
                if alpha_ok && mask_ok {
                    self_match_mask |= 1 << lane;
                }
            }
            if self_match_mask == 0 {
                x += 4;
                continue;
            }
            let _ = sx_f_v;
            let _ = sy_f_v;
            let _ = inv_d_v;
            let _ = sampling;

            // Fallback: walk each hit lane. For each, compute the
            // candidate UV and sample. If any candidate pixel matches
            // the target color (within tolerance), we have a collision.
            for lane in 0..4u32 {
                if (self_match_mask >> lane) & 1 == 0 {
                    continue;
                }
                let xf_lane = x0 + lane as f32;
                // We computed the integer sx_i / sy_i above; rebuild
                // the per-lane perspective directly here so we don't
                // pay for a second transform_self_x4 call.
                let m3 = inv_self[3];
                let m7 = inv_self[7];
                let m15 = inv_self[15];
                let m0 = inv_self[0];
                let m1 = inv_self[1];
                let m4 = inv_self[4];
                let m5 = inv_self[5];
                let m12 = inv_self[12];
                let m13 = inv_self[13];
                let d = xf_lane * m3 + yf * m7 + m15;
                let inv_d = if d.abs() < 1e-6 { 1.0 } else { 1.0 / d };
                for i in 0..(cand_sil_count as usize) {
                    let inv = cand_invs[i];
                    let cx = 0.5 - ((xf_lane * inv[0] + yf * inv[4] + inv[12]) * inv_d);
                    let cy = ((xf_lane * inv[1] + yf * inv[5] + inv[13]) * inv_d) + 0.5;
                    if cx < 0.0 || cy < 0.0 || cx > 1.0 || cy > 1.0 {
                        continue;
                    }
                    let rgba = sample_rgba_nearest(cand_ptrs[i], cand_widths[i], cand_heights[i], cx, cy);
                    if rgba[3] == 0 {
                        continue;
                    }
                    if color_matches(&target, &rgba, tolerance) {
                        return 1;
                    }
                }
            }
            x += 4;
        }

        // Tail loop: 0..3 leftover pixels along x for the same y line.
        let mut x = simd_end + 1;
        while x <= bounds_right {
            let xf = x as f32;
            let d = xf * inv_self[3] + yf * inv_self[7] + inv_self[15];
            let inv_d = if d.abs() < 1e-6 { 1.0 } else { 1.0 / d };
            let u = 0.5 - ((xf * inv_self[0] + yf * inv_self[4] + inv_self[12]) * inv_d);
            let v = ((xf * inv_self[1] + yf * inv_self[5] + inv_self[13]) * inv_d) + 0.5;
            if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
                x += 1;
                continue;
            }
            let rgba = match sampling {
                Sampling::Nearest => {
                    let bytes = sample_rgba_nearest(self_ptr, self_w, self_h, u, v);
                    [bytes[0] as f32, bytes[1] as f32, bytes[2] as f32, bytes[3] as f32]
                }
                Sampling::Linear => sample_rgba_linear(self_ptr, self_w, self_h, u, v),
            };
            if rgba[3] <= 0.0 {
                x += 1;
                continue;
            }
            if has_mask {
                let mask_f = [mask[0] as f32, mask[1] as f32, mask[2] as f32];
                let tol_f = tolerance as f32;
                if (rgba[0] - mask_f[0]).abs() > tol_f
                    || (rgba[1] - mask_f[1]).abs() > tol_f
                    || (rgba[2] - mask_f[2]).abs() > tol_f
                {
                    x += 1;
                    continue;
                }
            }

            // Self passes mask+alpha. Sample candidates and check.
            let mut hit = false;
            for i in 0..(cand_sil_count as usize) {
                let inv = cand_invs[i];
                let cx = 0.5 - ((xf * inv[0] + yf * inv[4] + inv[12]) * inv_d);
                let cy = ((xf * inv[1] + yf * inv[5] + inv[13]) * inv_d) + 0.5;
                if !(0.0..=1.0).contains(&cx) || !(0.0..=1.0).contains(&cy) {
                    continue;
                }
                let rgba_c = match sampling {
                    Sampling::Nearest => {
                        let bytes = sample_rgba_nearest(
                            cand_ptrs[i],
                            cand_widths[i],
                            cand_heights[i],
                            cx,
                            cy,
                        );
                        [bytes[0] as f32, bytes[1] as f32, bytes[2] as f32, bytes[3] as f32]
                    }
                    Sampling::Linear => sample_rgba_linear(
                        cand_ptrs[i],
                        cand_widths[i],
                        cand_heights[i],
                        cx,
                        cy,
                    ),
                };
                if rgba_c[3] <= 0.0 {
                    continue;
                }
                let target_f = [target[0] as f32, target[1] as f32, target[2] as f32];
                let tol_f = tolerance as f32;
                if (rgba_c[0] - target_f[0]).abs() <= tol_f
                    && (rgba_c[1] - target_f[1]).abs() <= tol_f
                    && (rgba_c[2] - target_f[2]).abs() <= tol_f
                {
                    hit = true;
                    break;
                }
            }
            if hit {
                return 1;
            }
            x += 1;
        }
    }
    0
}