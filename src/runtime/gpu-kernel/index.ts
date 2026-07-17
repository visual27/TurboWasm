/**
 * Public re-exports for the GPU compute kernel pipeline (M3 — DSL parser
 * + D1/D2/D3 static analysis).
 *
 * Higher layers (M4 wgsl-emitter, M5 kernel-registry) import the
 * building blocks from here so the M3 module boundaries are not
 * accidentally crossed.
 */

export * from './types';
export { parseComputeComment } from './comment-parser';
export { extractRegions, getBlockOrUndefined } from './region-extractor';
export { classifyBlockSubset } from './block-subset';
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
  EmitInput,
  IdentifierRenameResult,
  WorkgroupLimits,
  WorkgroupSize,
} from './wgsl-emitter';
