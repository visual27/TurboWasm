import type { AdvancedSettings } from '@/types/settings';
import {
  DETAILED_OPTIMIZATIONS_BY_CATEGORY,
} from '@/features/settings/constants';
import type {
  DetailedOptimizationId,
  DetailedOptimizationMap,
} from '@/features/settings/types';

export const APP_NAME = 'TurboWasm Viewer';

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
  fps: 30,
  interpolation: false,
  highQualityPen: false,
  warpTimer: false,
  infiniteClones: false,
  removeFencing: false,
  removeMiscLimits: false,
  turboMode: false,
  disableCompiler: false,
  stageWidth: 480,
  stageHeight: 360,
  extensionSandboxMode: 'worker',
  turboWasmAccelerationEnabled: true,
  enableWebgpu: true,
  customBlockInliningEnabled: true,
};

export const DEFAULT_ALLOWED_EXTENSION_URLS: readonly string[] = [];

export const STAGE_MIN_WIDTH = 1;
export const STAGE_MAX_WIDTH = 8192;
export const STAGE_MIN_HEIGHT = 1;
export const STAGE_MAX_HEIGHT = 8192;
export const FPS_MIN = 1;
export const FPS_MAX = 1000;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;

export const STORAGE_KEYS = {
  settings: 'tw-viewer:settings:v1',
} as const;

// Bumped to 2 when the schema split `advanced` (runtime state) and
// `defaultAdvanced` (saved defaults) into separate fields, and forced
// `disableCompiler` to always start as `false`. Bumped to 3 when the
// schema added the top-level `performanceMode` field. Bumped to 4 when
// `advanced` gained the `svgAccelerationMode` field (Stage 2 of the
// TurboWasm Acceleration plan). Bumped to 5 when the top-level
// `userExplicitFps` field was added to remember the user's most recent
// non-30 fps across toggles and reloads (drives the Alt+Flag FPS
// shortcut's round-trip behavior). Bumped to 6 when the
// `svgAccelerationMode` field and its top-level mirror were retired
// along with the WebGPU compute tier (Phase 2) and the WebGPU instanced
// renderer (Phase 3) — both were never wired beyond feature detection.
// v5 → v6 migration downgrades any `performanceMode: 'force-webgpu'`
// payload to `'auto'` so a user who had pinned WebGPU before the
// removal does not silently end up on a no-op path. Bumped to 7 when
// `advanced.enableGpuKernels` was added for the GPU compute kernel
// pipeline (M1 of the GPU kernel plan, see
// `src/runtime/gpu-kernel/`). v6 → v7 migration fills the field with
// `true` for existing payloads; the field is otherwise identical in
// shape to `turboWasmAccelerationEnabled`. Bumped to 8 when the
// top-level `performanceMode` union was collapsed into a single
// `enableWasm: boolean` (the three-way `'auto' | 'force-wasm' |
// 'legacy-only'` choice was reduced to a single switch — `force-wasm`
// was functionally identical to `auto`, so it was removed to avoid
// confusing dead-end options) and `advanced.enableGpuKernels` was
// renamed to `advanced.enableWebgpu` to align the field name with the
// user-facing label. v7 → v8 migration converts both fields in place:
// `performanceMode` collapses to `enableWasm` (`auto`/`force-wasm` →
// `true`, `legacy-only` → `false`), and `advanced.enableGpuKernels`
// is renamed to `advanced.enableWebgpu` while keeping the same boolean
// value. Bumped to 9 when `advanced.nestedParallelizationEnabled` was
// added (Phase 4 of the nested-parallelization plan). The toggle gates
// the GPU compute path for projects whose `@compute` marker sits on a
// nested `control_repeat` (kernel container promoted to the candidate's
// nearest ancestor). v8 → v9 migration seeds the field with `false`
// so existing users keep the legacy outer-only behaviour until they
// explicitly opt in. Older payloads are read and migrated on the fly —
// see `src/lib/persistence.ts`. Bumped to 10 when
// `advanced.nestedParallelizationEnabled` was retired alongside the v9
// nested-parallelization feature itself (Phase 4 BREAKING — see
// `gpu-kernel-dsl-phase4-spec.md`). The field is gone from the
// `AdvancedSettings` type and is silently dropped on the v9 → v10 read
// so a saved `true` value does not leak through into a fresh session.
// Bumped to 11 in Phase 5 (see `gpu-kernel-dsl-phase5-spec.md` §5.5).
// The new `advanced.customBlockInliningEnabled: boolean` (default
// `true`) is the opt-out for `procedure-inliner.ts`. The v10 → v11
// migration seeds the field with `true` for older payloads so the
// default-on behaviour carries forward unless the user explicitly
// disabled inlining at write time.
// Bumped to 12 in Phase 1 (`patches/vendored/scratch-vm.patch`).
// Adds the top-level `detailedOptimizations` map (default-on for
// every shipped ID) so the user's per-toggle settings for
// `comparison.shortCircuit` (Phase 1-A), `edgeHat.sentinelElimination`
// (Phase 1-B), and `comparison.infinityBranchRemoval` (Phase 1-C)
// persist across reloads. Phase 0 only kept the map in-memory; the
// v11 → v12 migration seeds `detailedOptimizations` with the existing
// `DEFAULT_DETAILED_OPTIMIZATIONS` defaults so a freshly-bumped payload
// keeps the default-on behaviour. v12 itself writes the map on every
// `schedulePersist` / `persistImmediate` via
// `src/lib/persistence.ts:writeSettings`.
export const STORAGE_VERSION = 12;

