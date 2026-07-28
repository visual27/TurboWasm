import type { ScaffoldingInstance } from '@/runtime/scaffolding-types';
import type { AdvancedSettings } from '@/types/settings';
import type { DetailedOptimizationMap } from '@/features/settings/types';

interface VmFrameLoop {
  setFramerate(value: number): void;
  setInterpolation(value: boolean): void;
}

interface VmRendererLike {
  setUseHighQualityRender?(value: boolean): void;
}

interface VmRuntimeLike {
  setCompilerOptions(opts: {
    enabled?: boolean;
    warpTimer?: boolean;
    // §Phase 3 — vendored scratch-vm's `IROptimizer.shouldFoldConstant`
    // reads `runtime.compilerOptions.constantFoldingEnabled` to decide
    // whether `tryFoldConstant` runs. Wired from the detailed toggle
    // `data.constantFolding` (see `applyAdvancedSettings` below).
    constantFoldingEnabled?: boolean;
    // §Phase 4A opt-in — vendored scratch-vm's `__branchInfoAcquire`
    // (= `src/compiler/jsexecute.js`) reads
    // `runtime.compilerOptions.branchInfoPoolEnabled` to decide whether
    // to acquire the branchInfo snapshot from the per-thread pool or
    // allocate a fresh one. Default OFF in the vendored runtime; wired
    // from the detailed toggle `compatLayer.branchInfoReuse` in
    // `applyAdvancedSettings` below. 97% heapDelta reduction in
    // microbench; only affects scripts that hit the compat layer
    // (= extension blocks with BlockType.CONDITIONAL / LOOP).
    branchInfoPoolEnabled?: boolean;
    // §Phase 4B opt-in — vendored scratch-vm's
    // `Blocks.getCachedCompileResult` / `cacheCompileResult` /
    // `cacheCompileError` (= `src/engine/blocks.js`) read
    // `runtime.compilerOptions.mapConversionEnabled` to decide whether
    // `Blocks._cache.compiledScripts` is a `Map<string, ...>` (= ON)
    // or a plain `{}` (= OFF). Default OFF in the vendored runtime;
    // wired from the detailed toggle `data.mapConversion` in
    // `applyAdvancedSettings` below. 68% wall median reduction on a
    // 50-key cache (see `scripts/bench-map-eval.mjs`). The Map shape
    // is runtime-internal (= never serialized to sb3) so sb3
    // compatibility is preserved.
    mapConversionEnabled?: boolean;
  }): void;
  setRuntimeOptions(
    opts: Partial<{ miscLimits: boolean; fencing: boolean; maxClones: number }>,
  ): void;
  frameLoop: VmFrameLoop;
}

export interface ScaffoldingVmLike {
  setTurboMode(value: boolean): void;
  setStageSize(width: number, height: number): void;
  setInterpolation?(value: boolean): void;
  /**
   * eventemitter3-style subscribe. The vendored VM extends EventEmitter
   * and emits ASSET_PROGRESS with positional `(finished, total)` args,
   * so the listener signature is intentionally loose here. Used by the
   * player to wire the runtime's asset-load progress into the player
   * store, since the Scaffolding itself does not forward that event.
   */
  on(event: string, listener: (...args: unknown[]) => unknown): unknown;
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
  // §Phase 3 — `data.constantFolding` is the runtime gate for the
  // vendored IROptimizer's `tryFoldConstant` pass. We accept the map
  // explicitly so the bridge stays free of `useSettingsStore` (no
  // circular-import risk) and the test fixtures can drive the bridge
  // with arbitrary ID combinations. `DEFAULT_DETAILED_OPTIMIZATIONS` is
  // not auto-seeded here — callers must pass a fully-populated map.
  detailed: DetailedOptimizationMap,
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

  // Phase 0 — Foundation. When the master TurboWasm Acceleration
  // toggle is off we deliberately skip the compiler / runtime
  // option calls below. The semantic flag set
  // (`disableCompiler`, `warpTimer`, `removeMiscLimits`,
  // `removeFencing`, `infiniteClones`) is orthogonal to the
  // TurboWasm acceleration tier: a user turning the master off is
  // saying "stop applying new TurboWasm-specific optimisations",
  // not "reset every compiled/interpreted behaviour". Skipping the
  // calls keeps the runtime in whatever state it was last set to
  // (e.g. a previous session left the compiler enabled), so a later
  // master-ON simply resumes with no behavioural drift.
  //
  // Turbo mode is still applied because it has visible UX side
  // effects (no framerate cap) that the user might have toggled
  // independently of TurboWasm acceleration.
  //
  // §Phase 3 — `constantFoldingEnabled` is forwarded here from the
  // detailed toggle `data.constantFolding` (default-on). It is wired
  // through `setCompilerOptions` so the vendored
  // `IROptimizer.shouldFoldConstant` sees the change on the next
  // compile. The patch is idempotent across reloads (the value is
  // persisted in `localStorage` via `detailedOptimizations`).
  if (next.turboWasmAccelerationEnabled) {
    vm.runtime.setCompilerOptions({
      enabled: !next.disableCompiler,
      warpTimer: next.warpTimer,
      constantFoldingEnabled: detailed['data.constantFolding'],
      // §Phase 4A opt-in. `compatLayer.branchInfoReuse` defaults to false
      // (= legacy allocate-once-per-branch); when the user enables it,
      // the vendored scratch-vm's `__branchInfoAcquire` switches to the
      // per-thread pool path (heapDelta -97% in microbench). Only affects
      // scripts that hit the compat layer (= extension blocks with
      // BlockType.CONDITIONAL / LOOP). Native `control_if` /
      // `control_repeat` blocks are inlined as native JS by the vendored
      // compiler and do NOT go through the compat layer, so this toggle
      // is a no-op for typical sb3 projects (= 99% of user projects).
      branchInfoPoolEnabled: detailed['compatLayer.branchInfoReuse'],
      // §Phase 4B opt-in. `data.mapConversion` defaults to OFF; when
      // enabled, `Blocks._cache.compiledScripts` is backed by a Map
      // (= 68% wall median reduction on a 50-key cache). Runtime-internal
      // shape change only (= never persisted to sb3).
      mapConversionEnabled: detailed['data.mapConversionEvaluation'],
    });

    vm.runtime.setRuntimeOptions({
      miscLimits: !next.removeMiscLimits,
      fencing: !next.removeFencing,
      maxClones: next.infiniteClones ? Infinity : 300,
    });
  }

  vm.setTurboMode(next.turboMode);

  // Stage size: only update if differs to avoid extra work
  // vm.setStageSize emits STAGE_SIZE_CHANGED which Scaffolding listens to and updates its width/height.
  // (See scaffolding.js _onresize → STAGE_SIZE_CHANGED handler.)
}
