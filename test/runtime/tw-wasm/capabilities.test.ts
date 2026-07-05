import { describe, expect, it, beforeEach, vi } from 'vitest';
import { detectCapabilities } from '@/runtime/tw-wasm/capabilities';

describe('detectCapabilities', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (navigator as unknown as { gpu?: unknown }).gpu;
  });

  it('reports wasmSimd=false and webgpu=false when neither is present', async () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    const caps = await detectCapabilities();
    expect(caps.wasmSimd).toBe(false);
    expect(caps.webgpu).toBe(false);
  });

  it('reports wasmSimd=true when WebAssembly.validate returns true', async () => {
    vi.spyOn(WebAssembly, 'validate').mockResolvedValue(true as unknown as boolean);
    const caps = await detectCapabilities();
    expect(caps.wasmSimd).toBe(true);
    expect(caps.webgpu).toBe(false);
  });

  it('reports webgpu=true when navigator.gpu resolves an adapter', async () => {
    vi.spyOn(WebAssembly, 'validate').mockResolvedValue(false as unknown as boolean);
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: () => Promise.resolve({}) },
    });
    const caps = await detectCapabilities();
    expect(caps.wasmSimd).toBe(false);
    expect(caps.webgpu).toBe(true);
  });

  it('reports webgpu=false when navigator.gpu.requestAdapter throws', async () => {
    vi.spyOn(WebAssembly, 'validate').mockResolvedValue(false as unknown as boolean);
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: () => Promise.reject(new Error('boom')) },
    });
    const caps = await detectCapabilities();
    expect(caps.wasmSimd).toBe(false);
    expect(caps.webgpu).toBe(false);
  });

  it('reports webgpu=false when requestAdapter resolves falsy', async () => {
    vi.spyOn(WebAssembly, 'validate').mockResolvedValue(false as unknown as boolean);
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: () => Promise.resolve(null) },
    });
    const caps = await detectCapabilities();
    expect(caps.webgpu).toBe(false);
  });
});
