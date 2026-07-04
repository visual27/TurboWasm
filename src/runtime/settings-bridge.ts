import type { ScaffoldingInstance } from '@/runtime/scaffolding-types';
import type { AdvancedSettings } from '@/types/settings';

interface VmFrameLoop {
  setFramerate(value: number): void;
  setInterpolation(value: boolean): void;
}

interface VmRendererLike {
  setUseHighQualityRender?(value: boolean): void;
}

interface VmRuntimeLike {
  setCompilerOptions(opts: { enabled?: boolean; warpTimer?: boolean }): void;
  setRuntimeOptions(
    opts: Partial<{ miscLimits: boolean; fencing: boolean; maxClones: number }>,
  ): void;
  frameLoop: VmFrameLoop;
}

export interface ScaffoldingVmLike {
  setTurboMode(value: boolean): void;
  setStageSize(width: number, height: number): void;
  setInterpolation?(value: boolean): void;
  runtime: VmRuntimeLike;
  renderer?: VmRendererLike;
}

export function asVm(vm: unknown): ScaffoldingVmLike {
  if (!vm || typeof vm !== 'object') {
    throw new Error('Scaffolding.vm is not available');
  }
  return vm as ScaffoldingVmLike;
}

export function asRenderer(renderer: unknown): VmRendererLike {
  if (!renderer || typeof renderer !== 'object') {
    throw new Error('Scaffolding.renderer is not available');
  }
  return renderer as VmRendererLike;
}

export function applyAdvancedSettings(
  scaffolding: ScaffoldingInstance,
  next: AdvancedSettings,
): void {
  const vm = asVm(scaffolding.vm);
  const renderer = scaffolding.renderer ? asRenderer(scaffolding.renderer) : undefined;

  vm.runtime.frameLoop.setFramerate(next.fps);

  // Use `vm.setInterpolation` (vendored `runtime.setInterpolation`) rather
  // than `runtime.frameLoop.setInterpolation` directly: the former also
  // stores `runtime.interpolationEnabled` (read every frame by `_step()`
  // to decide whether to draw interpolated positions) and emits
  // INTERPOLATION_CHANGED, while internally calling
  // `frameLoop.setInterpolation` once. Calling both APIs in sequence
  // would produce two `_restart()` round-trips and would skip updating
  // the `interpolationEnabled` flag, breaking interpolating projects.
  if (vm.setInterpolation) {
    vm.setInterpolation(next.interpolation);
  }

  if (renderer?.setUseHighQualityRender) {
    renderer.setUseHighQualityRender(next.highQualityPen);
  }

  vm.runtime.setCompilerOptions({
    enabled: !next.disableCompiler,
    warpTimer: next.warpTimer,
  });

  vm.runtime.setRuntimeOptions({
    miscLimits: !next.removeMiscLimits,
    fencing: !next.removeFencing,
    maxClones: next.infiniteClones ? Infinity : 300,
  });

  vm.setTurboMode(next.turboMode);

  // Stage size: only update if differs to avoid extra work
  // vm.setStageSize emits STAGE_SIZE_CHANGED which Scaffolding listens to and updates its width/height.
  // (See scaffolding.js _onresize → STAGE_SIZE_CHANGED handler.)
}
