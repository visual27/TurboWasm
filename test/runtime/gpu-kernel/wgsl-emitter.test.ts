import { describe, expect, it } from 'vitest';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import {
  clampWorkgroupSize,
  emitRegion,
  type EmitInput,
} from '@/runtime/gpu-kernel/wgsl-emitter';
import type {
  AxisFinal,
  ParsedProject,
  RawBlock,
  RegionVerdict,
} from '@/runtime/gpu-kernel/types';

function block(id: string, opcode: string, options: Partial<RawBlock> = {}): RawBlock {
  return { id, opcode, next: null, parent: null, inputs: {}, fields: {}, ...options };
}

function makeProject(body: RawBlock[] = []): ParsedProject {
  const blocks: Record<string, RawBlock> = {};
  const first = body[0];
  blocks['repeat'] = block('repeat', 'control_repeat', {
    inputs: first ? { SUBSTACK: first.id } : {},
  });
  for (const item of body) blocks[item.id] = item;
  return {
    targets: [{ id: 'sprite', isStage: false, blocks }],
    comments: {},
  };
}

function makeVerdict(
  source: string,
  topoOrder: string[],
  axisOverrides: Record<string, AxisFinal> = {},
  workgroupLimits?: EmitInput['workgroupLimits'],
): { regionVerdict: RegionVerdict; input: EmitInput } {
  const parsed = parseComputeComment({ blockId: 'body', text: source }, 'region');
  const axes: RegionVerdict['axes'] = {};
  const parallelAxes: RegionVerdict['parallelAxes'] = [];
  for (const directive of parsed.directives) {
    if (directive.kind !== 'repeat') continue;
    const finalAxis = axisOverrides[directive.name] ?? directive.axis;
    axes[directive.name] = {
      requestedAxis: directive.axis,
      finalAxis,
      diagnostics: [],
    };
    if (finalAxis !== 'sequential') {
      parallelAxes.push({ repeatName: directive.name, axis: finalAxis });
    }
  }
  const regionVerdict: RegionVerdict = {
    regionId: 'region',
    blockId: 'repeat',
    spriteId: 'sprite',
    directives: parsed.directives,
    blockSubset: { valid: true, diagnostics: [] },
    axes,
    cascade: { valid: true, diagnostics: [], topoOrder },
    diagnostics: parsed.diagnostics,
    parallelAxes,
  };
  return {
    regionVerdict,
    input: workgroupLimits
      ? { regionVerdict, parsedProject: makeProject(), workgroupLimits }
      : { regionVerdict, parsedProject: makeProject() },
  };
}

