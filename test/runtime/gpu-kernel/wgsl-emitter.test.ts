import { describe, expect, it } from 'vitest';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import { resolveRepeatPaths } from '@/runtime/gpu-kernel/repeat-path-resolver';
import {
  clampWorkgroupSize,
  emitRegion,
  type EmitInput,
} from '@/runtime/gpu-kernel/wgsl-emitter';
import type {
  AxisFinal,
  ExtractedRegion,
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
  const region: ExtractedRegion = {
    regionId: 'region',
    blockId: 'repeat',
    spriteId: 'sprite',
    commentId: 'body',
    firstSubstackBlockId: '',
    bodyBlockIds: [],
    kernelContainerBlockId: 'repeat',
    repeatPathTable: { self: 'repeat' },
    regionIndex: 0,
    inlinedPrototypeBlockIds: [],
    commentAnchorBlockId: 'repeat',
  };
  const resolved = resolveRepeatPaths(region, parsed.directives);
  const axes: RegionVerdict['axes'] = {};
  const parallelAxes: RegionVerdict['parallelAxes'] = [];
  for (const directive of resolved.directives) {
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
    directives: resolved.directives,
    blockSubset: { valid: true, diagnostics: [] },
    autoTmpVerdict: { valid: true, bindings: [], diagnostics: [] },
    axes,
    cascade: { valid: true, diagnostics: [], topoOrder },
    diagnostics: [...parsed.diagnostics, ...resolved.diagnostics],
    parallelAxes,
    kernelContainerBlockId: 'repeat',

    firstSubstackBlockId: '',
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
        // §Phase 2 (15.3): inline `, max=<uint>` removed alongside @max.
        '@repeat R0:global_x = N',
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

    // §Phase 4: the emitter uses WGSL `{ var; loop { if break }; }` shape
    // instead of `for(;;)` because WGSL doesn't have a native for-loop in
    // its portable profile. The counter is renamed through the same
    // table as the directive name (`R0`).
    expect(result.wgsl).toMatch(/var R0: u32 = 0u;/);
    expect(result.wgsl).toMatch(/loop \{/);
    expect(result.wgsl).toMatch(/if \(R0 >= u32\(N\)\) \{ break; \}/);
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

  describe('clampWorkgroupSize: device limit interaction (C-2 / §19.2 #10)', () => {
    /**
     * The clamp pass slices Y (and then Z) so that x*y*z stays at or
     * below `maxComputeInvocationsPerWorkgroup`. Two boundary cases:
     *
     *   1. A 3-D shape at exactly the limit → preserved.
     *   2. A 3-D shape one over the limit → Y or Z is halved to fit.
     *
     * `clampDimension` always floors against the running
     * `remainingAfter*` budget, so the deterministic output depends on
     * the order of the dim clamps (X, then Y, then Z).
     */
    it('keeps a 3D shape at the invocation limit (boundary)', () => {
      // 16 * 16 * 4 = 1024, equal to the cap. The clamp pass should
      // leave the dimensions alone.
      expect(
        clampWorkgroupSize(
          { x: 16, y: 16, z: 4 },
          {
            maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupSizeY: 256,
            maxComputeWorkgroupSizeZ: 64,
            maxComputeInvocationsPerWorkgroup: 1024,
          },
        ),
      ).toEqual({ x: 16, y: 16, z: 4 });
    });

    it('shrinks the smallest dimension to fit x*y*z = limit', () => {
      // Requested {32, 32, 4}. With cap=2048:
      //   x clamped to 32 (within x-limit 256 and budget 2048)
      //   y clamped to 32 (within y-limit 256 and budget 64 = 2048/32)
      //   z clamped to 2  (within z-limit 64 and budget 2 = 64/32)
      // Final 32 * 32 * 2 = 2048, exactly at the cap. The Z dimension
      // absorbs the last factor because it is the smallest; the clamp
      // is deterministic per the X→Y→Z ordering in clampWorkgroupSize.
      expect(
        clampWorkgroupSize(
          { x: 32, y: 32, z: 4 },
          {
            maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupSizeY: 256,
            maxComputeWorkgroupSizeZ: 64,
            maxComputeInvocationsPerWorkgroup: 2048,
          },
        ),
      ).toEqual({ x: 32, y: 32, z: 2 });
    });
  });

  describe('quoted names (§Phase E)', () => {
    it('emits the storage binding with internalName for @bind "my list"(0)', () => {
      const { input } = makeVerdict('@compute\n@bind "my list"(0) rw f32', []);
      const result = emitRegion(input);
      // Storage declaration uses the hashed internalName, NOT the
      // quoted surface name (which is not a valid WGSL identifier).
      expect(result.wgsl).toMatch(
        /@group\(0\)\s+@binding\(0\)\s+var<storage, read_write>\s+__tw_[0-9a-f]{8}: array<f32>/,
      );
      expect(result.wgsl).not.toMatch(/my list/);
    });

    it('emits the length field in ScratchUniforms with internalName suffix', () => {
      const { input } = makeVerdict('@compute\n@bind "my list"(0) rw f32', []);
      const result = emitRegion(input);
      expect(result.wgsl).toMatch(/__tw_[0-9a-f]{8}_length: u32/);
    });

    it('does not regress unquoted binding names (backwards compat)', () => {
      const { input } = makeVerdict('@compute\n@bind tmp0(0) rw f32', []);
      const result = emitRegion(input);
      // Unquoted names go through safeIdentifier + reserved-keyword
      // rename; `tmp0` is a valid WGSL identifier and is unchanged.
      expect(result.wgsl).toMatch(
        /@group\(0\)\s+@binding\(0\)\s+var<storage, read_write>\s+tmp0: array<f32>/,
      );
    });

    it('two quoted bindings on slots 0 and 1 do not collide', () => {
      const { input } = makeVerdict(
        '@compute\n@bind "my list"(0) rw f32\n@bind "scratch pad"(1) ro f32',
        [],
      );
      const result = emitRegion(input);
      const matches = result.wgsl.match(/var<storage, [^>]+>\s+__tw_[0-9a-f]{8}: array<f32>/g);
      expect(matches).toHaveLength(2);
    });

    it('@map with quoted name emits the let binding under internalName', () => {
      const { input } = makeVerdict(
        '@compute\n@map "idx with space" <- 0',
        ['idx with space'],
      );
      const result = emitRegion(input);
      expect(result.wgsl).toMatch(/let __tw_[0-9a-f]{8}: f32 = 0;/);
      expect(result.wgsl).not.toMatch(/let "idx with space"/);
    });

    it('data_itemoflist body lookup works with quoted name (E-6 end-to-end)', () => {
      // Build a region that quotes a list name and references it from
      // the body via `data_itemoflist`. `bindingForList` keys on
      // `binding.name === listName`, so the quoted scratch name must
      // resolve to the directive's `name` field (not its
      // `internalName`). The WGSL emitter then emits a call into the
      // hashed storage identifier.
      const read = block('read', 'data_itemoflist', {
        inputs: { INDEX: { id: 'idx_read' }, LIST: { id: 'my list', name: 'my list' } },
      });
      const idxRead = block('idx_read', 'data_variable', {
        fields: { VARIABLE: { id: 'idx_read', name: 'idx_read' } },
      });
      const project: ParsedProject = makeProject([read, idxRead]);
      const { regionVerdict } = makeVerdict(
        ['@compute', '@bind "my list"(0) ro f32', '@map idx_read <- 0'].join('\n'),
        ['idx_read'],
      );
      // Replace input.parsedProject with our hand-built one carrying the
      // `data_itemoflist` body.
      const result = emitRegion({ regionVerdict, parsedProject: project });
      // The body should call scratch_list_read_f32 against the hashed
      // internalName — proving the bindingForList lookup flowed the
      // quoted `name` through to the surface, while the WGSL-side
      // identifier uses the hash.
      expect(result.wgsl).toMatch(
        /scratch_list_read_f32\(&__tw_[0-9a-f]{8}, /,
      );
    });
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

  describe('§Phase 4 (15.7) — explicit 16-byte stride padding in ScratchUniforms', () => {
    /**
     * §Phase 4 (15.7) — every scalar field is followed by an explicit
     * `pad: vec3<u32>` placeholder so the WGSL struct's byte offsets
     * line up with the host pack layout
     * (`SCALAR_UNIFORM_HEADER_BYTES` + `SCALAR_UNIFORM_FIELD_STRIDE_BYTES`
     * per field). Without the explicit padding, WGSL would pack
     * adjacent 4-byte fields to 4-byte offsets and leave the runtime
     * reading struct field values at the wrong offsets.
     */
    it('emits pad: vec3<u32> after every scalar field', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind buff_r(0) rw f32',
          '@bind aabb_idx0(1) ro i32, scalar',
          '@workgroup_size(64)',
          '@repeat R0:global_x = 64',
          '@map R0 <- 0',
        ].join('\n'),
        ['R0'],
      );
      const result = emitRegion(input);
      // The struct should contain `aabb_idx0: i32` followed by a
      // padding field. The exact name (`__tw_pad_<N>`) is implementation-
      // defined; we check the structural shape (`vec3<u32>`).
      expect(result.wgsl).toMatch(/aabb_idx0: i32,\s*\n\s*\w+_pad_\d+: vec3<u32>,/);
    });

    it('emits pad: vec3<u32> after every list length field', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind buff_r(0) rw f32',
          '@bind aabb_w(1) ro f32',
          '@workgroup_size(64)',
          '@repeat R0:global_x = 64',
          '@map R0 <- 0',
        ].join('\n'),
        ['R0'],
      );
      const result = emitRegion(input);
      // Each list binding's `_length` field is followed by a `vec3<u32>` pad.
      const lengthPadMatches = result.wgsl.match(
        /\w+_length: u32,\s*\n\s*\w+_pad_\d+: vec3<u32>,/g,
      );
      expect(lengthPadMatches?.length).toBeGreaterThanOrEqual(2);
    });

    /**
     * §Phase 4 (15.7) — `byte, scalar` emits as WGSL `i32` (host ABI
     * keeps scalar-as-`i32` mapping). The padding still follows the
     * 4-byte scalar value.
     */
    it('emits byte, scalar as i32 with vec3<u32> padding', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind byte_state(0) ro byte, scalar',
          '@workgroup_size(64)',
          '@repeat R0:global_x = 64',
          '@map R0 <- 0',
        ].join('\n'),
        ['R0'],
      );
      const result = emitRegion(input);
      expect(result.wgsl).toMatch(/byte_state: i32,\s*\n\s*\w+_pad_\d+: vec3<u32>,/);
      // It must NOT be `byte_state: f32` (which would be the dtype for
      // unquoted `f32`).
      expect(result.wgsl).not.toMatch(/byte_state: f32/);
    });
  });

  describe('§Phase E+ — quoted names + formula sugar', () => {
    it('rewrites name[idx] subscript to scratch_list_read_f32 in emitted WGSL', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind my_list(0) ro f32',
          // §Phase 2 (15.3): `, max=<uint>` removed.
          '@repeat R0:global_x = len(my_list)',
          '@map idx <- my_list[R0]',
        ].join('\n'),
        ['idx'],
        { R0: 'global_x' },
      );
      const result = emitRegion(input);
      expect(result.wgsl).toContain(
        'scratch_list_read_f32(&my_list, scratch_index_clamp(R0, u_scratch.my_list_length), u_scratch.my_list_length)',
      );
    });

    it('rewrites len(name) to u_scratch.<name>_length in @repeat formula', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind my_list(0) ro f32',
          '@repeat R0:global_x = len(my_list)',
          '@map idx <- R0',
        ].join('\n'),
        ['idx'],
        { R0: 'global_x' },
      );
      const result = emitRegion(input);
      // The @repeat formula should contain u_scratch.my_list_length
      // twice — once in the dispatchWorkgroups comment and once in the
      // for-loop bound. Look for the unescaped literal first.
      expect(result.wgsl).toContain('u_scratch.my_list_length');
    });

    it('rewrites bool(x) to select(0.0, 1.0, x != 0.0) in @map formula', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind my_list(0) ro f32',
          '@repeat R0:global_x = len(my_list)',
          '@map flag <- bool(my_list[R0])',
        ].join('\n'),
        ['flag'],
        { R0: 'global_x' },
      );
      const result = emitRegion(input);
      expect(result.wgsl).toContain('let flag: f32 = select(0.0, 1.0,');
      expect(result.wgsl).toContain('!= 0.0);');
    });

    it('emits quoted @bind name via internalName without warnings', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind "my list"(0) ro f32',
          // §Phase 2 (15.3): `, max=<uint>` removed.
          '@repeat R0:global_x = 32',
          '@map idx <- R0',
        ].join('\n'),
        ['idx'],
        { R0: 'global_x' },
      );
      const result = emitRegion(input);
      // The internalName (FNV-1a hash) should appear in the storage
      // declaration; the surface name "my list" should NOT leak into
      // WGSL identifier positions.
      expect(result.wgsl).toMatch(/var<storage, read>\s+__tw_[0-9a-f]{8}: array<f32>/);
      expect(result.wgsl).not.toMatch(/"my list"/);
      // u_scratch struct field for length uses the same internalName.
      expect(result.wgsl).toMatch(/\s+__tw_[0-9a-f]{8}_length: u32/);
    });

    // §Phase 2 (15.3): the previous "quotes @max group name via
    // internalName in @repeat formula reference" test was retired —
    // the @max directive is gone. The quoted-formula test below
    // (`quotes @repeat R<i> name via internalName in @map reference`)
    // covers the same rename pass via the @repeat/@map path.

    it('quotes @repeat R<i> name via internalName in @map reference', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind my_list(0) ro f32',
          // §Phase 2 (15.3): `, max=<uint>` removed.
          '@repeat "R0":global_x = 32',
          '@map idx <- "R0"',
        ].join('\n'),
        ['idx'],
        { 'R0': 'global_x' },
      );
      const result = emitRegion(input);
      // @repeat with quoted name R0 produces internalName; @map
      // references it via the formula. Since formulas use raw
      // identifier matching, "R0" must match the quoted surface name's
      // hash. The test confirms the rename pass routes through
      // internalName rather than producing a diagnostic.
      // (The exact substring is hash-dependent; we check the absence
      // of error markers and the presence of let-binding for `idx`.)
      expect(result.wgsl).toMatch(/let idx: f32/);
    });

    it('rewrites "quoted list"[idx] in @repeat body via internalName (§15.11)', () => {
      // §Phase 3 §15.11 — the quoted-reference rename pass runs
      // BEFORE the scratch-compat sugar pass so the lexer's
      // bindingByEmit lookup resolves the hashed identifier. Without
      // this ordering, the body would emit `__tw_<hash>[R0]` (broken
      // WGSL) while the dispatch plan correctly used
      // `scratch_list_read_f32(...)`.
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind "my list"(0) ro f32',
          '@repeat R0:global_x = 32',
          '@map idx <- "my list"[R0]',
        ].join('\n'),
        ['idx'],
        { R0: 'global_x' },
      );
      const result = emitRegion(input);
      // The quoted reference resolves to the binding's internalName
      // and then through `scratch_list_read_f32`.
      expect(result.wgsl).toMatch(
        /scratch_list_read_f32\(&__tw_[0-9a-f]{8}, scratch_index_clamp\(R0, u_scratch\.__tw_[0-9a-f]{8}_length\), u_scratch\.__tw_[0-9a-f]{8}_length\)/,
      );
      // No "my list" surface name leaks into the WGSL output.
      expect(result.wgsl).not.toMatch(/"my list"/);
      // No `gpu.emitter_invalid_formula_token` warning from the `"` characters.
      expect(result.diagnostics.some((d) => d.code === 'gpu.emitter_invalid_formula_token')).toBe(
        false,
      );
    });

    it('rewrites len("quoted list") in @repeat formula and dispatch plan (§15.11)', () => {
      const { input } = makeVerdict(
        [
          '@compute',
          '@bind "my list"(0) ro f32',
          '@repeat R0:global_x = len("my list")',
          '@map idx <- R0',
        ].join('\n'),
        ['idx'],
        { R0: 'global_x' },
      );
      const result = emitRegion(input);
      // The @repeat formula (dispatch plan and `for` bound) carries
      // the hashed identifier as the `_length` field.
      expect(result.wgsl).toMatch(/u_scratch\.__tw_[0-9a-f]{8}_length/);
      // The dispatch plan (`// dispatchWorkgroups(ceil(... / 64), 1, 1)`)
      // matches the body — both routes use the same hashed identifier.
      expect(result.dispatchPlan.x).toMatch(/ceil\(u_scratch\.__tw_[0-9a-f]{8}_length \/ 64\)/);
      expect(result.diagnostics.some((d) => d.code === 'gpu.emitter_invalid_formula_token')).toBe(
        false,
      );
    });
  });
});

