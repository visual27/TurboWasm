/**
 * Shared types for the `@turbowasm/gpu-kernel-parser` package.
 *
 * This file is a **plain re-export** of the parser-relevant subset of
 * `src/runtime/gpu-kernel/types.ts` from the TurboWasm Viewer. The two
 * definitions are kept in lock-step to guarantee the Viewer's runtime
 * pipeline observes identical directive shapes to what the VSCode
 * extension shows in the editor.
 *
 * The Viewer DTO (`ParsedComment`, `BindDirective`, …) is the source of
 * truth; this file merely narrows the public surface for the package
 * and gives the parser a named result type.
 */

export type Severity = 'info' | 'warn' | 'error';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  regionId?: string;
  blockId?: string;
  commentOffset?: number;
  /** 0-based line index inside the source comment text. */
  line?: number;
  /** 0-based column index inside the source comment text. */
  column?: number;
}

export type AxisFinal =
  | 'global_x'
  | 'global_y'
  | 'global_z'
  | 'local_x'
  | 'local_y'
  | 'local_z'
  | 'workgroup_x'
  | 'workgroup_y'
  | 'workgroup_z'
  | 'sequential';

export const ALL_AXES: readonly AxisFinal[] = [
  'global_x',
  'global_y',
  'global_z',
  'local_x',
  'local_y',
  'local_z',
  'workgroup_x',
  'workgroup_y',
  'workgroup_z',
] as const;

export interface BindDirective {
  kind: 'bind';
  name: string;
  /**
   * `__tw_<hash>` for quoted names that contain characters not legal in
   * a WGSL identifier (spaces, punctuation). `undefined` for plain
   * identifiers — the existing reserved-keyword rename pass handles those.
   */
  internalName?: string;
  slot: number;
  readOnly: boolean;
  dtype: 'f32' | 'i32' | 'byte';
  /**
   * §Phase 3 — `'list'` is the default storage-buffer binding; `'scalar'`
   * routes the binding through the scratch global-variable uniform path.
   * `undefined` is treated as `'list'` everywhere downstream.
   */
  storageKind?: 'list' | 'scalar';
  line: number;
  column: number;
}

export type Dtype = BindDirective['dtype'];

export interface MaxDirective {
  kind: 'max';
  name: string;
  internalName?: string;
  value: number;
  line: number;
  column: number;
}

export interface WorkgroupSizeDirective {
  kind: 'workgroup_size';
  x: number;
  y: number;
  z: number;
  line: number;
  column: number;
}

export interface RepeatDirective {
  kind: 'repeat';
  name: string;
  internalName?: string;
  axis: AxisFinal;
  formula: string;
  max?: number;
  blockId: string;
  line: number;
  column: number;
}

export interface MapDirective {
  kind: 'map';
  var: string;
  /**
   * `__tw_<hash>` for quoted names that contain characters not legal in
   * a WGSL identifier. `undefined` for plain identifiers.
   */
  internalName?: string;
  formula: string;
  blockId: string;
  line: number;
  column: number;
}

export type ParsedDirective =
  | BindDirective
  | MaxDirective
  | WorkgroupSizeDirective
  | RepeatDirective
  | MapDirective;

export interface ParsedComment {
  blockId: string;
  text: string;
}

export interface ParseComputeCommentResult {
  directives: ParsedDirective[];
  diagnostics: Diagnostic[];
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface DocumentDirective {
  directive: ParsedDirective;
  range: Range;
  raw: string;
}

export interface DocumentRegion {
  regionId: string;
  range: Range;
  /** `0`-based index of the line that introduced the region (the `@compute` line). */
  markerLine: number;
  directives: DocumentDirective[];
  diagnostics: Diagnostic[];
}

export interface DocumentFrontmatter {
  /** Inclusive `Range` covering the `---\n...\n---` block. `null` if no frontmatter was present. */
  range: Range | null;
}

export interface ParseScgpuDocumentOptions {
  /** Override the region id assigned to the first `@compute` region. Defaults to `region:document`. */
  regionId?: string;
  /** When `true`, accept and skip a leading BOM. Default `true`. */
  stripBom?: boolean;
  /** When `true`, accept and skip a YAML frontmatter block at the top of the file. Default `true`. */
  skipFrontmatter?: boolean;
}

export interface ParseScgpuDocumentResult {
  regions: DocumentRegion[];
  diagnostics: Diagnostic[];
  frontmatter: DocumentFrontmatter;
}

export interface ScratchFormatOptions {
  /** Prefix prepended to every line. Default `'// '`. */
  prefix?: string;
  /** Final newline character. Default `'\n'`. */
  lineEnding?: '\n' | '\r\n';
}

export interface ScgpuFormatOptions {
  /** When `true`, align the `ro`/`rw` columns of `@bind` directives. Default `false`. */
  alignedBinds?: boolean;
  /** Line ending to emit. Default `'\n'`. */
  lineEnding?: '\n' | '\r\n';
}
