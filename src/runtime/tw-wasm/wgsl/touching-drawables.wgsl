// TurboWasm Viewer — Phase 2 (WebGPU compute) `isTouchingDrawables`
// shader. SPEC §4.2 (drawables variant).
//
// Status: placeholder. The full implementation lands in Phase 2.

@group(0) @binding(0) var<uniform> uniforms: ScratchUniforms;
@group(0) @binding(1) var self_tex: texture_2d<f32>;
@group(0) @binding(2) var self_sampler: sampler;
@group(0) @binding(3) var<storage, read_write> result: array<atomic<u32>>;

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
    let texel = textureLoad(self_tex, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
    if (texel.a > 0.0) {
        atomicStore(&result[0], 1u);
    }
}
