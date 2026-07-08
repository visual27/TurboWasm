// TurboWasm Viewer — Phase 3 (WebGPU instanced rendering) sprite shader.
// SPEC §5.3.
//
// Status: placeholder. The full instanced pipeline lands in Phase 3.
// The placeholder keeps the file as valid WGSL so Vite accepts the
// `?raw` import today.

struct InstanceData {
    model_matrix: mat4x4<f32>,
    effect_bits: u32,
    color_effect: f32,
    ghost_effect: f32,
    _padding: f32,
};

struct VertexUniforms {
    projection_matrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: VertexUniforms;
@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;
@group(1) @binding(0) var skin_texture: texture_2d<f32>;
@group(1) @binding(1) var skin_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) instance_index: u32,
};

@vertex
fn vs_main(
    @location(0) quad_pos: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @builtin(instance_index) instance_index: u32
) -> VertexOutput {
    let inst = instances[instance_index];
    let world_pos = inst.model_matrix * vec4<f32>(quad_pos, 0.0, 1.0);
    var out: VertexOutput;
    out.position = uniforms.projection_matrix * world_pos;
    out.uv = uv;
    out.instance_index = instance_index;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let inst = instances[in.instance_index];
    var color = textureSample(skin_texture, skin_sampler, in.uv);
    color.a = color.a * (1.0 - inst.ghost_effect);
    return color;
}
