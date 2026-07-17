import { describe, expect, it } from 'vitest';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import {
  clampWorkgroupSize,
  emitRegion,
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
): RegionVerdict {
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
  return {
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
}

describe('wgsl-emitter', () => {
  it('emits a complete parallel compute module and dispatch plan', () => {
    const regionVerdict = makeVerdict(
      [
        '@compute',
        '@bind buff_r(2) rw f32',
        '@repeat R0:global_x = N, max=64',
        '@workgroup_size(64)',
        '@map R0 <- 0',
      ].join('\n'),
      ['R0'],
    );
    const result = emitRegion({ regionVerdict, parsedProject: makeProject() });

    expect(result.wgsl).toContain('fn scratch_div');
    expect(result.wgsl).toContain('@compute @workgroup_size(64,1,1)');
    expect(result.wgsl).toContain(
      '@group(0) @binding(2) var<storage, read_write> buff_r: array<f32>;',
    );
    expect(result.wgsl).toContain('dispatchWorkgroups(ceil(N / 64), 1, 1)');
  });

  it('wraps a sequential axis in a loop and dispatches one workgroup', () => {
    const regionVerdict = makeVerdict(
      '@compute\n@repeat R0:sequential = N\n@map R0 <- 0',
      ['R0'],
    );
    const result = emitRegion({ regionVerdict, parsedProject: makeProject() });

    expect(result.wgsl).toContain('for (let R0: u32 = 0; R0 < N; R0 = R0 + 1)');
    expect(result.wgsl).toContain('for (var R0: u32 = 0u;');
    expect(result.wgsl).toContain('dispatchWorkgroups(1, 1, 1)');
  });

  it('renames a reserved map identifier once', () => {
    const regionVerdict = makeVerdict('@compute\n@map compute <- 0', ['compute']);
    const result = emitRegion({ regionVerdict, parsedProject: makeProject() });

    expect(result.wgsl).toMatch(/let __tw_[0-9a-f]{8}: f32 = 0;/);
    expect(result.diagnostics.filter((item) => item.code === 'gpu.identifier_collision')).toHaveLength(1);
  });

  it('emits cascaded maps in topological order', () => {
    const regionVerdict = makeVerdict(
      '@compute\n@map a <- b + 1\n@map b <- 0',
      ['b', 'a'],
    );
    const result = emitRegion({ regionVerdict, parsedProject: makeProject() });

    expect(result.wgsl.indexOf('let b: f32')).toBeLessThan(result.wgsl.indexOf('let a: f32'));
  });

  it('gracefully emits an empty region body', () => {
    const regionVerdict = makeVerdict('@compute\n@map value <- 1', ['value']);
    const result = emitRegion({ regionVerdict, parsedProject: makeProject() });

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

  it('substitutes generic integer division and exponentiation with diagnostics', () => {
    const regionVerdict = makeVerdict(
      '@compute\n@map quotient <- a // b\n@map power <- base ^ exponent',
      ['quotient', 'power'],
    );
    const result = emitRegion({ regionVerdict, parsedProject: makeProject() });

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
    const regionVerdict = makeVerdict('@compute\n@bind buff_r(2) rw f32', []);
    const result = emitRegion({ regionVerdict, parsedProject: makeProject([write, divide]) });

    expect(result.wgsl).toContain('scratch_list_write_f32(&buff_r');
    expect(result.wgsl).toContain('scratch_div(5.0, 0.0)');
    expect(result.diagnostics).toEqual([]);
  });

  it('returns partial WGSL with a diagnostic for an unsupported opcode', () => {
    const random = block('random', 'operator_random', { parent: 'repeat' });
    const regionVerdict = makeVerdict('@compute', []);
    const result = emitRegion({ regionVerdict, parsedProject: makeProject([random]) });

    expect(result.wgsl).toContain('@compute');
    expect(result.diagnostics.some((item) => item.code === 'gpu.emitter_unsupported_opcode')).toBe(true);
  });
});
