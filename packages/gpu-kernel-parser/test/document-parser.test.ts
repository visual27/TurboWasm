import { describe, expect, it } from 'vitest';
import { parseScgpuDocument } from '../src/document-parser';

describe('parseScgpuDocument', () => {
  it('parses a single region', () => {
    const text = [
      '@compute',
      '@bind tmp0(0) ro',
      '@workgroup_size(64)',
      '@repeat R0:global_x = R0 + 1',
      '@map R0 <- 0',
    ].join('\n');
    const result = parseScgpuDocument(text);
    expect(result.frontmatter.range).toBeNull();
    expect(result.regions).toHaveLength(1);
    const region = result.regions[0];
    expect(region?.regionId).toBe('region:document');
    expect(region?.directives.map((d) => d.directive.kind)).toEqual([
      'bind',
      'workgroup_size',
      'repeat',
      'map',
    ]);
  });

  it('parses quoted @bind and @map names', () => {
    const text = [
      '@compute',
      '@bind "my list"(0) rw f32',
      '@map "output index" <- R0',
    ].join('\n');
    const result = parseScgpuDocument(text);
    const directives = result.regions[0]?.directives.map((entry) => entry.directive) ?? [];
    expect(directives.find((directive) => directive.kind === 'bind')).toMatchObject({
      name: 'my list',
      internalName: expect.stringMatching(/^__tw_[0-9a-f]{8}$/),
    });
    expect(directives.find((directive) => directive.kind === 'map')).toMatchObject({
      var: 'output index',
      internalName: expect.stringMatching(/^__tw_[0-9a-f]{8}$/),
    });
  });

  it('strips UTF-8 BOM', () => {
    const text = '\uFEFF@compute\n@bind tmp0(0) ro\n';
    const result = parseScgpuDocument(text);
    expect(result.regions).toHaveLength(1);
  });

  it('skips YAML frontmatter at the top', () => {
    const text = [
      '---',
      'title: my kernel',
      'version: 1',
      '---',
      '@compute',
      '@bind tmp0(0) ro',
    ].join('\n');
    const result = parseScgpuDocument(text);
    expect(result.frontmatter.range).not.toBeNull();
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.directives[0]?.directive.kind).toBe('bind');
  });

  it('parses multiple @compute regions', () => {
    const text = [
      '@compute',
      '@bind tmp0(0) ro',
      '',
      '@compute',
      '@bind buff(1) rw f32',
    ].join('\n');
    const result = parseScgpuDocument(text);
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0]?.directives.map((d) => d.directive.kind)).toEqual(['bind']);
    expect(result.regions[1]?.directives.map((d) => d.directive.kind)).toEqual(['bind']);
  });

  it('skips line comments', () => {
    const text = [
      '// a comment',
      '@compute',
      '// another comment',
      '@bind tmp0(0) ro',
      '',
    ].join('\n');
    const result = parseScgpuDocument(text);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.directives).toHaveLength(1);
  });

  it('tolerates CRLF line endings', () => {
    const text = '@compute\r\n@bind tmp0(0) ro\r\n';
    const result = parseScgpuDocument(text);
    expect(result.regions[0]?.directives).toHaveLength(1);
  });

  it('surfaces an empty-region diagnostic', () => {
    const text = '@compute\n\n';
    const result = parseScgpuDocument(text);
    expect(result.regions[0]?.diagnostics).toHaveLength(1);
    expect(result.regions[0]?.diagnostics[0]?.message).toMatch(/empty/);
  });

  it('records ranges for directives', () => {
    const text = ['@compute', '@bind tmp0(0) ro', '@repeat R0 = a'].join('\n');
    const result = parseScgpuDocument(text);
    const [region] = result.regions;
    expect(region?.directives[0]?.range.start.line).toBe(1);
    expect(region?.directives[0]?.range.end.line).toBe(1);
    expect(region?.directives[1]?.range.start.line).toBe(2);
  });

  describe('§Phase 2 (15.13) — frontmatter offset correction', () => {
    it('adds the frontmatter line count to directive ranges', () => {
      // Document: 3 lines of frontmatter + @compute on line 3 + 2 directives
      // on lines 4 / 5. Original-document lines are 0-based.
      const text = [
        '---',
        'title: my kernel',
        'version: 1',
        '---',
        '@compute',
        '@bind tmp0(0) ro',
        '@repeat R0 = a',
      ].join('\n');
      const result = parseScgpuDocument(text);
      const [region] = result.regions;
      expect(region).toBeDefined();
      // @compute marker is on original line 4 (0-based).
      expect(region?.markerLine).toBe(4);
      // Directives follow on lines 5 / 6.
      expect(region?.directives[0]?.range.start.line).toBe(5);
      expect(region?.directives[1]?.range.start.line).toBe(6);
    });

    it('records frontmatter range spanning exactly the consumed lines', () => {
      // 1 line of frontmatter (closing `---` immediately).
      const text = ['---', '---', '@compute', '@bind tmp0(0) ro'].join('\n');
      const result = parseScgpuDocument(text);
      expect(result.frontmatter.range?.start.line).toBe(0);
      // §Phase 2 (15.13): end.line = the count of newlines (= number
      // of completed lines) consumed by the frontmatter, exclusive of
      // the body's start line.
      expect(result.frontmatter.range?.end.line).toBe(2);
      const [region] = result.regions;
      // @compute on original line 2 (0-based).
      expect(region?.markerLine).toBe(2);
      // Directive on line 3.
      expect(region?.directives[0]?.range.start.line).toBe(3);
    });

    it('uses 10-line frontmatter correctly', () => {
      const fm = Array.from({ length: 10 }, (_, k) => `key${k}: ${k}`).join('\n');
      const text = [`---`, fm, `---`, `@compute`, `@bind tmp0(0) ro`].join('\n');
      const result = parseScgpuDocument(text);
      const [region] = result.regions;
      // @compute on original line 12 (1 closing --- line + 10 fm lines).
      expect(region?.markerLine).toBe(12);
      expect(region?.directives[0]?.range.start.line).toBe(13);
    });

    it('bare directive in implicit region lands on the directive absolute line (§15.13)', () => {
      // Pre-15.13 the directive was shifted by one line (markerLine = i,
      // bodyStartLine = i + 1). Post-15.13 the bare directive's
      // Range.start.line equals its absolute document line.
      const text = [
        '---',
        'title: x',
        '---',
        '@bind tmp0(0) ro', // bare directive → implicit region
      ].join('\n');
      const result = parseScgpuDocument(text);
      const [region] = result.regions;
      expect(region).toBeDefined();
      // Bare directive is on original line 3 (0-based).
      expect(region?.directives[0]?.range.start.line).toBe(3);
    });

    it('surfaces diagnostic line numbers as absolute coordinates', () => {
      // Malformed @bind below a 2-line frontmatter should report line 4
      // (0-based), not line 2.
      const text = [
        '---',
        'title: x',
        '---',
        '@compute',
        '@bind missing-paren ro', // malformed
      ].join('\n');
      const result = parseScgpuDocument(text);
      const [region] = result.regions;
      const diag = region?.diagnostics.find((d) => d.code === 'gpu.dsl_syntax_error');
      expect(diag?.line).toBe(4);
    });
  });
});
