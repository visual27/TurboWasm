export interface RuntimeCapabilities {
  wasmSimd: boolean;
  webgpu: boolean;
}

const WASM_SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x26, 0x0b,
]);

interface NavigatorWithGpu {
  gpu?: {
    requestAdapter: () => Promise<unknown>;
  };
}

async function probeWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const gpu = (navigator as unknown as NavigatorWithGpu).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

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
  const [wasmSimd, webgpu] = await Promise.all([probeWasmSimd(), probeWebGpu()]);
  return { wasmSimd, webgpu };
}
