/**
 * Public re-exports for the GPU compute kernel pipeline (M3 — DSL parser
 * + D1/D2/D3 static analysis, M4 — WGSL emitter, M5 — runtime dispatch).
 *
 * Higher layers (the runtime player + vendored scratch-vm hook in M2)
 * import the building blocks from here so the per-milestone module
 * boundaries are not accidentally crossed.
 */

export * from './types';
export { parseComputeComment } from './comment-parser';
export { extractRegions, getBlockOrUndefined } from './region-extractor';
export { buildBlockSubsetVerdict, classifyBlockSubset } from './block-subset';
export type { BuildBlockSubsetVerdictInput } from './block-subset';
export {
  collectIterationAdvancePatterns,
  extractNumericLiteral,
  extractVariableName,
} from './iteration-advance-pattern';
export { collectIndirectAccessPatterns } from './indirect-access-pattern';
export { validateBoundBlockIds } from './bound-block-validator';
export { mergePatterns } from './pattern-merger';
export type { PatternMergerResult, PatternMergerOptions } from './pattern-merger';
export { analyzeAxes } from './axis-analysis';
export { analyzeCascade } from './cascade-analysis';
export {
  jsScratchBool,
  jsScratchDiv,
  jsScratchIndexClamp,
  jsScratchMod,
  scratchCompatHeader,
} from './scratch-compat';
export {
  clampWorkgroupSize,
  emitRegion,
  renameIdentifiers,
} from './wgsl-emitter';
export type {
  DispatchPlan,
  EmitInput,
  EmitResult,
  IdentifierRenameResult,
  WorkgroupLimits,
  WorkgroupSize,
} from './wgsl-emitter';
export {
  axisToRepeatDirective,
  collectImplicitAxes,
} from './implicit-axis';
export type {
  CollectImplicitAxesInput,
  CollectImplicitAxesResult,
} from './implicit-axis';
export {
  buildScratchBlockExprContext,
  scratchBlockToWgslExpr,
} from './scratch-block-expr';
export type {
  ScalarUniformBindingLike,
  ScratchBlockExprContext,
} from './scratch-block-expr';
export { shouldSkipBlock } from './skip-block-filter';
export type { SkipBlockContext } from './skip-block-filter';
export {
  analyzeBufferAccesses,
  analyzeRegionDependencies,
  canonicalKeyOf,
  KernelRegistry,
} from './kernel-registry';
export type { BufferAccessEntry, DispatchOutcome, Kernel } from './kernel-registry';
export {
  BYTES_PER_ELEMENT,
  DEFAULT_MAX_BUFFER_ELEMENTS,
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
  ListBufferPool,
} from './list-buffer-binding';
export type {
  GpuLikeBuffer,
  GpuLikeDevice,
  GpuLikeQueue,
  ListBufferBinding,
  ListBufferDtype,
  ListBufferPoolOptions,
} from './list-buffer-binding';
export {
  clampDispatchExtent,
  completeReadback,
  dispatchKernel,
  dispatchKernelSync,
  MAX_BUFFER_LENGTH,
  MAX_COMPUTE_WORKGROUPS_PER_DIMENSION_DEFAULT,
} from './__dispatch-kernel-sync';
export type {
  DispatchContext,
  DispatchResult,
  GPipeline,
  GpuLikeCommandEncoder,
  GpuLikeComputePassEncoder,
  GpuLikeDispatchDevice,
  GpuLikeShaderModule,
  RuntimeAdapter,
} from './__dispatch-kernel-sync';
export {
  applyGpuKernels,
  __getGpuKernelForBrowserVerify,
  __installGpuKernelRegistryForTesting,
  __setGpuKernelDispatcher,
  __uninstallGpuKernelRegistryForTesting,
} from './apply-gpu-kernels';
export type { DispatchFn } from './apply-gpu-kernels';
export type {
  ApplyGpuKernelsOptions,
  ApplyGpuKernelsResult,
  LookupFn,
} from './apply-gpu-kernels-types';
export {
  initializeGpuKernels,
  __resetAdapterUnavailableWarningForTesting,
} from './initialize-gpu-kernels';
export type { InitializeInput, InitializeResult, RequestAdapterFn } from './initialize-gpu-kernels';
