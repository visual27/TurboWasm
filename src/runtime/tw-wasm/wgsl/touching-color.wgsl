// TurboWasm Viewer — Phase 2 (WebGPU compute) `isTouchingColor` shader.
//
// SPEC §4.2. Per-pixel test against the candidate silhouette texture,
// matching the scratch-render / Scaffolding `colorMatches` tolerance of
// 2 / 255 per channel. Atomic flag provides a pseudo-early-exit so we
// skip per-pixel work after the first hit.
//
// Status: placeholder. The full implementation lands in Phase 2. The
// placeholder keeps the file valid WGSL so Vite + the build pipeline
// accept it today.

@group(0) @binding(0) var<uniform> uniforms: ScratchUniforms;
@group(0) @binding(1) var<uniform> target: ColorTarget;
@group(0) @binding(2) var<uniform> mask: ColorMask;
@group(0) @binding(3) var candidate_tex: texture_2d<f32>;
@group(0) @binding(4) var candidate_sampler: sampler;
@group(0) @binding(5) var<storage, read_write> result: array<atomic<u32>>;

const TOLERANCE: f32 = 0.00784; // 2 / 255

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (atomicLoad(&result[0]) == 1u) {
        return;
    }
    let width = uniforms.width;
    let height = uniforms.height;
    if (gid.x >= width || gid.y >= height) {
        return;
    }
    let texel = textureLoad(candidate_tex, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
    if (texel.a > 0.0) {
        let diff = abs(texel.rgb - vec3<f32>(target.r, target.g, target.b));
        if (diff.r < TOLERANCE && diff.g < TOLERANCE && diff.b < TOLERANCE) {
            atomicStore(&result[0], 1u);
        }
    }
}
