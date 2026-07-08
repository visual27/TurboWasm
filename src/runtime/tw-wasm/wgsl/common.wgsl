// TurboWasm Viewer — Phase 4 (Phase 2 compute) shared WGSL structures.
//
// Common bindings shared by every WebGPU compute / render pipeline in
// the TurboWasm acceleration pipeline. The header files in this directory
// are concatenated into a single device module by `wgsl-loader.ts`.
//
// Until Phase 2 / 3 land, this file is a placeholder; the placeholder
// has to remain a valid WGSL source (i.e. not contain syntax errors)
// because Vite will fail to bundle the raw import otherwise.

struct ScratchUniforms {
    bounds_left: i32,
    bounds_right: i32,
    bounds_bottom: i32,
    bounds_top: i32,
    width: u32,
    height: u32,
    _padding0: u32,
    _padding1: u32,
}

struct ColorTarget {
    r: f32,
    g: f32,
    b: f32,
    _padding: f32,
}

struct ColorMask {
    r: f32,
    g: f32,
    b: f32,
    enabled: u32,
}
