/**
 * Scratch visual-effect bitmask helpers for the TurboWasm acceleration
 * fallback layer.
 *
 * The masks here MUST match `ShaderManager.EFFECT_INFO[*].mask` in
 * vendored scratch-render (search `ShaderManager.js` /
 * `EffectTransform.js`). Bit positions were intentionally chosen by
 * upstream so each effect owns a distinct power-of-two bit; the
 * constants below are the canonical TurboWarp values.
 *
 * Why this lives in its own module
 * --------------------------------
 * The TurboWasm WASM acceleration path cannot yet reproduce the
 * full EffectTransform output (fisheye / whirl / pixelate / mosaic
 * UV warps plus color/brightness premultiplied-color math plus ghost
 * alpha mod). Until the Rust crate grows Rust-side effect handling,
 * any drawable that has an active shape-or-color effect must take
 * the JS fallback path so that the user-visible collision result
 * matches the original scratch-render CPU/GPU behavior. Keeping the
 * mask logic here — separate from the rendering surface — lets the
 * future Rust port import the same constants without dragging in any
 * React / store code.
 */

/**
 * Order matches the index of each effect name in `ShaderManager.EFFECTS`.
 * The mask values are powers of two (1..64) and the bits below are the
 * upstream scratch-render values, verified against
 * `vendored/scaffolding/node_modules/scratch-render/src/ShaderManager.js`.
 */
export const EFFECT_MASK = {
  color: 0b0000001,
  brightness: 0b0000010,
  ghost: 0b0000100,
  mosaic: 0b0001000,
  pixelate: 0b0010000,
  whirl: 0b0100000,
  fisheye: 0b1000000,
} as const;

/**
 * Effects that warp UV coordinates via `EffectTransform.transformPoint`.
 * The WASM path (which only does plain affine/perspective mapping from
 * `Drawable.getLocalPosition`) cannot replicate these without dropping
 * accuracy on the silhouette boundary, so we hand them off to the JS
 * path whenever any sprite in the collision set has one active.
 */
export const SHAPE_EFFECT_MASK =
  EFFECT_MASK.mosaic | EFFECT_MASK.pixelate | EFFECT_MASK.whirl | EFFECT_MASK.fisheye;

/**
 * Effects that mutate sampled RGBA via `EffectTransform.transformColor`.
 * `ghost` is intentionally EXCLUDED here: the JS path already strips
 * ghost from `isTouchingColor` via `effectMask: ~ShaderManager.EFFECT_INFO.ghost.mask`,
 * and the WASM path likewise ignores it (the silhouette `_colorData`
 * is captured pre-render and has no ghost applied). Adding `ghost` to
 * COLOR_EFFECT_MASK would force needless JS fallback.
 */
export const COLOR_EFFECT_MASK = EFFECT_MASK.color | EFFECT_MASK.brightness;

export interface EffectsAware {
  enabledEffects?: number;
}

/**
 * Returns true when the drawable has at least one shape-changing effect
 * (mosaic / pixelate / whirl / fisheye) enabled. Callers should treat
 * this as a "must take JS fallback" signal.
 */
export function drawableHasShapeEffects(d: EffectsAware): boolean {
  const m = d.enabledEffects;
  return typeof m === 'number' && m !== 0 && (m & SHAPE_EFFECT_MASK) !== 0;
}

/**
 * Returns true when the drawable has at least one color-affecting
 * effect (color / brightness) enabled. Ghost-only drawables return false
 * because both paths skip ghost identically.
 */
export function drawableHasColorEffects(d: EffectsAware): boolean {
  const m = d.enabledEffects;
  return typeof m === 'number' && m !== 0 && (m & COLOR_EFFECT_MASK) !== 0;
}

/**
 * Returns true when *any* drawable in the list has a shape effect active.
 * Skips entries where `drawable` is missing.
 */
export function anyDrawableHasShapeEffects(drawables: ReadonlyArray<EffectsAware>): boolean {
  for (const d of drawables) {
    if (drawableHasShapeEffects(d)) return true;
  }
  return false;
}

/**
 * Returns true when *any* drawable in the list has a color effect active.
 */
export function anyDrawableHasColorEffects(drawables: ReadonlyArray<EffectsAware>): boolean {
  for (const d of drawables) {
    if (drawableHasColorEffects(d)) return true;
  }
  return false;
}
