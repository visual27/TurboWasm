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
fn alpha_at(buf_ptr: *const u8, buf_width: u32, x: i32, y: i32) -> u32 {
    if x < 0 || y < 0 || (x as u32) >= buf_width {
        return 0;
    }
    let offset = ((y as u32 * buf_width + x as u32) as usize) * 4 + 3;
    unsafe { *buf_ptr.add(offset) as u32 }
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

    let a0 = *buf_ptr.add(i32x4_extract_lane::<0>(byte_off) as usize) as i32;
    let a1 = *buf_ptr.add(i32x4_extract_lane::<1>(byte_off) as usize) as i32;
    let a2 = *buf_ptr.add(i32x4_extract_lane::<2>(byte_off) as usize) as i32;
    let a3 = *buf_ptr.add(i32x4_extract_lane::<3>(byte_off) as usize) as i32;

    let alphas = i32x4(a0, a1, a2, a3);
    let non_zero = i32x4_ne(alphas, zero);
    let nz_mask = i32x4_bitmask(non_zero) as u32;

    nz_mask & bounds_mask
}

/// SIMD helper: compute 4 lanes of self-silhouette sample positions for a
/// single batch of 4 consecutive x pixels at world y = `yf`. Returns
/// `(sx_int_v, sy_int_v, inv_d_scalar)` where `inv_d_scalar` is the
/// per-batch inverse homogeneous-divide (broadcast to all 4 lanes for
/// the affine-transform term, matching the JS scalar computation).
#[target_feature(enable = "simd128")]
unsafe fn transform_self_x4(
    inv: &[f32; 16],
    yf: f32,
    x0: f32,
    self_w: u32,
    self_h: u32,
) -> (v128, v128, f32) {
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

    // d_v = xf*m3 + yf*m7 + m15 (per lane for perspective, broadcast for affine)
    let d_v = f32x4_add(f32x4_add(f32x4_mul(m3, xs), f32x4_mul(m7, ys)), m15);
    // scalar inv_d derived from lane 0 (broadcast to all 4 lanes matches the
    // original per-pixel computation when m3 == m7 == 0 / m15 == 1, and stays
    // numerically equivalent for the candidate fallback)
    let d0 = f32x4_extract_lane::<0>(d_v);
    let inv_d_scalar = if d0.abs() < 1e-6 { 1.0 } else { 1.0 / d0 };
    let inv_d_v = f32x4_splat(inv_d_scalar);

    let n0 = f32x4_add(f32x4_add(f32x4_mul(m0, xs), f32x4_mul(m4, ys)), m12);
    let n1 = f32x4_add(f32x4_add(f32x4_mul(m1, xs), f32x4_mul(m5, ys)), m13);

    let sx_v = f32x4_sub(f32x4_splat(0.5), f32x4_mul(n0, inv_d_v));
    let sy_v = f32x4_add(f32x4_mul(n1, inv_d_v), f32x4_splat(0.5));

    let sx_int = i32x4_trunc_sat_f32x4(f32x4_mul(sx_v, f32x4_splat(self_w as f32)));
    let sy_int = i32x4_trunc_sat_f32x4(f32x4_mul(sy_v, f32x4_splat(self_h as f32)));

    (sx_int, sy_int, inv_d_scalar)
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
            let (sx_int, sy_int, inv_d) = unsafe {
                transform_self_x4(&inv_self, yf, x0, self_w, self_h)
            };
            let mask = unsafe { alpha_mask_x4(self_ptr, self_w, sx_int, sy_int) };
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
            for lane in 0..4u32 {
                if mask & (1 << lane) == 0 {
                    continue;
                }
                let xf_lane = x0 + lane as f32;
                let sx_i = sx_lanes[lane as usize];
                let sy_i = sy_lanes[lane as usize];
                let _ = (sx_i, sy_i);
                for i in 0..(cand_sil_count as usize) {
                    let inv = cand_invs[i];
                    let cx = 0.5 - ((xf_lane * inv[0] + yf * inv[4] + inv[12]) * inv_d);
                    let cy = ((xf_lane * inv[1] + yf * inv[5] + inv[13]) * inv_d) + 0.5;
                    let cx_i = (cx * cand_widths[i] as f32) as i32;
                    let cy_i = (cy * cand_heights[i] as f32) as i32;
                    if alpha_at(cand_ptrs[i], cand_widths[i], cx_i, cy_i) != 0 {
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
            if alpha_at(self_ptr, self_w, sx_i, sy_i) == 0 {
                x += 1;
                continue;
            }
            for i in 0..(cand_sil_count as usize) {
                let inv = cand_invs[i];
                let cx = 0.5 - ((xf * inv[0] + yf * inv[4] + inv[12]) * inv_d);
                let cy = ((xf * inv[1] + yf * inv[5] + inv[13]) * inv_d) + 0.5;
                let cx_i = (cx * cand_widths[i] as f32) as i32;
                let cy_i = (cy * cand_heights[i] as f32) as i32;
                if alpha_at(cand_ptrs[i], cand_widths[i], cx_i, cy_i) != 0 {
                    return 1;
                }
            }
            x += 1;
        }
    }
    0
}