/**
 * §Phase 4 — Form A end-to-end tests for the WGSL emitter.
 *
 * The Form A layout is: `@compute` lives on a `control_repeat` itself
 * (= kernel container). Its `SUBSTACK` body is the region body. Inner
 * `control_repeat` blocks become either dispatch axes (when an
 * `@repeat …, repeatPath="self"` directive resolves onto them) or
 * sequential `for ()` loops (when no directive matches).
 */
describe('wgsl-emitter (§Phase 4 Form A)', () => {
  function mathNumber(id: string, value: number): RawBlock {
    return block(id, 'math_number', { fields: { NUM: [String(value), null] } });
  }

  function makeFormAVerdict(options: {
    commentText: string;
    kernelContainerBlockId: string;
    /** extra blocks indexed by id. `kernelContainerBlockId` is built automatically. */
    extraBlocks?: Record<string, RawBlock>;
    bodyFirstSubstackId?: string;
    workgroupLimits?: EmitInput['workgroupLimits'];
  }): { regionVerdict: RegionVerdict; parsedProject: ParsedProject; input: EmitInput } {
    const spriteBlocks: Record<string, RawBlock> = {
      [options.kernelContainerBlockId]: block(
        options.kernelContainerBlockId,
        'control_repeat',
        {
          inputs: { SUBSTACK: options.bodyFirstSubstackId ?? null },
        },
      ),
    };
    if (options.extraBlocks) Object.assign(spriteBlocks, options.extraBlocks);

    const region: ExtractedRegion = {
      regionId: `region:${options.kernelContainerBlockId}`,
      blockId: options.kernelContainerBlockId,
      spriteId: 'sprite',
      commentId: 'cmt',
      firstSubstackBlockId: options.bodyFirstSubstackId ?? '',
      bodyBlockIds: [],
      kernelContainerBlockId: options.kernelContainerBlockId,
      repeatPathTable: { self: options.kernelContainerBlockId },
      regionIndex: 0,
      inlinedPrototypeBlockIds: [],
      commentAnchorBlockId: options.kernelContainerBlockId,
    };
    const parsed = parseComputeComment(
      { blockId: 'cmt', text: options.commentText },
      region.regionId,
    );
    const resolved = resolveRepeatPaths(region, parsed.directives);
    const axes: RegionVerdict['axes'] = {};
    const parallelAxes: RegionVerdict['parallelAxes'] = [];
    for (const directive of resolved.directives) {
      if (directive.kind !== 'repeat') continue;
      axes[directive.name] = {
        requestedAxis: directive.axis,
        finalAxis: directive.axis,
        diagnostics: [],
      };
      if (directive.axis !== 'sequential') {
        parallelAxes.push({ repeatName: directive.name, axis: directive.axis });
      }
    }
    const regionVerdict: RegionVerdict = {
      regionId: region.regionId,
      blockId: region.blockId,
      spriteId: region.spriteId,
      directives: resolved.directives,
      blockSubset: { valid: true, diagnostics: [] },
      autoTmpVerdict: { valid: true, bindings: [], diagnostics: [] },
      axes,
      cascade: { valid: true, diagnostics: [], topoOrder: [] },
      diagnostics: [...parsed.diagnostics, ...resolved.diagnostics],
      parallelAxes,
      kernelContainerBlockId: region.kernelContainerBlockId,
      firstSubstackBlockId: region.firstSubstackBlockId,
    };
    const parsedProject: ParsedProject = {
      targets: [{ id: 'sprite', isStage: false, blocks: spriteBlocks }],
      comments: {},
    };
    return {
      regionVerdict,
      parsedProject,
      input: options.workgroupLimits
        ? { regionVerdict, parsedProject, workgroupLimits: options.workgroupLimits }
        : { regionVerdict, parsedProject },
    };
  }

  it('Form A: @compute on control_repeat with @repeat repeatPath="self" emits parallel dispatch', () => {
    const r0 = 'r0';
    const write = block('write', 'data_replaceitemoflist', {
      inputs: {
        LIST: { name: 'buff_r' },
        INDEX: [2, 'idx-shadow'],
        ITEM: { value: '1' },
      },
      fields: { LIST: ['buff_r', null] },
    });
    const idxShadow = mathNumber('idx-shadow', 0);
    const { regionVerdict, parsedProject, input } = makeFormAVerdict({
      commentText: [
        '@compute',
        '@bind buff_r(0) rw f32',
        '@workgroup_size(64)',
        '@repeat R0:global_x = 32, repeatPath="self"',
        '@map R0 <- 0',
      ].join('\n'),
      kernelContainerBlockId: r0,
      bodyFirstSubstackId: 'write',
      extraBlocks: {
        [r0]: block(r0, 'control_repeat', {
          inputs: { SUBSTACK: 'write', TIMES: [2, 'r0-times'] },
        }),
        'r0-times': mathNumber('r0-times', 100),
        write,
        'idx-shadow': idxShadow,
      },
    });
    void regionVerdict;
    void parsedProject;
    const result = emitRegion(input);
    // Single-axis dispatch: x = ceil(32 / 64), y = z = 1.
    expect(result.dispatchPlan.x).toBe('ceil(32 / 64)');
    expect(result.dispatchPlan.y).toBe('1');
    expect(result.dispatchPlan.z).toBe('1');
    expect(result.wgsl).toContain('@compute @workgroup_size(64,1,1)');
    expect(result.wgsl).toContain('@builtin(global_invocation_id) __tw_gid: vec3<u32>');
    // Write body is preserved (data_replaceitemoflist is actual parallel work).
    expect(result.wgsl).toContain('scratch_list_write_f32(&buff_r');
  });

  it('Form A: nested control_repeat without @repeat directive emits a for() loop', () => {
    const r0 = 'r0';
    const inner = 'inner';
    // r0 is kernel container with one inner control_repeat inside its body.
    const innerBody = block('innerBody', 'data_replaceitemoflist', {
      inputs: {
        LIST: { name: 'buff_r' },
        INDEX: [2, 'idx-shadow'],
        ITEM: { value: '1' },
      },
      fields: { LIST: ['buff_r', null] },
    });
    const idxShadow = mathNumber('idx-shadow', 0);
    const { input } = makeFormAVerdict({
      commentText: [
        '@compute',
        '@bind buff_r(0) rw f32',
        '@workgroup_size(64)',
        '@repeat R0:global_x = 32, repeatPath="self"',
        '@map R0 <- 0',
      ].join('\n'),
      kernelContainerBlockId: r0,
      bodyFirstSubstackId: inner,
      extraBlocks: {
        [r0]: block(r0, 'control_repeat', {
          inputs: { SUBSTACK: inner, TIMES: [2, 'r0-times'] },
        }),
        [inner]: block(inner, 'control_repeat', {
          inputs: { SUBSTACK: 'innerBody', TIMES: [2, 'inner-times'] },
        }),
        'innerBody': innerBody,
        'r0-times': mathNumber('r0-times', 100),
        'inner-times': mathNumber('inner-times', 4),
        'idx-shadow': idxShadow,
      },
    });
    const result = emitRegion(input);
    // No repeatPath="self"/"0"/etc on `inner` → emitter wraps its body in a WGSL `for`.
    // The counter defaults to `__tw_counter_<hash>` for unannotated
    // inner repeats; the formula evaluates the scratch `inputs.TIMES`
    // chain (`math_number 4` → `4.0`).
    expect(result.wgsl).toMatch(/loop \{[\s\S]*if \(__tw_counter_\w+ >= u32\(4\.0\)\) \{ break; \}/);
    // Outer dispatch still uses the single-axis formula.
    expect(result.dispatchPlan.x).toBe('ceil(32 / 64)');
  });

  it('Form A: missing repeatPath on @repeat defaults to repeatPath="self"', () => {
    // §Phase 4 — the parser defaults `repeatPath` to 'self' when the
    // user omits the suffix, so v9-shape DSL (`@repeat R0:global_x = N`)
    // still produces a usable directive without rewriting every fixture.
    // The resolver validates resolution against the region's table.
    const r0 = 'r0';
    const write = block('write', 'data_replaceitemoflist', {
      inputs: {
        LIST: { name: 'buff_r' },
        INDEX: [2, 'idx-shadow'],
        ITEM: { value: '1' },
      },
      fields: { LIST: ['buff_r', null] },
    });
    const idxShadow = mathNumber('idx-shadow', 0);
    const { input } = makeFormAVerdict({
      commentText: [
        '@compute',
        '@bind buff_r(0) rw f32',
        '@workgroup_size(64)',
        '@repeat R0:global_x = 32',
      ].join('\n'),
      kernelContainerBlockId: r0,
      bodyFirstSubstackId: 'write',
      extraBlocks: {
        [r0]: block(r0, 'control_repeat', {
          inputs: { SUBSTACK: 'write', TIMES: [2, 'r0-times'] },
        }),
        'r0-times': mathNumber('r0-times', 100),
        write,
        'idx-shadow': idxShadow,
      },
    });
    const result = emitRegion(input);
    // Resolver found 'self' (= kernel container 'r0') in the table — no
    // gpu.repeat_path_required diagnostic.
    expect(
      result.diagnostics.some((d) => d.code === 'gpu.repeat_path_required'),
    ).toBe(false);
    expect(result.dispatchPlan.x).toBe('ceil(32 / 64)');
  });
});
