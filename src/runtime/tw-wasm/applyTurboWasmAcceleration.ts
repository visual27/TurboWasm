import type { RuntimeCapabilities } from './capabilities';
import {
  wasmIsTouchingColor,
  wasmIsTouchingDrawables,
  isWasmCollisionReady,
} from './wasm-collision-client';
import type { RendererLike } from './wasm-collision-client';

export interface ApplyTurboWasmArgs {
  enabled: boolean;
  caps: RuntimeCapabilities;
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

function patchRenderer(
  renderer: RendererWithHooks,
  enabled: boolean,
  caps: RuntimeCapabilities,
): void {
  const useWasm = enabled && caps.wasmSimd && isWasmCollisionReady();
  if (useWasm) {
    renderer._twWasmIsTouchingDrawables = (rd, drawableID, candidateIDs) =>
      wasmIsTouchingDrawables(rd, drawableID, candidateIDs);
    renderer._twWasmIsTouchingColor = (rd, drawableID, color3b, mask3b) =>
      wasmIsTouchingColor(rd, drawableID, color3b, mask3b);
  } else {
    renderer._twWasmIsTouchingDrawables = null;
    renderer._twWasmIsTouchingColor = null;
  }
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
  patchRenderer(renderer, args.enabled, args.caps);
}

export function removeTurboWasmAcceleration(scaffolding: ScaffoldingLike | null | undefined): void {
  if (!scaffolding) return;
  const renderer = scaffolding.renderer as RendererWithHooks | null | undefined;
  if (!renderer) return;
  renderer._twWasmIsTouchingDrawables = null;
  renderer._twWasmIsTouchingColor = null;
}
