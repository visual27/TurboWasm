/**
 * Loader for WGSL shader source files. Phase 2 (WebGPU compute) and
 * Phase 3 (WebGPU instanced rendering) of the TurboWasm performance
 * spec. WGSL is shipped as plain text under `src/runtime/tw-wasm/wgsl/`
 * and bundled by Vite via `?raw` imports.
 *
 * The loader centralises the bundling import so the rest of the runtime
 * code can ask for a shader by name without repeating the Vite-specific
 * import path. It also surfaces a single debug-friendly error when a
 * shader is missing (Vite's `?raw` import throws "Failed to resolve" at
 * build time, which is the same error a real WGSL compiler would emit
 * if a binding is undefined).
 */

import touchingColorWgsl from './wgsl/touching-color.wgsl?raw';
import touchingDrawablesWgsl from './wgsl/touching-drawables.wgsl?raw';
import spriteInstancedWgsl from './wgsl/sprite-instanced.wgsl?raw';
import commonWgsl from './wgsl/common.wgsl?raw';

export const WGSL_SHADERS = {
  common: commonWgsl,
  touchingColor: touchingColorWgsl,
  touchingDrawables: touchingDrawablesWgsl,
  spriteInstanced: spriteInstancedWgsl,
} as const;

export type WgslShaderName = keyof typeof WGSL_SHADERS;

export function getWgslShader(name: WgslShaderName): string {
  const src = WGSL_SHADERS[name];
  if (typeof src !== 'string') {
    throw new Error(`WGSL shader not found: ${name}`);
  }
  return src;
}
