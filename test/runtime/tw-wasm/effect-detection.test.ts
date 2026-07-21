import { describe, expect, it } from 'vitest';
import {
  COLOR_EFFECT_MASK,
  EFFECT_MASK,
  SHAPE_EFFECT_MASK,
  anyDrawableHasColorEffects,
  anyDrawableHasShapeEffects,
  drawableHasColorEffects,
  drawableHasShapeEffects,
} from '@/runtime/tw-wasm/effect-detection';

function d(enabledEffects: number | undefined): { enabledEffects: number | undefined } {
  return { enabledEffects };
}

describe('EFFECT_MASK: bit positions match vendored scratch-render', () => {
  it('exposes distinct single-bit values for each effect', () => {
    const seen = new Set<number>();
    for (const [name, value] of Object.entries(EFFECT_MASK)) {
      expect(value, `${name} must be a power of two`).toBeGreaterThan(0);
      expect(value & (value - 1), `${name} is not single-bit`).toBe(0);
      expect(seen.has(value), `${name} duplicates bit ${value}`).toBe(false);
      seen.add(value);
    }
  });

  it('SHAPE_EFFECT_MASK combines mosaic / pixelate / whirl / fisheye only', () => {
    expect(SHAPE_EFFECT_MASK).toBe(
      EFFECT_MASK.mosaic | EFFECT_MASK.pixelate | EFFECT_MASK.whirl | EFFECT_MASK.fisheye,
    );
  });

  it('COLOR_EFFECT_MASK combines color / brightness only (ghost excluded)', () => {
    expect(COLOR_EFFECT_MASK).toBe(EFFECT_MASK.color | EFFECT_MASK.brightness);
    expect(COLOR_EFFECT_MASK & EFFECT_MASK.ghost).toBe(0);
  });
});

describe('drawableHasShapeEffects: per-drawable detection', () => {
  it('returns false when enabledEffects is undefined / 0 / non-numeric', () => {
    expect(drawableHasShapeEffects(d(undefined))).toBe(false);
    expect(drawableHasShapeEffects(d(0))).toBe(false);
    expect(drawableHasShapeEffects({ enabledEffects: 'oops' as unknown as number })).toBe(false);
  });

  it('returns true only when at least one shape effect bit is set', () => {
    expect(drawableHasShapeEffects(d(EFFECT_MASK.mosaic))).toBe(true);
    expect(drawableHasShapeEffects(d(EFFECT_MASK.pixelate))).toBe(true);
    expect(drawableHasShapeEffects(d(EFFECT_MASK.whirl))).toBe(true);
    expect(drawableHasShapeEffects(d(EFFECT_MASK.fisheye))).toBe(true);
  });

  it('does not flag ghost-only or color-only drawables as shape-affected', () => {
    expect(drawableHasShapeEffects(d(EFFECT_MASK.ghost))).toBe(false);
    expect(drawableHasShapeEffects(d(EFFECT_MASK.color))).toBe(false);
    expect(drawableHasShapeEffects(d(EFFECT_MASK.brightness))).toBe(false);
  });
});

describe('drawableHasColorEffects: per-drawable detection', () => {
  it('returns false when enabledEffects is undefined / 0 / non-numeric', () => {
    expect(drawableHasColorEffects(d(undefined))).toBe(false);
    expect(drawableHasColorEffects(d(0))).toBe(false);
    expect(drawableHasColorEffects({ enabledEffects: 'oops' as unknown as number })).toBe(false);
  });

  it('returns true when color or brightness is set', () => {
    expect(drawableHasColorEffects(d(EFFECT_MASK.color))).toBe(true);
    expect(drawableHasColorEffects(d(EFFECT_MASK.brightness))).toBe(true);
    expect(drawableHasColorEffects(d(EFFECT_MASK.color | EFFECT_MASK.brightness))).toBe(true);
  });

  it('does not flag ghost-only drawables (ghost is intentionally excluded)', () => {
    expect(drawableHasColorEffects(d(EFFECT_MASK.ghost))).toBe(false);
  });
});

describe('anyDrawableHasShapeEffects / anyDrawableHasColorEffects: list variants', () => {
  it('anyDrawableHasShapeEffects returns true when any entry has a shape effect', () => {
    expect(anyDrawableHasShapeEffects([d(0), d(EFFECT_MASK.mosaic)])).toBe(true);
    expect(anyDrawableHasShapeEffects([d(0)])).toBe(false);
    expect(anyDrawableHasShapeEffects([])).toBe(false);
  });

  it('anyDrawableHasColorEffects returns true when any entry has a color effect', () => {
    expect(anyDrawableHasColorEffects([d(0), d(EFFECT_MASK.color)])).toBe(true);
    expect(anyDrawableHasColorEffects([d(0), d(EFFECT_MASK.ghost)])).toBe(false);
    expect(anyDrawableHasColorEffects([])).toBe(false);
  });

  it('the two list helpers can agree on the same drawable set', () => {
    const list = [d(EFFECT_MASK.mosaic), d(0)];
    expect(anyDrawableHasShapeEffects(list)).toBe(true);
    expect(anyDrawableHasColorEffects(list)).toBe(false);
  });
});