describe('wgsl-emitter', () => {
  it('emits a complete parallel compute module and dispatch plan', () => {
    const { input } = makeVerdict(
      [
        '@compute',
        '@bind buff_r(2) rw f32',
        '@repeat R0:global_x = N, max=64',
        '@workgroup_size(64)',
        '@map R0 <- 0',
      ].join('\n'),
      ['R0'],
    );
    const result = emitRegion(input);

    expect(result.wgsl).toContain('fn scratch_div');
    expect(result.wgsl).toContain('@compute @workgroup_size(64,1,1)');
    expect(result.wgsl).toContain(
      '@group(0) @binding(2) var<storage, read_write> buff_r: array<f32>;',
    );
    expect(result.wgsl).toContain('@group(1) @binding(0) var<uniform> u_scratch: ScratchUniforms;');
    expect(result.wgsl).toContain('// dispatchWorkgroups(ceil(N / 64), 1, 1)');
    expect(result.wgsl).toContain('@builtin(global_invocation_id) __tw_gid: vec3<u32>');
    expect(result.dispatchPlan.x).toBe('ceil(N / 64)');
    expect(result.dispatchPlan.y).toBe('1');
    expect(result.dispatchPlan.z).toBe('1');
  });

  it('wraps a sequential axis in a loop and dispatches one workgroup', () => {
    const { input } = makeVerdict(
      '@compute\n@repeat R0:sequential = N\n@map R0 <- 0',
      ['R0'],
    );
    const result = emitRegion(input);

    expect(result.wgsl).toContain('for (let R0: u32 = 0; R0 < N; R0 = R0 + 1)');
    expect(result.wgsl).toContain('for (var R0: u32 = 0u;');
    expect(result.wgsl).toContain('// dispatchWorkgroups(1, 1, 1)');
    expect(result.dispatchPlan.x).toBe('1');
  });

  it('renames a reserved map identifier once', () => {
    const { input } = makeVerdict('@compute\n@map compute <- 0', ['compute']);
    const result = emitRegion(input);

    expect(result.wgsl).toMatch(/let __tw_[0-9a-f]{8}: f32 = 0;/);
    expect(result.diagnostics.filter((item) => item.code === 'gpu.identifier_collision')).toHaveLength(1);
  });

  it('renames @bind names that collide with reserved WGSL keywords', () => {
    const { input } = makeVerdict(
      '@compute\n@bind let(0) rw f32\n@bind if(1) ro f32',
      [],
    );
    const result = emitRegion(input);

    expect(result.wgsl).toMatch(/var<storage, read_write> __tw_[0-9a-f]{8}: array<f32>/);
    expect(result.wgsl).toMatch(/var<storage, read> __tw_[0-9a-f]{8}: array<f32>/);
    const collisionDiags = result.diagnostics.filter((d) => d.code === 'gpu.identifier_collision');
    expect(collisionDiags).toHaveLength(2);
  });

  // §19.2 #16 (C-8): formula identifiers must be rewritten when the
  // bound name collides with a reserved WGSL keyword. Previously
  // `renameFormulaIdentifiers` only consulted `renameTable`; binding
  // renames happened to flow through there, but the priority was
  // implicit. Phase E (quoted `@bind` names) will derive `internalName`
  // independently of `renameTable`, so the binding rename path must
  // be explicit.
  it('formula referencing a renamed @bind name rewrites to the hashed WGSL name (C-8)', () => {
    const { input } = makeVerdict(
      '@compute\n@bind let(0) rw f32\n@map idx <- let',
      ['idx'],
    );
    const result = emitRegion(input);
    // The binding is renamed to `__tw_<hash>` because `let` is a WGSL
    // keyword. The formula `let` must also use the hashed name; an
    // unrewritten `let` would shadow the WGSL keyword in the function
    // body. Storage declarations use `var<storage,...>` (not `let`),
    // so the verification pattern is on the storage declaration plus
    // the rewritten formula.
    expect(result.wgsl).toMatch(/var<storage, read_write> __tw_[0-9a-f]{8}: array<f32>/);
    expect(result.wgsl).toMatch(/let idx: f32 = __tw_[0-9a-f]{8};/);
    expect(result.wgsl).not.toMatch(/let let/);
  });

  it('binding rename takes priority over @map rename when both would rewrite an identifier (C-8)', () => {
    // The two rename passes can both target the same source name when
    // a user names their `@bind` and `@map` after the same identifier
    // (or when a Phase E `internalName` derivation also produces a
    // collision). The binding rewrite must win so the formula
    // resolves to the storage variable, not a `@map` let-binding.
    const { input } = makeVerdict(
      '@compute\n@bind let(0) rw f32\n@map let <- 0',
      ['let'],
    );
    const result = emitRegion(input);
    // `let` is renamed via `bindingRenames` (binding path) and ends
    // up in `renameTable` from the same source; the formula `0` has
    // nothing to rewrite, but the let-binding declaration must use the
    // hashed storage name, not the WGSL keyword `let`.
    expect(result.wgsl).toMatch(/let __tw_[0-9a-f]{8}: f32 = 0;/);
    expect(result.wgsl).not.toMatch(/^.*let let:.*$/m);
  });

  it('renames kernel parameter names so user `@map gid` does not shadow them', () => {
    const { input } = makeVerdict(
      '@compute\n@repeat R0:global_x = N\n@map gid <- 0\n@map lid <- 1\n@map wid <- 2',
      ['gid', 'lid', 'wid'],
    );
    const result = emitRegion(input);

    // Kernel params are `__tw_*` so user `gid`/`lid`/`wid` survive
    // verbatim (no collision with the kernel parameter names).
    expect(result.wgsl).toMatch(/@builtin\(global_invocation_id\) __tw_gid/);
    expect(result.wgsl).toMatch(/let gid: f32/);
    expect(result.wgsl).toMatch(/let lid: f32/);
    expect(result.wgsl).toMatch(/let wid: f32/);
  });

  it('emits cascaded maps in topological order', () => {
    const { input } = makeVerdict(
      '@compute\n@map a <- b + 1\n@map b <- 0',
      ['b', 'a'],
    );
    const result = emitRegion(input);

    expect(result.wgsl.indexOf('let b: f32')).toBeLessThan(result.wgsl.indexOf('let a: f32'));
  });

  it('gracefully emits an empty region body', () => {
    const { input } = makeVerdict('@compute\n@map value <- 1', ['value']);
    const result = emitRegion(input);

    expect(result.wgsl).toContain('let value: f32 = 1;');
    expect(result.wgsl.trimEnd().endsWith('}')).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('clamps dimensions and total workgroup invocations deterministically', () => {
    expect(
      clampWorkgroupSize(
        { x: 512, y: 8, z: 4 },
        {
          maxComputeWorkgroupSizeX: 256,
          maxComputeWorkgroupSizeY: 256,
          maxComputeWorkgroupSizeZ: 64,
          maxComputeInvocationsPerWorkgroup: 256,
        },
      ),
    ).toEqual({ x: 256, y: 1, z: 1 });
  });

  it('plumbs workgroupLimits into clampWorkgroupSize', () => {
    // Device with very low limits clamps the requested 64 down to 8.
    const { input } = makeVerdict(
      '@compute\n@workgroup_size(64)',
      [],
      {},
      {
        maxComputeWorkgroupSizeX: 8,
        maxComputeWorkgroupSizeY: 8,
        maxComputeWorkgroupSizeZ: 8,
        maxComputeInvocationsPerWorkgroup: 64,
      },
    );
    const result = emitRegion(input);
    expect(result.workgroupSize).toEqual({ x: 8, y: 1, z: 1 });
    expect(result.wgsl).toContain('@workgroup_size(8,1,1)');
    expect(result.diagnostics.some((d) => d.code === 'gpu.workgroup_size_clamped')).toBe(true);
  });

  it('substitutes generic integer division and exponentiation with diagnostics', () => {
    const { input } = makeVerdict(
      '@compute\n@map quotient <- a // b\n@map power <- base ^ exponent',
      ['quotient', 'power'],
    );
    const result = emitRegion(input);

    expect(result.wgsl).toContain('floor(a / b)');
    expect(result.wgsl).toContain('exp(base * log(exponent))');
    expect(result.diagnostics.some((item) => item.code === 'gpu.emitter_integer_division_substituted')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'gpu.emitter_generic_pow_substituted')).toBe(true);
  });

  it('emits list writes and nested arithmetic expressions', () => {
    const divide = block('divide', 'operator_divide', {
      inputs: { NUM1: 5, NUM2: 0 },
      parent: 'write',
    });
    const write = block('write', 'data_replaceitemoflist', {
      inputs: { INDEX: 1, ITEM: { id: 'divide' } },
      fields: { LIST: { name: 'buff_r' } },
      parent: 'repeat',
    });
    const { regionVerdict, input } = makeVerdict('@compute\n@bind buff_r(2) rw f32', []);
    const result = emitRegion({
      ...input,
      regionVerdict,
      parsedProject: makeProject([write, divide]),
    });

    expect(result.wgsl).toContain('scratch_list_write_f32(&buff_r');
    expect(result.wgsl).toContain('scratch_div(5.0, 0.0)');
    expect(result.diagnostics).toEqual([]);
  });

  it('emits byte dtype list writes via scratch_list_write_u32', () => {
    const write = block('write', 'data_replaceitemoflist', {
      inputs: { INDEX: 1, ITEM: { value: '128' } },
      fields: { LIST: { name: 'buff' } },
      parent: 'repeat',
    });
    const { regionVerdict, input } = makeVerdict('@compute\n@bind buff(2) rw byte', []);
    const result = emitRegion({
      ...input,
      regionVerdict,
      parsedProject: makeProject([write]),
    });
    expect(result.wgsl).toContain('array<u32>');
    expect(result.wgsl).toContain('scratch_list_write_u32(&buff');
  });

  it('emits byte dtype list reads via scratch_list_read_u32', () => {
    const read = block('read', 'data_itemoflist', {
      inputs: {
        LIST: { id: 'buff', name: 'LIST' },
        INDEX: { value: '1' },
      },
      fields: {},
      parent: 'repeat',
    });
    const { regionVerdict, input } = makeVerdict('@compute\n@bind buff(2) ro byte', []);
    const result = emitRegion({
      ...input,
      regionVerdict,
      parsedProject: makeProject([read]),
    });
    expect(result.wgsl).toContain('scratch_list_read_u32(&buff');
  });

  it('returns partial WGSL with a diagnostic for an unsupported opcode', () => {
    const random = block('random', 'operator_random', { parent: 'repeat' });
    const { regionVerdict, input } = makeVerdict('@compute', []);
    const result = emitRegion({
      ...input,
      regionVerdict,
      parsedProject: makeProject([random]),
    });

    expect(result.wgsl).toContain('@compute');
    expect(result.diagnostics.some((item) => item.code === 'gpu.emitter_unsupported_opcode')).toBe(true);
  });
});

describe('wgsl-emitter: u_scratch slot allocation (D-3, §19.2 #9)', () => {
  /**
   * §19.2 #9 — the WGSL emitter must move the uniforms struct out of
   * `@group(0) @binding(0)` so user `@bind` declarations can freely use
   * that slot. Without this guard, a region that wants
   * `@bind x(0) rw f32` would conflict with the implicit
   * `u_scratch` uniform, producing a WGSL validation error.
   *
   * The emitter pins `u_scratch` to `@group(1) @binding(0)`; we verify
   * the contract by inspecting the emitted WGSL for both groups.
   */
  it('emits uniforms struct at @group(1) @binding(0) so @group(0) @binding(0) is free', () => {
    const { input } = makeVerdict(
      [
        '@compute',
        '@bind x(0) rw f32',
        '@bind y(1) ro f32',
        '@bind z(2) rw i32',
        '@workgroup_size(64)',
        '@repeat R0:global_x = 64',
        '@map R0 <- 0',
      ].join('\n'),
      ['R0'],
    );
    const result = emitRegion(input);

    // Storage bindings occupy @group(0) — including slot 0.
    expect(result.wgsl).toContain('@group(0) @binding(0) var<storage, read_write> x: array<f32>;');
    expect(result.wgsl).toContain('@group(0) @binding(1) var<storage, read> y: array<f32>;');
    expect(result.wgsl).toContain('@group(0) @binding(2) var<storage, read_write> z: array<i32>;');
    // u_scratch lives at group 1, binding 0.
    expect(result.wgsl).toContain('@group(1) @binding(0) var<uniform> u_scratch: ScratchUniforms;');
    // Sanity: u_scratch must NEVER appear at @group(0).
    expect(result.wgsl).not.toMatch(/@group\(0\)\s+@binding\(0\)\s+var<uniform>\s+u_scratch/);
  });

  it('still emits a single u_scratch even when no @bind directives exist (regression)', () => {
    // Edge case: regions without any @bind still need u_scratch so the
    // runtime can plumb list lengths uniformly. The emitter falls back
    // to a `__tw_padding` placeholder so the struct isn't empty.
    const { input } = makeVerdict(
      ['@compute', '@workgroup_size(64)', '@repeat R0:global_x = 64', '@map R0 <- 0'].join('\n'),
      ['R0'],
    );
    const result = emitRegion(input);
    expect(result.wgsl).toContain('@group(1) @binding(0) var<uniform> u_scratch: ScratchUniforms;');
    expect(result.wgsl).toContain('__tw_padding: u32');
    // No @group(0) storage declarations — guard the absence.
    expect(result.wgsl).not.toMatch(/@group\(0\)\s+@binding\(/);
  });
});
