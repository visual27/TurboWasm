import { describe, expect, it, beforeEach, vi } from 'vitest';

const fakeResvgInstances: Array<{ svg: string; options: unknown; render: () => unknown }> = [];

vi.mock('@resvg/resvg-wasm', () => {
  class FakeResvg {
    public svg: string;
    public options: unknown;
    public freed = false;
    public constructor(svg: string, options: unknown) {
      this.svg = svg;
      this.options = options;
      const inst = { svg, options, render: () => this.render() };
      fakeResvgInstances.push(inst);
    }
    public render(): { width: number; height: number; pixels: Uint8Array; free(): void } {
      const pixels = new Uint8Array(this.svg.length * 4 + 4);
      // Mark a few alpha samples so the cache key is observable.
      for (let i = 0; i < pixels.length; i += 1) {
        pixels[i] = (i * 7 + 13) & 0xff;
      }
      return {
        width: this.svg.length,
        height: 1,
        pixels,
        free: () => {
          this.freed = true;
        },
      };
    }
    public free(): void {
      this.freed = true;
    }
  }
  return {
    initWasm: vi.fn(async () => undefined),
    Resvg: FakeResvg,
  };
});

vi.mock('@resvg/resvg-wasm/index_bg.wasm?url', () => ({
  default: 'data:application/wasm;base64,',
}));

import {
  initSvgRaster,
  isSvgRasterReady,
  rasterizeSvgToImageData,
  resetSvgRasterForTesting,
} from '@/runtime/tw-wasm/svg-raster';
import {
  attachSvgRasterHook,
  detachSvgRasterHook,
  createSvgRasterHook,
} from '@/runtime/tw-wasm/svg-raster-host';

describe('svg-raster', () => {
  beforeEach(() => {
    fakeResvgInstances.length = 0;
    resetSvgRasterForTesting();
  });

  it('is not ready until initSvgRaster resolves', async () => {
    expect(isSvgRasterReady()).toBe(false);
    await initSvgRaster();
    expect(isSvgRasterReady()).toBe(true);
  });

  it('rasterizes a small SVG into a RasterizedSvg with width/height/data', async () => {
    await initSvgRaster();
    const svg = '<svg viewBox="0 0 4 4"/>';
    const result = rasterizeSvgToImageData(svg, 4);
    expect(result).not.toBeNull();
    // The fake Resvg mock returns width=svg.length so we use that here.
    expect(result?.width).toBe(svg.length);
    expect(result?.height).toBe(1);
    expect(result?.data).toBeInstanceOf(Uint8ClampedArray);
    // data.length matches the rendered RGBA buffer; the mock pads it.
    expect(result?.data.length).toBeGreaterThanOrEqual(svg.length * 4);
  });

  it('returns null for empty / non-string SVG inputs', async () => {
    await initSvgRaster();
    expect(rasterizeSvgToImageData('', 10)).toBeNull();
    // @ts-expect-error — exercising the runtime guard
    expect(rasterizeSvgToImageData(null, 10)).toBeNull();
    // @ts-expect-error — exercising the runtime guard
    expect(rasterizeSvgToImageData(undefined, 10)).toBeNull();
  });

  it('returns null for non-positive target widths', async () => {
    await initSvgRaster();
    expect(rasterizeSvgToImageData('<svg/>', 0)).toBeNull();
    expect(rasterizeSvgToImageData('<svg/>', -10)).toBeNull();
    expect(rasterizeSvgToImageData('<svg/>', Number.NaN)).toBeNull();
  });

  it('caches rasterization results by svgString+targetWidth', async () => {
    await initSvgRaster();
    const svg = '<svg/>abc';
    const a = rasterizeSvgToImageData(svg, 10);
    const b = rasterizeSvgToImageData(svg, 10);
    expect(a).toBe(b);
    expect(fakeResvgInstances.length).toBe(1);
    // Different targetWidth → new entry
    const c = rasterizeSvgToImageData(svg, 20);
    expect(c).not.toBe(b);
    expect(fakeResvgInstances.length).toBe(2);
  });

  it('returns null when resvg-wasm has not been initialised', () => {
    // Don't call initSvgRaster() in this test.
    expect(rasterizeSvgToImageData('<svg/>', 10)).toBeNull();
  });
});

describe('svg-raster-host', () => {
  beforeEach(() => {
    resetSvgRasterForTesting();
  });

  it('attaches the hook to a renderer-like object', async () => {
    await initSvgRaster();
    const renderer: { _twWasmRasterSvgCostume?: unknown } = {};
    const hook = createSvgRasterHook();
    attachSvgRasterHook(renderer, hook);
    expect(renderer._twWasmRasterSvgCostume).toBe(hook);
  });

  it('detaches the hook when requested', async () => {
    await initSvgRaster();
    const renderer: { _twWasmRasterSvgCostume?: unknown } = {};
    const hook = createSvgRasterHook();
    attachSvgRasterHook(renderer, hook);
    detachSvgRasterHook(renderer);
    expect('_twWasmRasterSvgCostume' in renderer).toBe(false);
  });

  it('does nothing when given a non-object target', () => {
    expect(() => attachSvgRasterHook(null, createSvgRasterHook())).not.toThrow();
    expect(() => detachSvgRasterHook(undefined)).not.toThrow();
    expect(() => attachSvgRasterHook(42 as unknown as object, createSvgRasterHook())).not.toThrow();
  });

  it('reports isReady() false before init', () => {
    expect(createSvgRasterHook().isReady()).toBe(false);
  });

  it('rasterize delegates to svg-raster.ts', async () => {
    await initSvgRaster();
    const svg = '<svg>X</svg>';
    const result = createSvgRasterHook().rasterize(svg, 5);
    expect(result).not.toBeNull();
    expect(result?.width).toBe(svg.length);
  });
});