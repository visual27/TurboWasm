/**
 * Directive constants for the `@turbowasm/gpu-kernel-parser` package.
 *
 * The directive names mirror the `@compute` DSL documented in
 * `docs/specs/gpu-compute-kernel-dsl.md`. The list is **not** auto-
 * derived from the parser body — keeping it as a constant table lets the
 * VSCode extension (completion provider, snippets) reference the same
 * canonical names without importing parser internals.
 */

export type DirectiveName =
  | 'compute'
  | 'bind'
  | 'max'
  | 'workgroup_size'
  | 'repeat'
  | 'map';

export const DIRECTIVE_HEADS: readonly DirectiveName[] = [
  'bind',
  'max',
  'workgroup_size',
  'repeat',
  'map',
] as const;

export const COMPUTE_MARKER: DirectiveName = 'compute';

export const BIND_DTYPES = ['f32', 'i32', 'byte'] as const;
export type BindDtype = (typeof BIND_DTYPES)[number];

export const SEQUENTIAL_AXIS = 'sequential';

/**
 * All reserved axis tokens that the parser treats as parallel axes.
 * `sequential` is intentionally excluded — it is the fallback value
 * rather than a parallel target.
 */
export const KNOWN_AXES = [
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

export type KnownAxis = (typeof KNOWN_AXES)[number];

export const DIRECTIVE_DESCRIPTIONS: Record<DirectiveName, string> = {
  compute:
    'Region marker. Begins a `@compute` block; subsequent directives belong to the same region until the next marker.',
  bind: 'Buffer declaration. Form: `@bind <name>(<slot>) (ro|rw) [f32|i32|byte]`; quote names containing spaces or punctuation. dtype defaults to `f32`.',
  max: 'Static size hint. Form: `@max <group>=<uint>`. Not read by the emitter; retained as documentation.',
  workgroup_size:
    'Workgroup dimensions. Form: `@workgroup_size(x[,y[,z]])`. Each value must be ≥ 1. Defaults to (64,1,1).',
  repeat:
    'Repeat loop declaration. Form: `@repeat R<i>[:<axis>] = <formula>[, max=<uint>]`. Requires a matching `@map`.',
  map: 'WGSL `let` binding. Form: `@map <var> <- <formula>`. The formula may be rewritten to avoid WGSL reserved words.',
};