/**
 * §Phase 5 (gpu-kernel-dsl-phase5-spec §5.1) — maximum recursion depth
 * allowed for `procedure-inliner.ts`. Includes the original region's
 * own body, so the deepest possible call chain is
 * `MAX_INLINING_DEPTH` calls of `inlineProcedures` deep. Independent of
 * the `visitedPrototypeIds` cycle detection: depth catches straight
 * chains, the visited-set catches mutual recursion that doesn't blow
 * the depth limit.
 *
 * Bound chosen so a chain of length 16 can still be hand-rolled in a
 * test fixture, and the depth-17 / cycle boundary tests stay readable.
 */
export const MAX_INLINING_DEPTH = 16;

/**
 * Default value for `enableWasm` when no user preference has been
 * persisted yet (or when the legacy migration runs). `true` lets the
 * runtime pick WASM SIMD when supported and fall back to the JS path
 * otherwise (the previous `'auto'` behaviour, which is also what the
 * now-deleted `'force-wasm'` mode did).
 */
export const DEFAULT_ENABLE_WASM = true;

/**
 * Phase 0 — Foundation. Default per-toggle map for the detailed
 * optimization screen. Every shipped ID starts `true` (the
 * per-Phase patch decides whether to flip an individual ID off in
 * `availableInMaster`). All IDs default-on so the Settings UI matches
 * the upstream behaviour until the user explicitly opts out.
 *
 * §Phase 4A opt-in exception: `compatLayer.branchInfoReuse` defaults to
 * `false` (= legacy allocate-once-per-branch, behaviour identical to
 * upstream scratch-vm). The user opts in via the detailed Settings screen
 * when they want the per-thread branchInfo pool (= 97% heapDelta reduction
 * in microbench). Defaulting to false means existing user projects are
 * byte-identical (= no risk) until the user explicitly enables the
 * feature.
 *
 * Stored in `Record<DetailedOptimizationId, boolean>` rather than
 * `Map` so deep-equal assertions (`toEqual`) work and JSON serialise
 * stays trivial when Phase 1+ introduces persistence.
 */
export const DEFAULT_DETAILED_OPTIMIZATIONS: DetailedOptimizationMap = (() => {
  const ids: DetailedOptimizationId[] = Object.values(
    DETAILED_OPTIMIZATIONS_BY_CATEGORY,
  ).flat();
  // §Phase 4A / 4B opt-in — see comment above. All other IDs default to
  // `true` (= shipped behaviour). These IDs default to `false` (= legacy,
  // identical to upstream):
  //   - `compatLayer.branchInfoReuse` (§Phase 4A) → branchInfo pool
  //   - `data.mapConversionEvaluation` (§Phase 4B) → Blocks._cache Map
  const optInIds = new Set<DetailedOptimizationId>([
    'compatLayer.branchInfoReuse',
    'data.mapConversionEvaluation',
  ]);
  return Object.freeze(
    ids.reduce<Record<DetailedOptimizationId, boolean>>((acc, id) => {
      acc[id] = !optInIds.has(id);
      return acc;
    }, {} as Record<DetailedOptimizationId, boolean>),
  );
})();

/**
 * Console-log prefix used by all Phase 0+ optimization toggle changes.
 * Mirrors the `[tw-stage-size]` / `[gpu-kernel]` / `[tw-viewer debug]`
 * convention documented in AGENTS.md so users can filter the DevTools
 * console for `Filter: /\[tw-optimization\]/` while triaging a session.
 */
export const OPTIMIZATION_TOGGLE_LOG_PREFIX = '[tw-optimization]';

export const ENV = {
  githubRepoUrl:
    (import.meta.env.VITE_GITHUB_REPO_URL as string | undefined) ??
    'https://github.com/visual27/TurboWasm',
} as const;
