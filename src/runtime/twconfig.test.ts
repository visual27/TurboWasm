import { describe, expect, it } from 'vitest';
import { parseTwconfigFromComments, readTwconfigFromArrayBuffer } from '@/runtime/twconfig';

describe('twconfig parser', () => {
  it('returns empty when no comments', () => {
    expect(parseTwconfigFromComments(undefined)).toEqual({});
    expect(parseTwconfigFromComments([])).toEqual({});
  });

  it('parses known keys from a comment block', () => {
    const json = JSON.stringify({
      fps: 60,
      interpolation: true,
      highQualityPen: true,
      warpTimer: true,
      infiniteClones: true,
      removeFencing: true,
      removeMiscLimits: true,
      turboMode: true,
      disableCompiler: true,
      stageWidth: 640,
      stageHeight: 480,
    });
    const comments = [
      { text: `header\n// _twconfig_\n${json}\nfooter` },
    ];
    expect(parseTwconfigFromComments(comments)).toEqual({
      fps: 60,
      interpolation: true,
      highQualityPen: true,
      warpTimer: true,
      infiniteClones: true,
      removeFencing: true,
      removeMiscLimits: true,
      turboMode: true,
      disableCompiler: true,
      stageWidth: 640,
      stageHeight: 480,
    });
  });

  it('ignores unknown keys silently', () => {
    const json = JSON.stringify({ fps: 60, futureSetting: 'hello' });
    const comments = [{ text: `// _twconfig_\n${json}` }];
    expect(parseTwconfigFromComments(comments)).toEqual({ fps: 60 });
  });

  it('returns empty on malformed JSON', () => {
    const comments = [{ text: '// _twconfig_\n{not json' }];
    expect(parseTwconfigFromComments(comments)).toEqual({});
  });

  it('returns empty when marker missing', () => {
    const comments = [{ text: 'no marker here\nfps=60' }];
    expect(parseTwconfigFromComments(comments)).toEqual({});
  });

  it('rejects out-of-range fps', () => {
    const json = JSON.stringify({ fps: 9999, stageWidth: -1 });
    const comments = [{ text: `// _twconfig_\n${json}` }];
    expect(parseTwconfigFromComments(comments)).toEqual({});
  });

  it('rejects non-boolean / non-number values', () => {
    const json = JSON.stringify({ interpolation: 'yes', turboMode: 1 });
    const comments = [{ text: `// _twconfig_\n${json}` }];
    expect(parseTwconfigFromComments(comments)).toEqual({});
  });

  it('reads from sb3 zip (project.json embedded)', async () => {
    const JSZip = (await import('jszip')).default;
    const json = JSON.stringify({ fps: 24 });
    const projectJson = JSON.stringify({
      comments: [{ text: `// _twconfig_\n${json}` }],
    });
    const zip = new JSZip();
    zip.file('project.json', projectJson);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await readTwconfigFromArrayBuffer(buf);
    expect(result).toEqual({ fps: 24 });
  });

  it('returns empty for non-zip input', async () => {
    const buf = new TextEncoder().encode('not a zip').buffer;
    expect(await readTwconfigFromArrayBuffer(buf)).toEqual({});
  });

  it('returns empty when project.json has no twconfig marker', async () => {
    const JSZip = (await import('jszip')).default;
    const projectJson = JSON.stringify({ comments: [{ text: 'no marker' }] });
    const zip = new JSZip();
    zip.file('project.json', projectJson);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    expect(await readTwconfigFromArrayBuffer(buf)).toEqual({});
  });
});