import { describe, expect, it } from 'vitest';
import {
  formatScratchComment,
  formatScgpuDocument,
  listBindings,
  listMaps,
  listRepeats,
  listWorkgroupSizes,
  parseScgpuDocument,
} from '../src';

describe('formatScratchComment', () => {
  it('prefixes every line with `// `', () => {
    const out = formatScratchComment('@compute\n@bind tmp0(0) ro');
    expect(out).toBe('// @compute\n// @bind tmp0(0) ro');
  });

  it('preserves blank lines', () => {
    const out = formatScratchComment('@compute\n\n@bind tmp0(0) ro');
    expect(out).toBe('// @compute\n//\n// @bind tmp0(0) ro');
  });

  it('normalises line endings to LF', () => {
    const out = formatScratchComment('@compute\r\n@bind tmp0(0) ro\r\n');
    expect(out).not.toMatch(/\r/);
    expect(out).toBe('// @compute\n// @bind tmp0(0) ro');
  });

  it('emits CRLF when configured', () => {
    const out = formatScratchComment('@compute\n@bind tmp0(0) ro', { lineEnding: '\r\n' });
    expect(out).toBe('// @compute\r\n// @bind tmp0(0) ro');
  });

  it('allows an empty prefix', () => {
    const out = formatScratchComment('@compute\n@bind tmp0(0) ro\n', { prefix: '' });
    expect(out).toBe('@compute\n@bind tmp0(0) ro');
  });
});

describe('formatScgpuDocument', () => {
  it('orders directives inside a region (§15.3 — @max removed)', () => {
    const text = [
      '@compute',
      '@map R0 <- 0',
      '@repeat R0:global_x = R0 + 1',
      '@workgroup_size(64)',
      '@bind tmp0(0) ro',
    ].join('\n');
    const out = formatScgpuDocument(text);
    expect(out).toBe(
      [
        '@compute',
        '@bind tmp0(0) ro',
        '@workgroup_size(64)',
        '@repeat R0:global_x = R0 + 1',
        '@map R0 <- 0',
        '',
      ].join('\n'),
    );
  });

  it('is idempotent', () => {
    const text = [
      '@compute',
      '@bind tmp0(0) ro',
      '@workgroup_size(64)',
      '@repeat R0:global_x = R0 + 1',
      '@map R0 <- 0',
    ].join('\n');
    const once = formatScgpuDocument(text);
    const twice = formatScgpuDocument(once);
    expect(twice).toBe(once);
  });

  it('preserves frontmatter', () => {
    const text = [
      '---',
      'title: my kernel',
      '---',
      '@compute',
      '@bind tmp0(0) ro',
    ].join('\n');
    const out = formatScgpuDocument(text);
    expect(out.startsWith('---\ntitle: my kernel\n---\n')).toBe(true);
    expect(out).toContain('@compute');
    expect(out).toContain('@bind tmp0(0) ro');
  });

  it('aligns @bind columns when requested', () => {
    const text = [
      '@compute',
      '@bind buff_r(1) rw f32',
      '@bind tmp0(0) ro',
    ].join('\n');
    const out = formatScgpuDocument(text, { alignedBinds: true });
    const binds = out.split('\n').filter((l) => l.startsWith('@bind'));
    const positions = binds.map((line) => line.indexOf('ro') >= 0 ? line.indexOf('ro') : line.indexOf('rw'));
    expect(new Set(positions).size).toBe(1);
  });

  it('aligns quoted and unquoted @bind columns when requested', () => {
    const text = [
      '@compute',
      '@bind "my list"(1) rw f32',
      '@bind tmp0(0) ro',
    ].join('\n');
    const out = formatScgpuDocument(text, { alignedBinds: true });
    const binds = out.split('\n').filter((line) => line.startsWith('@bind'));
    const positions = binds.map((line) =>
      line.indexOf('ro') >= 0 ? line.indexOf('ro') : line.indexOf('rw'),
    );
    expect(new Set(positions).size).toBe(1);
    expect(out).toContain('@bind "my list"(1) rw f32');
  });

  it('sorts @bind directives by slot', () => {
    const text = [
      '@compute',
      '@bind buff_r(2) rw f32',
      '@bind tmp0(0) ro',
      '@bind scratch_list(1) rw f32',
    ].join('\n');
    const out = formatScgpuDocument(text);
    const binds = out.split('\n').filter((l) => l.startsWith('@bind'));
    expect(binds[0]).toContain('tmp0(0)');
    expect(binds[1]).toContain('scratch_list(1)');
    expect(binds[2]).toContain('buff_r(2)');
  });
});

describe('helpers', () => {
  it('filters by directive kind (§15.3 — @max removed)', () => {
    const text = [
      '@compute',
      '@bind tmp0(0) ro',
      '@workgroup_size(64)',
      '@repeat R0 = x',
      '@map R0 <- 0',
    ].join('\n');
    const directives = parseScgpuDocument(text).regions[0]!.directives.map((d) => d.directive);
    expect(listBindings(directives)).toHaveLength(1);
    expect(listWorkgroupSizes(directives)).toHaveLength(1);
    expect(listRepeats(directives)).toHaveLength(1);
    expect(listMaps(directives)).toHaveLength(1);
  });
});
