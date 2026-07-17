import { describe, expect, it, beforeEach, vi } from 'vitest';
import { detectCapabilities } from '@/runtime/tw-wasm/capabilities';

describe('detectCapabilities', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports wasmSimd=false when WebAssembly.validate returns false', async () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    const caps = await detectCapabilities();
    expect(caps.wasmSimd).toBe(false);
    // The capabilities interface no longer exposes `webgpu`: the WebGPU
    // compute tier (Phase 2) was retired when the runtime stub never
    // progressed past `requestAdapter()` probing. Verifying the shape
    // here keeps a regression test against accidental re-introduction.
    expect('webgpu' in caps).toBe(false);
  });

  it('reports wasmSimd=true when WebAssembly.validate returns true', async () => {
    vi.spyOn(WebAssembly, 'validate').mockResolvedValue(true as unknown as boolean);
    const caps = await detectCapabilities();
    expect(caps.wasmSimd).toBe(true);
  });

  it('reports wasmSimd=false when WebAssembly.validate throws', async () => {
    vi.spyOn(WebAssembly, 'validate').mockImplementation(() => {
      throw new Error('boom');
    });
    const caps = await detectCapabilities();
    expect(caps.wasmSimd).toBe(false);
  });
});