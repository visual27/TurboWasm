import { describe, expect, it } from 'vitest';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import type { ParsedComment } from '@/runtime/gpu-kernel/types';

const REGION = 'region:sprite1:repeat0';

function mkComment(text: string, blockId = 'blk'): ParsedComment {
  return { blockId, text };
}

describe('comment-parser', () => {
  it('parses @bind, @max, @workgroup_size, @repeat, @map in a single comment', () => {
    const text = [
      '@compute',
      '@bind scratch_list(0) rw f32',
      '@bind tmp0(1) ro',
      '@max length=1024',
      '@max aabb_width=128',
      '@workgroup_size(64)',
      '@repeat R0:global_x = aabb_width, max=1024',
      '@map idx0 <- R0',
    ].join('\n');

    const result = parseComputeComment(mkComment(text), REGION);
    expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    // `@compute` is a marker, not a directive — the parser silently skips it.
    expect(result.directives).toHaveLength(7);
    const binds = result.directives.filter((d) => d.kind === 'bind');
    expect(binds).toHaveLength(2);
    const firstBind = binds[0];
    expect(firstBind).toMatchObject({ kind: 'bind', name: 'scratch_list', slot: 0, readOnly: false, dtype: 'f32' });
    const secondBind = binds[1];
    expect(secondBind).toMatchObject({ kind: 'bind', name: 'tmp0', slot: 1, readOnly: true, dtype: 'f32' });
    const repeat = result.directives.find((d) => d.kind === 'repeat');
    expect(repeat).toMatchObject({ kind: 'repeat', name: 'R0', axis: 'global_x', max: 1024 });
    const map = result.directives.find((d) => d.kind === 'map');
    expect(map).toMatchObject({ kind: 'map', var: 'idx0' });
  });

  describe('quoted names (§Phase E)', () => {
    it('parses @bind "my list"(0) rw f32 with hashed internalName', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind "my list"(0) rw f32'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({
        kind: 'bind',
        name: 'my list',
        slot: 0,
        readOnly: false,
        dtype: 'f32',
      });
      // internalName is FNV-1a hash of 'my list' (salt=0).
      expect((bind as { internalName?: string }).internalName).toMatch(/^__tw_[0-9a-f]{8}$/);
      // No diagnostics — quoted name is valid.
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it('keeps an unquoted name without internalName (backwards compat)', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind tmp0(0) rw f32'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({ kind: 'bind', name: 'tmp0', slot: 0, dtype: 'f32' });
      expect((bind as { internalName?: string }).internalName).toBeUndefined();
    });

    it('escapes \\" inside a quoted name', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind "weird\\"name"(0) ro'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({ kind: 'bind', name: 'weird"name' });
    });

    it('escapes \\\\ inside a quoted name', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind "back\\\\slash"(0) ro'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({ kind: 'bind', name: 'back\\slash' });
    });

    it('reports an empty quoted name as a diagnostic', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind ""(0) ro'),
        REGION,
      );
      expect(result.directives.find((d) => d.kind === 'bind')).toBeUndefined();
      expect(result.diagnostics.some((d) => d.message.includes('empty quoted name'))).toBe(true);
    });

    it('reports a non-identifier, non-quoted @bind name as a malformed directive', () => {
      // §Phase E+: the @bind body parser splits on `(` and runs the
      // name through `parseNameToken`, so the rejection surfaces as
      // the per-token "expected identifier or quoted name" diagnostic
      // rather than the broader "malformed @bind" shape.
      const result = parseComputeComment(
        mkComment('@compute\n@bind my-list(0) ro'),
        REGION,
      );
      expect(result.directives.find((d) => d.kind === 'bind')).toBeUndefined();
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('expected identifier or quoted name'),
        ),
      ).toBe(true);
    });

    it('reports a non-identifier, non-quoted @map var name via parseNameToken', () => {
      // `@map` is permissive enough that `my-list` slips past the
      // arrow split, so parseNameToken is the one that fires.
      const result = parseComputeComment(
        mkComment('@compute\n@map my-list <- 0'),
        REGION,
      );
      expect(result.directives.find((d) => d.kind === 'map')).toBeUndefined();
      expect(
        result.diagnostics.some((d) =>
          d.message.includes('expected identifier or quoted name'),
        ),
      ).toBe(true);
    });

    it('parses @map "idx with space" <- 0', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@map "idx with space" <- 0'),
        REGION,
      );
      const map = result.directives.find((d) => d.kind === 'map');
      expect(map).toMatchObject({ kind: 'map', var: 'idx with space', formula: '0' });
      expect((map as { internalName?: string }).internalName).toMatch(/^__tw_[0-9a-f]{8}$/);
    });

    it('parses an unquoted @map var without internalName (backwards compat)', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@map idx <- 0'),
        REGION,
      );
      const map = result.directives.find((d) => d.kind === 'map');
      expect(map).toMatchObject({ kind: 'map', var: 'idx', formula: '0' });
      expect((map as { internalName?: string }).internalName).toBeUndefined();
    });
  });

  describe('quoted names in @max / @repeat (§Phase E+)', () => {
    it('parses @max "my group"=64 with internalName', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@max "my group"=64'),
        REGION,
      );
      const max = result.directives.find((d) => d.kind === 'max');
      expect(max).toMatchObject({ kind: 'max', name: 'my group', value: 64 });
      expect((max as { internalName?: string }).internalName).toMatch(/^__tw_[0-9a-f]{8}$/);
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it('parses @max length=1024 without internalName (backwards compat)', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@max length=1024'),
        REGION,
      );
      const max = result.directives.find((d) => d.kind === 'max');
      expect(max).toMatchObject({ kind: 'max', name: 'length', value: 1024 });
      expect((max as { internalName?: string }).internalName).toBeUndefined();
    });

    it('parses @repeat "R0":global_x = N with quoted name and quoted axis', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat "R0":"global_x" = 64'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({ kind: 'repeat', name: 'R0', axis: 'global_x', formula: '64' });
      expect((repeat as { internalName?: string }).internalName).toMatch(/^__tw_[0-9a-f]{8}$/);
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it('parses @repeat R0:"axis name" = N with quoted axis only', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat R0:"axis name" = 32'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      // Unknown axis values fall back to 'sequential' (per normalizeAxis)
      expect(repeat).toMatchObject({ kind: 'repeat', name: 'R0', axis: 'sequential', formula: '32' });
    });

    it('parses @repeat R0:global_x = "my group" with quoted formula reference', () => {
      // The formula text "my group" is opaque to the parser; the
      // @max-renamed reference surfaces in the WGSL emitter, not here.
      const result = parseComputeComment(
        mkComment('@compute\n@max "my group"=64\n@repeat R0 = "my group"'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({ kind: 'repeat', name: 'R0', axis: 'sequential', formula: '"my group"' });
    });

    it('reports an empty quoted @max name as a diagnostic', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@max ""=64'),
        REGION,
      );
      expect(result.directives.find((d) => d.kind === 'max')).toBeUndefined();
      expect(result.diagnostics.some((d) => d.message.includes('empty quoted name'))).toBe(true);
    });

    it('reports an empty quoted @repeat name as a diagnostic', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat "" = 64'),
        REGION,
      );
      expect(result.directives.find((d) => d.kind === 'repeat')).toBeUndefined();
      expect(result.diagnostics.some((d) => d.message.includes('empty quoted name'))).toBe(true);
    });

    it('keeps an unquoted @repeat name without internalName (backwards compat)', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat R0:global_x = 64'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({ kind: 'repeat', name: 'R0', axis: 'global_x', formula: '64' });
      expect((repeat as { internalName?: string }).internalName).toBeUndefined();
    });
  });

  it('flags an unknown directive', () => {
    const text = '@compute\n@bogus foo\n';
    const result = parseComputeComment(mkComment(text), REGION);
    expect(result.directives).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('gpu.dsl_syntax_error');
    expect(result.diagnostics[0]?.message).toContain("@bogus");
  });

  it('reports a malformed @repeat without `=`', () => {
    const text = '@compute\n@repeat R0\n';
    const result = parseComputeComment(mkComment(text), REGION);
    expect(result.directives.filter((d) => d.kind === 'repeat')).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.message.includes("missing '=..."))).toBe(true);
  });

  it('rejects an unknown @bind dtype', () => {
    const text = '@compute\n@bind tmp0(0) ro f64\n';
    const result = parseComputeComment(mkComment(text), REGION);
    const bind = result.directives.find((d) => d.kind === 'bind');
    expect(bind).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes('@bind'))).toBe(true);
  });

  it('tolerates CRLF and TAB', () => {
    const text = '@compute\r\n@bind\ttmp0(0)\tro\r\n@repeat R0 = x\r\n';
    const result = parseComputeComment(mkComment(text), REGION);
    expect(result.directives.filter((d) => d.kind === 'bind')).toHaveLength(1);
    expect(result.directives.filter((d) => d.kind === 'repeat')).toHaveLength(1);
  });

  it('is case-insensitive on directive heads', () => {
    const text = '@Compute\n@BIND tmp0(0) ro\n@REPEAT R0:local_y = idx\n';
    const result = parseComputeComment(mkComment(text), REGION);
    expect(result.directives.filter((d) => d.kind === 'bind')).toHaveLength(1);
    expect(result.directives.filter((d) => d.kind === 'repeat')).toHaveLength(1);
  });

  it('parses @workgroup_size with 1, 2, or 3 components', () => {
    const one = parseComputeComment(mkComment('@compute\n@workgroup_size(8)'), REGION);
    expect(one.directives.find((d) => d.kind === 'workgroup_size')).toMatchObject({ x: 8, y: 1, z: 1 });

    const two = parseComputeComment(mkComment('@compute\n@workgroup_size(8,4)'), REGION);
    expect(two.directives.find((d) => d.kind === 'workgroup_size')).toMatchObject({ x: 8, y: 4, z: 1 });

    const three = parseComputeComment(mkComment('@compute\n@workgroup_size(8,4,2)'), REGION);
    expect(three.directives.find((d) => d.kind === 'workgroup_size')).toMatchObject({ x: 8, y: 4, z: 2 });
  });

  describe('boundBlockId suffix (§Phase 0, nested parallelization)', () => {
    it("'@repeat' accepts trailing blockId=\"<id>\" suffix", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = N, blockId="abc"'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({
        kind: 'repeat',
        name: 'Rx',
        axis: 'global_x',
        formula: 'N',
        boundBlockId: 'abc',
      });
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it("'@repeat' accepts blockId=\"<id>\" combined with max=", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = N, max=64, blockId="abc"'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({
        kind: 'repeat',
        name: 'Rx',
        axis: 'global_x',
        formula: 'N',
        max: 64,
        boundBlockId: 'abc',
      });
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it("'@repeat' accepts blockId=\"<id>\" before max=", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = N, blockId="abc", max=64'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({
        formula: 'N',
        max: 64,
        boundBlockId: 'abc',
      });
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it("'@repeat' rejects unquoted blockId= as a syntax error", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = N, blockId=abc'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      // The directive still parses (formula preserved); the bad suffix
      // is dropped with a warn diagnostic.
      expect(repeat).toMatchObject({ formula: 'N' });
      expect(repeat && 'boundBlockId' in repeat ? repeat.boundBlockId : undefined).toBeUndefined();
      expect(
        result.diagnostics.some(
          (d) => d.code === 'gpu.dsl_syntax_error' && d.message.includes('malformed blockId'),
        ),
      ).toBe(true);
    });

    it("'@repeat' rejects empty blockId=\"\" as a syntax error", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = N, blockId=""'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({ formula: 'N' });
      expect(
        result.diagnostics.some(
          (d) => d.code === 'gpu.dsl_syntax_error' && d.message.includes('empty blockId'),
        ),
      ).toBe(true);
    });

    it("'@map' accepts trailing blockId=\"<id>\" suffix", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@map idx <- R0, blockId="def"'),
        REGION,
      );
      const map = result.directives.find((d) => d.kind === 'map');
      expect(map).toMatchObject({
        kind: 'map',
        var: 'idx',
        formula: 'R0',
        boundBlockId: 'def',
      });
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it("'@repeat' formula containing '[...]' is not confused with blockId= suffix", () => {
      // The bracket syntax in @Phase E+ sugar (`len(my_list)` etc.) has
      // its own commas inside `[...]` if we ever extend it. Here we
      // simulate a formula with an in-formula comma token that the
      // quote-aware split must skip past.
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = len(my_list), blockId="x"'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({ formula: 'len(my_list)', boundBlockId: 'x' });
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it("'@repeat' quoted string containing ',' is not confused with blockId= suffix", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = "a,b", blockId="x"'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({ formula: '"a,b"', boundBlockId: 'x' });
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it("legacy '@repeat Rx:global_x = N, max=64' keeps boundBlockId undefined", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = N, max=64'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({ formula: 'N', max: 64 });
      expect(
        repeat && 'boundBlockId' in repeat ? repeat.boundBlockId : undefined,
      ).toBeUndefined();
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });
  });
});
