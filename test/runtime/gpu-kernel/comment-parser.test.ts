import { describe, expect, it } from 'vitest';
import { parseComputeComment } from '@/runtime/gpu-kernel/comment-parser';
import type { ParsedComment } from '@/runtime/gpu-kernel/types';

const REGION = 'region:sprite1:repeat0';

function mkComment(text: string, blockId = 'blk'): ParsedComment {
  return { blockId, text };
}

describe('comment-parser', () => {
  it('parses @bind, @workgroup_size, @repeat, @map in a single comment (§15.3 — @max removed)', () => {
    const text = [
      '@compute',
      '@bind scratch_list(0) rw f32',
      '@bind tmp0(1) ro',
      '@workgroup_size(64)',
      '@repeat R0:global_x = aabb_width',
      '@map idx0 <- R0',
    ].join('\n');

    const result = parseComputeComment(mkComment(text), REGION);
    expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    // `@compute` is a marker, not a directive — the parser silently skips it.
    expect(result.directives).toHaveLength(5);
    const binds = result.directives.filter((d) => d.kind === 'bind');
    expect(binds).toHaveLength(2);
    const firstBind = binds[0];
    expect(firstBind).toMatchObject({ kind: 'bind', name: 'scratch_list', slot: 0, readOnly: false, dtype: 'f32' });
    const secondBind = binds[1];
    expect(secondBind).toMatchObject({ kind: 'bind', name: 'tmp0', slot: 1, readOnly: true, dtype: 'f32' });
    const repeat = result.directives.find((d) => d.kind === 'repeat');
    expect(repeat).toMatchObject({ kind: 'repeat', name: 'R0', axis: 'global_x' });
    // §Phase 2 (15.3): the `max` field is gone from RepeatDirective.
    expect(repeat && 'max' in repeat ? (repeat as { max?: number }).max : undefined).toBeUndefined();
    const map = result.directives.find((d) => d.kind === 'map');
    expect(map).toMatchObject({ kind: 'map', var: 'idx0' });
  });

  it('rejects @max length=N as a hard error (§Phase 2 §15.3)', () => {
    const result = parseComputeComment(
      mkComment('@compute\n@max length=1024\n'),
      REGION,
    );
    // §Phase 2 (15.3): @max is removed in v9 — no MaxDirective in the
    // union, so we can only assert via the diagnostic surface.
    expect(result.directives).toHaveLength(0);
    const diag = result.diagnostics.find(
      (d) => d.code === 'gpu.dsl_syntax_error' && d.message.includes('@max'),
    );
    expect(diag).toBeDefined();
    // §Phase 2 (15.2): parser rejection uses severity 'error' so the
    // owning region D1-demotes via buildBlockSubsetVerdict.
    expect(diag?.severity).toBe('error');
  });

  it('rejects @max "my group"=64 (quoted group form) as a hard error (§15.3)', () => {
    const result = parseComputeComment(
      mkComment('@compute\n@max "my group"=64\n'),
      REGION,
    );
    expect(result.directives).toHaveLength(0);
    const diag = result.diagnostics.find(
      (d) => d.code === 'gpu.dsl_syntax_error' && d.severity === 'error',
    );
    expect(diag).toBeDefined();
  });

  it('rejects inline ", max=<uint>" on @repeat as a hard error (§15.3)', () => {
    const result = parseComputeComment(
      mkComment('@compute\n@repeat R0:global_x = aabb_width, max=4096\n'),
      REGION,
    );
    // The directive is rejected entirely (no RepeatDirective emitted).
    expect(result.directives.find((d) => d.kind === 'repeat')).toBeUndefined();
    const diag = result.diagnostics.find(
      (d) => d.code === 'gpu.dsl_syntax_error' && d.severity === 'error',
    );
    expect(diag).toBeDefined();
    expect(diag?.message).toContain('max');
  });

  it('still rejects inline ", max=<uint>" when combined with blockId= (§15.3)', () => {
    const result = parseComputeComment(
      mkComment('@compute\n@repeat R0:global_x = aabb_width, max=4096, blockId="x"\n'),
      REGION,
    );
    expect(result.directives.find((d) => d.kind === 'repeat')).toBeUndefined();
    const errorDiag = result.diagnostics.find(
      (d) => d.severity === 'error' && d.code === 'gpu.dsl_syntax_error',
    );
    expect(errorDiag).toBeDefined();
  });

  it('does NOT reject a formula that contains "max + 1" mid-expression (§15.3)', () => {
    // `max + 1` is a valid formula — only the trailing `, max=<digits>$`
    // is rejected. Anchor on `\s*$` keeps this case green.
    const result = parseComputeComment(
      mkComment('@compute\n@bind tmp0(0) ro\n@repeat R0 = max + 1\n'),
      REGION,
    );
    expect(result.directives.find((d) => d.kind === 'repeat')).toMatchObject({
      kind: 'repeat',
      name: 'R0',
      formula: 'max + 1',
    });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('legacy @repeat with no max= suffix continues to work (§15.3 backward compat)', () => {
    const result = parseComputeComment(
      mkComment('@compute\n@repeat R0:global_x = aabb_width\n'),
      REGION,
    );
    const repeat = result.directives.find((d) => d.kind === 'repeat');
    expect(repeat).toMatchObject({ kind: 'repeat', name: 'R0', axis: 'global_x', formula: 'aabb_width' });
    expect(repeat && 'max' in repeat ? (repeat as { max?: number }).max : undefined).toBeUndefined();
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

  describe('quoted names in @repeat (§Phase E+)', () => {
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

    it('parses @repeat R0:global_x = "my list" with quoted formula reference (§15.3 — @max gone)', () => {
      // §Phase 2 (15.3): the previous @max-renamed reference test was
      // retired. The quoted formula reference still resolves through
      // the @bind rename table; we verify the parser accepts the
      // surface form and preserves the literal in `formula`.
      const result = parseComputeComment(
        mkComment('@compute\n@bind "my list"(0) ro\n@repeat R0 = "my list"'),
        REGION,
      );
      const repeat = result.directives.find((d) => d.kind === 'repeat');
      expect(repeat).toMatchObject({ kind: 'repeat', name: 'R0', axis: 'sequential', formula: '"my list"' });
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

    // §Phase 2 (15.3): the `, max=<uint>` suffix was removed alongside
    // the `@max` directive. The two pre-v9 tests that combined max=
    // with blockId= are replaced below with rejection coverage.

    it("'@repeat' rejects ', max=<uint>' even when blockId= appears (§15.3)", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = N, max=64, blockId="abc"'),
        REGION,
      );
      // The directive is rejected entirely — no RepeatDirective emitted.
      expect(result.directives.find((d) => d.kind === 'repeat')).toBeUndefined();
      const errorDiag = result.diagnostics.find(
        (d) => d.severity === 'error' && d.code === 'gpu.dsl_syntax_error',
      );
      expect(errorDiag).toBeDefined();
    });

    it("'@repeat' rejects ', max=<uint>' after blockId= (§15.3)", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@repeat Rx:global_x = N, blockId="abc", max=64'),
        REGION,
      );
      expect(result.directives.find((d) => d.kind === 'repeat')).toBeUndefined();
      const errorDiag = result.diagnostics.find(
        (d) => d.severity === 'error' && d.code === 'gpu.dsl_syntax_error',
      );
      expect(errorDiag).toBeDefined();
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
  });

  describe('storageKind suffix (§Phase 3, scalar uniform binding)', () => {
    it("parses @bind x(0) ro i32, scalar as storageKind='scalar'", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind aabb_idx0(4) ro i32, scalar'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({
        kind: 'bind',
        name: 'aabb_idx0',
        slot: 4,
        readOnly: true,
        dtype: 'i32',
        storageKind: 'scalar',
      });
      expect(result.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    });

    it("parses @bind x(0) ro f32, scalar as storageKind='scalar'", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind screen_w(8) ro f32, scalar'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({
        kind: 'bind',
        name: 'screen_w',
        slot: 8,
        dtype: 'f32',
        storageKind: 'scalar',
      });
    });

    it("parses explicit ', list' suffix as storageKind='list'", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind buff_r(1) rw f32, list'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({
        kind: 'bind',
        name: 'buff_r',
        slot: 1,
        readOnly: false,
        dtype: 'f32',
        storageKind: 'list',
      });
    });

    it("omitted suffix defaults to storageKind='list' (legacy behavior)", () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind buff_r(1) rw f32'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({
        kind: 'bind',
        name: 'buff_r',
        slot: 1,
        dtype: 'f32',
        storageKind: 'list',
      });
    });

    it('storageKind suffix is case-insensitive on the keyword', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind x(0) ro f32, SCALAR'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({ storageKind: 'scalar' });
    });

    it('rejects an unknown storageKind keyword as malformed', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind x(0) ro f32, bogus'),
        REGION,
      );
      expect(result.directives.find((d) => d.kind === 'bind')).toBeUndefined();
      expect(result.diagnostics.some((d) => d.message.includes('@bind'))).toBe(true);
    });

    it('quoted name + scalar suffix produces internalName + storageKind', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind "my var"(0) ro f32, scalar'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({
        kind: 'bind',
        name: 'my var',
        storageKind: 'scalar',
      });
      expect((bind as { internalName?: string }).internalName).toMatch(/^__tw_[0-9a-f]{8}$/);
    });

    it('combines storageKind suffix with no dtype (defaults to f32)', () => {
      const result = parseComputeComment(
        mkComment('@compute\n@bind tmp0(0) ro, scalar'),
        REGION,
      );
      const bind = result.directives.find((d) => d.kind === 'bind');
      expect(bind).toMatchObject({
        kind: 'bind',
        name: 'tmp0',
        slot: 0,
        readOnly: true,
        dtype: 'f32',
        storageKind: 'scalar',
      });
    });

    it('multiple scalar binds in one comment produce individual storageKinds', () => {
      const text = [
        '@compute',
        '@bind aabb_idx0(4) ro i32, scalar',
        '@bind screen_w(8) ro f32, scalar',
        '@bind aabb_tmp0(10) ro f32, scalar',
        '@bind buff_r(1) rw f32',
      ].join('\n');
      const result = parseComputeComment(mkComment(text), REGION);
      const binds = result.directives.filter((d) => d.kind === 'bind');
      expect(binds).toHaveLength(4);
      expect(binds[0]).toMatchObject({ name: 'aabb_idx0', storageKind: 'scalar' });
      expect(binds[1]).toMatchObject({ name: 'screen_w', storageKind: 'scalar' });
      expect(binds[2]).toMatchObject({ name: 'aabb_tmp0', storageKind: 'scalar' });
      expect(binds[3]).toMatchObject({ name: 'buff_r', storageKind: 'list' });
    });
  });
});
