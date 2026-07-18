/**
 * Public entry point for `@turbowasm/gpu-kernel-parser`.
 *
 * The package is a thin, dual-published wrapper around the parser logic
 * that lives in `src/runtime/gpu-kernel/comment-parser.ts` inside the
 * TurboWasm Viewer. Two consumers:
 *
 *   - The TurboWasm Viewer runtime (via `@turbowasm/gpu-kernel-parser`
 *     once it migrates from the in-tree parser to this package; both
 *     stay functional in lock-step until then).
 *
 *   - The `gpu-compute-dsl` VSCode extension, which uses this package to
 *     parse `.scgpu` text for completion / hover / diagnostic / format.
 */

export {
  parseComputeComment,
} from './comment-parser';

export {
  parseScgpuDocument,
  positionOf,
} from './document-parser';

export {
  formatScratchComment,
  formatScgpuDocument,
  listBindings,
  listMaps,
  listRepeats,
  listWorkgroupSizes,
  positionToOffset,
} from './formatters';

export {
  ALL_AXES,
  type AxisFinal,
  type BindDirective,
  type Dtype,
  type Diagnostic,
  type DocumentDirective,
  type DocumentFrontmatter,
  type DocumentRegion,
  type MapDirective,
  type MaxDirective,
  type ParseComputeCommentResult,
  type ParseScgpuDocumentOptions,
  type ParseScgpuDocumentResult,
  type ParsedComment,
  type ParsedDirective,
  type Position,
  type Range,
  type RepeatDirective,
  type ScgpuFormatOptions,
  type ScratchFormatOptions,
  type Severity,
  type WorkgroupSizeDirective,
} from './types';

export {
  BIND_DTYPES,
  COMPUTE_MARKER,
  DIRECTIVE_DESCRIPTIONS,
  DIRECTIVE_HEADS,
  KNOWN_AXES,
  SEQUENTIAL_AXIS,
  type BindDtype,
  type DirectiveName,
  type KnownAxis,
} from './directives';
