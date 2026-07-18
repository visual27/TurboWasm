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
      // The @bind regex rejects `my-list` outright (no identifier
      // pattern matches it), so the diagnostic is the malformed-@bind
      // one from parseBind rather than the per-token diagnostic.
      const result = parseComputeComment(
        mkComment('@compute\n@bind my-list(0) ro'),
        REGION,
      );
      expect(result.directives.find((d) => d.kind === 'bind')).toBeUndefined();
      expect(
        result.diagnostics.some((d) => d.message.startsWith('malformed @bind')),
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
});
