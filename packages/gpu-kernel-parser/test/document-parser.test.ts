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
});
