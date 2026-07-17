/**
 * Runtime capability snapshot. The runtime is currently a single-tier
 * acceleration layer around the WASM SIMD collision client — there is
 * no GPU compute tier to probe. The shape is kept minimal so future
 * additions can extend it without churning the call sites.
 *
 * The interface used to expose `webgpu: boolean` (probed via
 * `navigator.gpu.requestAdapter()`). The WebGPU compute tier (Phase 2
 * of the original TurboWasm plan) was retired along with its UI
 * selector — the JS-side hook always returned `null` and `force-webgpu`
 * silently fell through to WASM SIMD / JS. Removing the field keeps
 * the probe code from silently running and tells future readers there
 * is no GPU tier to consult.
 */
export interface RuntimeCapabilities {
  wasmSimd: boolean;
}

const WASM_SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x26, 0x0b,
]);

async function probeWasmSimd(): Promise<boolean> {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    return false;
  }
  try {
    return await WebAssembly.validate(WASM_SIMD_PROBE);
  } catch {
    return false;
  }
}

export async function detectCapabilities(): Promise<RuntimeCapabilities> {
  const wasmSimd = await probeWasmSimd();
  return { wasmSimd };
}