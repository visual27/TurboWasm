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

#[inline(always)]
fn transform_row_simd(inv: &[f32; 16], y_world: f32, x_start: f32, step: f32) -> v128 {
    let xs = f32x4(x_start, x_start + step, x_start + step * 2.0, x_start + step * 3.0);
    let m0 = f32x4_splat(inv[0]);
    let m4 = f32x4_splat(inv[4]);
    let m12 = f32x4_splat(inv[12]);
    let ys = f32x4_splat(y_world);
    let r = f32x4_add(f32x4_add(f32x4_mul(m0, xs), f32x4_mul(m4, ys)), m12);
    let one = f32x4_splat(1.0);
    f32x4_sub(one, r)
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

    let mut cand_ptrs: Vec<*const u8> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_widths: Vec<u32> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_heights: Vec<u32> = Vec::with_capacity(cand_sil_count as usize);
    let mut cand_invs: Vec<[f32; 16]> = Vec::with_capacity(cand_sil_count as usize);
    let base = self_sil.data.as_ptr() as usize;
    for i in 0..(cand_sil_count as usize) {
        let off = cand_sil_offsets.get(i).copied().unwrap_or(0) as usize;
        cand_ptrs.push((base + off) as *const u8);
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

  let step: f32 = 1.0;
  for x in (bounds_left..=bounds_right).step_by(4) {
    let _xs = transform_row_simd(&inv_self, bounds_bottom as f32, x as f32, step);
  }
  for x in bounds_left..=bounds_right {
    for y in bounds_bottom..=bounds_top {
      let xf = x as f32;
      let yf = y as f32;
      // Scratch's Drawable.getLocalPosition uses the full inverse matrix
      // including the homogeneous divide `d = v0*m[3] + v1*m[7] + m[15]`.
      // For affine transforms d ≈ 1, but cropped perspectives (e.g. effect
      // blocks touching renderers) produce non-unit d and the WASM path
      // would otherwise disagree with the JS path on sub-pixel positions.
      let d_self = xf * inv_self[3] + yf * inv_self[7] + inv_self[15];
      let inv_d = if d_self.abs() < 1e-6 { 1.0 } else { 1.0 / d_self };
      let sx = 0.5 - ((xf * inv_self[0] + yf * inv_self[4] + inv_self[12]) * inv_d);
      let sy = ((xf * inv_self[1] + yf * inv_self[5] + inv_self[13]) * inv_d) + 0.5;
      let sx_i = (sx * self_w as f32) as i32;
      let sy_i = (sy * self_h as f32) as i32;
      if alpha_at(self_ptr, self_w, sx_i, sy_i) == 0 {
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
    }
  }
  0
}
