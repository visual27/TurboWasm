import type { RuntimeCapabilities } from './capabilities';
import { wasmIsTouchingColor, wasmIsTouchingDrawables, isWasmCollisionReady } from './wasm-collision-client';
import type { RendererLike } from './wasm-collision-client';

/**
 * Public-facing description of the TurboWasm acceleration layer's
 * renderer hooks. The Settings dialog consults this for the diagnostic
 * surfaces (e.g. showing which backend served the last frame in
 * `!dump`).
 *
 * Phase 2 (WebGPU compute) and Phase 3 (WebGPU instanced renderer)
 * were removed along with their UI selectors in commit `Plan: remove
 * stub WebGPU / SVG acceleration`. The runtime is now a single-tier
 * hook around the WASM SIMD collision client — no GPU compute path is
 * consulted, no instanced draw hook is installed.
 */
export interface TurboWasmHookSummary {
  /** Backend the renderer is currently bound to (js / wasm / none). */
  backend: 'wasm' | 'js' | 'none';
}

export interface ApplyTurboWasmArgs {
  enabled: boolean;
  caps: RuntimeCapabilities;
  /**
   * User-controlled WASM-SIMD acceleration switch. `false` clears every
   * TurboWasm hook on the renderer so the runtime falls through to the
   * original scratch-render path with zero behavioural change (the
   * Definition-of-Done parity mode). `true` installs the WASM hook when
   * `wasmReady` and falls back to the JS path otherwise.
   */
  enableWasm: boolean;
}

type TurboWasmCallback = (
  renderer: RendererLike,
  drawableID: number,
  candidateIDs: readonly number[],
) => boolean | null;

type TurboWasmColorCallback = (
  renderer: RendererLike,
  drawableID: number,
  color3b: number[] | Uint8Array | null,
  mask3b: number[] | Uint8Array | null | undefined,
) => boolean | null;

interface RendererWithHooks {
  _twWasmIsTouchingDrawables?: TurboWasmCallback | null;
  _twWasmIsTouchingColor?: TurboWasmColorCallback | null;
}

/**
 * Decide whether the WASM SIMD hook should be installed on the
 * renderer.
 *
 *  - `!args.enableWasm` returns `'none'` so the renderer falls through
 *    to its unmodified JS path.
 *  - otherwise returns `'wasm'` when WASM SIMD has initialised,
 *    `'none'` (the JS path) otherwise.
 *
 * Previously this function consulted a WebGPU compute tier first
 * (`'gpu'` → `'wasm'` → `'none'`). The WebGPU tier was retired (it
 * always returned `null` from the JS-side hook) so the selector now
 * has only two outcomes. The collapsed v8 shape (single boolean
 * `enableWasm` instead of the v3..v7 `performanceMode` three-way
 * union) is the source of truth — `selectBackendTier` no longer
 * consults `auto` / `force-wasm` / `legacy-only` strings.
 */
export function selectBackendTier(args: ApplyTurboWasmArgs, wasmReady: boolean): 'wasm' | 'none' {
  if (!args.enabled) return 'none';
  if (!args.enableWasm) return 'none';
  return wasmReady ? 'wasm' : 'none';
}

function patchRenderer(renderer: RendererWithHooks, args: ApplyTurboWasmArgs): void {
  const wasmReady = args.caps.wasmSimd && isWasmCollisionReady();
  const tier = selectBackendTier(args, wasmReady);
  if (tier === 'none') {
    renderer._twWasmIsTouchingDrawables = null;
    renderer._twWasmIsTouchingColor = null;
    return;
  }
  // 'wasm'
  renderer._twWasmIsTouchingDrawables = (rd, drawableID, candidateIDs) =>
    wasmIsTouchingDrawables(rd, drawableID, candidateIDs);
  renderer._twWasmIsTouchingColor = (rd, drawableID, color3b, mask3b) =>
    wasmIsTouchingColor(rd, drawableID, color3b, mask3b);
}

export interface ScaffoldingLike {
  renderer: unknown;
}

export function applyTurboWasmAcceleration(
  scaffolding: ScaffoldingLike | null | undefined,
  args: ApplyTurboWasmArgs,
): void {
  if (!scaffolding) return;
  const renderer = scaffolding.renderer as RendererWithHooks | null | undefined;
  if (!renderer) return;
  patchRenderer(renderer, args);
}

export function removeTurboWasmAcceleration(scaffolding: ScaffoldingLike | null | undefined): void {
  if (!scaffolding) return;
  const renderer = scaffolding.renderer as RendererWithHooks | null | undefined;
  if (!renderer) return;
  renderer._twWasmIsTouchingDrawables = null;
  renderer._twWasmIsTouchingColor = null;
}
