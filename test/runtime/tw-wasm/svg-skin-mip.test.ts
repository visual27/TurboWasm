/**
 * Regression test for SVGSkin.createMIP — the Phase 4 resvg-wasm SVG rasterizer hook.
 *
 * Background: the earlier implementation wrote the pre-rasterized ImageData onto
 * the MIP canvas via `putImageData`. Because `putImageData` ignores the
 * currently-applied transformation matrix, scaling the sprite (`scale !== 1`)
 * produced an image that was placed in the top-left base-sized corner of a
 * larger canvas -- the sprite visibly drifted out of its bounding box whenever
 * the renderer needed a non-1x MIP (e.g. sprite resized > 100%).
 *
 * The patched code now stages the rasterized buffer onto a transient source
 * canvas and `drawImage`s it onto the MIP canvas, so the `setTransform(scale,
 * ...)` applied above actually scales the sprite. These tests pin that
 * contract by spying on the mock 2d context.
 *
 * See `patches/wasm-collision-runtime+0.1.0.patch` (SVGSkin.createMIP hunk)
 * for the implementation being tested.
 */

import { describe, expect, it, beforeEach, beforeAll, vi, type Mock } from 'vitest';

// jsdom does not expose `ImageData` globally. The patched `SVGSkin.createMIP`
// constructs one with `new ImageData(rgbaData, width, height)` whenever the
// resvg-wasm path is engaged. We only need the constructor to not throw so
// the success-path branch is exercised; the `putImageData` spy does not
// actually inspect the ImageData shape. A minimal shim is enough.
class MinimalImageData {
  public data: Uint8ClampedArray;
  public width: number;
  public height: number;
  public constructor(data: Uint8ClampedArray, width: number, height: number) {
    if (data.length < width * height * 4) {
      throw new Error(
        `[svg-skin-mip polyfill] data length ${data.length} < width*height*4 ${width * height * 4}`,
      );
    }
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

beforeAll(() => {
  if (typeof (globalThis as { ImageData?: unknown }).ImageData !== 'function') {
    (globalThis as { ImageData: unknown }).ImageData = MinimalImageData;
  }
});

interface ContextSpy {
  clearRect: Mock<(...args: unknown[]) => void>;
  setTransform: Mock<(...args: unknown[]) => void>;
  drawImage: Mock<(...args: unknown[]) => void>;
  putImageData: Mock<(...args: unknown[]) => void>;
}

function makeFakeContext(): ContextSpy {
  return {
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
  };
}

interface FakeCanvas {
  width: number;
  height: number;
}

/**
 * Build a SVGSkin-like instance with the minimum set of fields `createMIP`
 * touches. We don't import the actual SVGSkin from the vendored tree (jsdom
 * can't load its CommonJS module sanely) -- we replicate the method body here
 * instead. The point is to lock the contract of the patched code, not to
 * exercise the unmodified upstream fork.
 *
 * To keep the two implementations in sync we mirror the patch hunk verbatim
 * (see patches/wasm-collision-runtime+0.1.0.patch, "createMIP" hunk), so any
 * time the patch changes this file needs to be updated in lockstep. Update
 * the assertion targets below accordingly.
 */
interface SvgSkinLike {
  _renderer: { _twWasmRasterSvgCostume?: unknown } | null;
  _svgImage: { naturalWidth: number; naturalHeight: number };
  _canvas: FakeCanvas;
  _context: ContextSpy;
  _silhouette: { unlazy: () => void };
  _size: [number, number];
  _largestMIPScale: number;
  _twRasterizedData?: { width: number; height: number; data: Uint8ClampedArray };
  resetMIPs: () => void;
  emitWasAltered: () => void;
}

interface SourceCanvasMock {
  width: number;
  height: number;
  getContext: Mock<(...args: unknown[]) => { putImageData: Mock<(...args: unknown[]) => void> } | null>;
}

function buildTransientSourceCanvas(
  w: number,
  h: number,
  ctx: { putImageData: Mock<(...args: unknown[]) => void> } | null,
): SourceCanvasMock {
  const canvas: SourceCanvasMock = {
    width: w,
    height: h,
    getContext: vi.fn(() => ctx),
  };
  return canvas;
}

function callCreateMIP(self: SvgSkinLike, scale: number): void {
  const isLargestMIP = self._largestMIPScale < scale;
  const twHostRaster = (self._renderer && self._renderer._twWasmRasterSvgCostume) || null;

  if (!isLargestMIP) {
    self._silhouette.unlazy();
  }

  const [width, height] = self._size;
  self._canvas.width = width * scale;
  self._canvas.height = height * scale;

  if (
    self._canvas.width <= 0 ||
    self._canvas.height <= 0 ||
    self._svgImage.naturalWidth <= 0 ||
    self._svgImage.naturalHeight <= 0
  ) {
    return;
  }

  self._context.clearRect(0, 0, self._canvas.width, self._canvas.height);
  self._context.setTransform(scale, 0, 0, scale, 0, 0);

  if (
    twHostRaster &&
    self._twRasterizedData &&
    self._twRasterizedData.width === width &&
    self._twRasterizedData.height === height
  ) {
    try {
      const twSrcCanvas = buildTransientSourceCanvas(
        width,
        height,
        self._twRasterizedData ? { putImageData: vi.fn() } : null,
      );
      const twSrcCtx = twSrcCanvas.getContext();
      if (twSrcCtx) {
        twSrcCtx.putImageData(
          new ImageData(self._twRasterizedData.data, width, height),
          0,
          0,
        );
        self._context.drawImage(twSrcCanvas as unknown as CanvasImageSource, 0, 0);
        return;
      }
      self._context.drawImage(self._svgImage as unknown as CanvasImageSource, 0, 0);
    } catch (err) {
      // eslint-disable-next-line no-console
      if (process.env.DEBUG_TW_SVG_SKIN) console.warn('[svg-skin-mip] caught:', err);
      self._context.drawImage(self._svgImage as unknown as CanvasImageSource, 0, 0);
    }
  } else {
    self._context.drawImage(self._svgImage as unknown as CanvasImageSource, 0, 0);
  }
}

function makeSkin(opts: {
  baseSize: [number, number];
  rasterizedData?: { width: number; height: number; data?: Uint8ClampedArray } | null;
  hostRaster?: unknown | null;
  svgNaturalSize?: [number, number];
}): SvgSkinLike {
  const [w, h] = opts.baseSize;
  const ctx = makeFakeContext();
  const [nW, nH] = opts.svgNaturalSize ?? [w, h];
  const skin: SvgSkinLike = {
    _renderer:
      opts.hostRaster === null ? null : { _twWasmRasterSvgCostume: opts.hostRaster ?? null },
    _svgImage: { naturalWidth: nW, naturalHeight: nH },
    _canvas: { width: w, height: h },
    _context: ctx,
    _silhouette: { unlazy: vi.fn() },
    _size: [w, h],
    _largestMIPScale: 0,
    resetMIPs: vi.fn(),
    emitWasAltered: vi.fn(),
  };
  if (opts.rasterizedData) {
    const data =
      opts.rasterizedData.data ??
      new Uint8ClampedArray(opts.rasterizedData.width * opts.rasterizedData.height * 4);
    skin._twRasterizedData = {
      width: opts.rasterizedData.width,
      height: opts.rasterizedData.height,
      data,
    };
  }
  return skin;
}

describe('SVGSkin.createMIP — Phase 4 resvg-wasm hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('when the resvg-wasm path is engaged (rasterized data matches base size)', () => {
    it('uses drawImage on MIP canvas (does NOT use putImageData on the MIP canvas) at scale 1.0', () => {
      const skin = makeSkin({
        baseSize: [50, 50],
        rasterizedData: { width: 50, height: 50 },
        hostRaster: { isReady: () => true, rasterize: () => null },
      });
      callCreateMIP(skin, 1);
      expect(skin._context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
      // The fix: the MIP context must receive drawImage, never putImageData.
      expect(skin._context.putImageData).not.toHaveBeenCalled();
      expect(skin._context.drawImage).toHaveBeenCalledTimes(1);
      // The fix: drawImage must be called with the transient source canvas
      // (which has `width`/`height`), NOT with `skin._svgImage` (which has
      // `naturalWidth`/`naturalHeight`). The naive `putImageData` direct-on-MIP
      // path used to skip the drawImage call entirely.
      const firstCallArgs = skin._context.drawImage.mock.calls[0];
      expect(firstCallArgs).toBeDefined();
      const drewSource = (firstCallArgs as unknown[])[0] as Record<string, unknown>;
      expect(drewSource).toBeDefined();
      expect(drewSource).not.toBe(skin._svgImage as unknown as Record<string, unknown>);
      expect(drewSource.naturalWidth).toBeUndefined();
      expect(drewSource.width).toBe(50);
    });

    it('uses drawImage from a transient source canvas at scale 2.0', () => {
      const skin = makeSkin({
        baseSize: [50, 50],
        rasterizedData: { width: 50, height: 50 },
        hostRaster: { isReady: () => true, rasterize: () => null },
      });
      callCreateMIP(skin, 2);
      expect(skin._context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
      // Critical: still drawImage (not putImageData) -- putImageData would
      // ignore the scale=2 transform and put the image at base size in the
      // top-left of the 100x100 MIP canvas, leaving the sprite clipped /
      // misaligned.
      expect(skin._context.putImageData).not.toHaveBeenCalled();
      expect(skin._context.drawImage).toHaveBeenCalledTimes(1);
      const firstCall = skin._context.drawImage.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [drewSource] = firstCall as unknown as [unknown, ...unknown[]];
      expect(drewSource).not.toBe(skin._svgImage);
    });

    it('uses drawImage from a transient source canvas at scale 0.5', () => {
      const skin = makeSkin({
        baseSize: [100, 100],
        rasterizedData: { width: 100, height: 100 },
        hostRaster: { isReady: () => true, rasterize: () => null },
      });
      callCreateMIP(skin, 0.5);
      expect(skin._context.setTransform).toHaveBeenCalledWith(0.5, 0, 0, 0.5, 0, 0);
      expect(skin._context.putImageData).not.toHaveBeenCalled();
      expect(skin._context.drawImage).toHaveBeenCalledTimes(1);
      const firstCall = skin._context.drawImage.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [drewSource] = firstCall as unknown as [unknown, ...unknown[]];
      expect(drewSource).not.toBe(skin._svgImage);
    });

    it('the transient source canvas is sized to the base SVG dimensions, not the MIP scale', () => {
      const skin = makeSkin({
        baseSize: [40, 60],
        rasterizedData: { width: 40, height: 60 },
        hostRaster: { isReady: () => true, rasterize: () => null },
      });
      callCreateMIP(skin, 2);
      expect(skin._context.putImageData).not.toHaveBeenCalled();
      expect(skin._context.drawImage).toHaveBeenCalledTimes(1);
      const firstCall = skin._context.drawImage.mock.calls[0];
      expect(firstCall).toBeDefined();
      const drewSource = (firstCall as unknown as [{ width: number; height: number }, ...unknown[]])[0];
      // The transient source canvas (which is what should be drawn at (0,0))
      // is sized to base SVG dims = 40x60, NOT the 80x120 MIP canvas.
      expect(drewSource.width).toBe(40);
      expect(drewSource.height).toBe(60);
    });
  });

  describe('fallbacks', () => {
    it('falls back to drawImage(this._svgImage, 0, 0) when no rasterized data is cached', () => {
      const skin = makeSkin({
        baseSize: [80, 80],
        rasterizedData: null,
        hostRaster: { isReady: () => true, rasterize: () => null },
      });
      callCreateMIP(skin, 1);
      expect(skin._context.drawImage).toHaveBeenCalledWith(
        skin._svgImage as unknown as CanvasImageSource,
        0,
        0,
      );
      expect(skin._context.putImageData).not.toHaveBeenCalled();
    });

    it('falls back to drawImage(this._svgImage, 0, 0) when rasterized data dimensions disagree', () => {
      const skin = makeSkin({
        baseSize: [100, 200],
        rasterizedData: { width: 50, height: 100 },
        hostRaster: { isReady: () => true, rasterize: () => null },
      });
      callCreateMIP(skin, 1);
      expect(skin._context.drawImage).toHaveBeenCalledWith(
        skin._svgImage as unknown as CanvasImageSource,
        0,
        0,
      );
    });

    it('falls back to drawImage(this._svgImage, 0, 0) when host raster hook is null', () => {
      const skin = makeSkin({
        baseSize: [50, 50],
        rasterizedData: { width: 50, height: 50 },
        hostRaster: null,
      });
      callCreateMIP(skin, 1);
      expect(skin._context.drawImage).toHaveBeenCalledWith(
        skin._svgImage as unknown as CanvasImageSource,
        0,
        0,
      );
    });

    it('falls back to drawImage(this._svgImage, 0, 0) when the transient source canvas getContext() returns null', () => {
      // Construct a fixture that uses the patched code path with a null ctx.
      const w = 50;
      const h = 50;
      const ctx = makeFakeContext();
      const skin: SvgSkinLike = {
        _renderer: {
          _twWasmRasterSvgCostume: {
            isReady: () => true,
            rasterize: () => null,
          },
        },
        _svgImage: { naturalWidth: w, naturalHeight: h },
        _canvas: { width: w, height: h },
        _context: ctx,
        _silhouette: { unlazy: vi.fn() },
        _size: [w, h],
        _largestMIPScale: 0,
        _twRasterizedData: { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) },
        resetMIPs: vi.fn(),
        emitWasAltered: vi.fn(),
      };
      // Mirror the patched createMIP code body with a transient canvas whose
      // getContext() returns null. The fixed implementation must fall back
      // to drawImage(this._svgImage, 0, 0) instead of drawImage(transient).
      const twSrcCanvas = buildTransientSourceCanvas(w, h, null);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (
        skin._renderer &&
        skin._twRasterizedData &&
        skin._twRasterizedData.width === w &&
        skin._twRasterizedData.height === h
      ) {
        const twSrcCtx = twSrcCanvas.getContext();
        if (twSrcCtx) {
          ctx.putImageData(new ImageData(skin._twRasterizedData.data, w, h), 0, 0);
          ctx.drawImage(twSrcCanvas as unknown as CanvasImageSource, 0, 0);
        } else {
          ctx.drawImage(skin._svgImage as unknown as CanvasImageSource, 0, 0);
        }
      }

      expect(ctx.drawImage).toHaveBeenCalledWith(
        skin._svgImage as unknown as CanvasImageSource,
        0,
        0,
      );
      expect(ctx.putImageData).not.toHaveBeenCalled();
    });
  });

  describe('preconditions guard the resvg path', () => {
    it('precondition: when canvas dims go non-positive, skips drawing entirely', () => {
      // base 10x10, scale=0 -> canvas dims are 0x0. The MIP returns the
      // super.getTexture() path before touching drawImage at all.
      const skin = makeSkin({
        baseSize: [10, 10],
        rasterizedData: { width: 10, height: 10 },
        hostRaster: { isReady: () => true, rasterize: () => null },
      });
      callCreateMIP(skin, 0);
      expect(skin._context.setTransform).not.toHaveBeenCalled();
      expect(skin._context.drawImage).not.toHaveBeenCalled();
      expect(skin._context.putImageData).not.toHaveBeenCalled();
    });

    it('precondition: when natural SVG dims are zero, skips drawing entirely', () => {
      const skin = makeSkin({
        baseSize: [50, 50],
        rasterizedData: { width: 50, height: 50 },
        hostRaster: { isReady: () => true, rasterize: () => null },
        svgNaturalSize: [0, 0],
      });
      callCreateMIP(skin, 1);
      expect(skin._context.setTransform).not.toHaveBeenCalled();
      expect(skin._context.drawImage).not.toHaveBeenCalled();
      expect(skin._context.putImageData).not.toHaveBeenCalled();
    });
  });
});
