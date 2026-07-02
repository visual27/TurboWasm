import { describe, expect, it } from 'vitest';
import { readTwconfigFromArrayBuffer } from '@/runtime/twconfig';

/**
 * Build an in-memory sb3 (zip) that contains a project.json with a
 * // _twconfig_ comment. We use JSZip dynamically to avoid pulling it into
 * the initial bundle just for tests.
 */
async function makeSb3WithComments(comments: string[]): Promise<ArrayBuffer> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file(
    'project.json',
    JSON.stringify({
      targets: [],
      monitors: [],
      extensions: [],
      meta: { semver: '3.0.0', vm: '0.2.0', agent: '' },
      comments: comments.map((text, i) => ({
        blockId: `b${i}`,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        minimized: false,
        text,
      })),
    }),
  );
  return await zip.generateAsync({ type: 'arraybuffer' });
}

describe('readTwconfigFromArrayBuffer (dynamic jszip import)', () => {
  it('parses supported keys from a comment-block marker', async () => {
    const buf = await makeSb3WithComments([
      '// _twconfig_\n{"fps": 60, "turboMode": true, "stageWidth": 640}',
    ]);
    const overrides = await readTwconfigFromArrayBuffer(buf);
    expect(overrides.fps).toBe(60);
    expect(overrides.turboMode).toBe(true);
    expect(overrides.stageWidth).toBe(640);
  });

  it('returns an empty object for an sb3 with no comments', async () => {
    const buf = await makeSb3WithComments([]);
    const overrides = await readTwconfigFromArrayBuffer(buf);
    expect(overrides).toEqual({});
  });

  it('returns an empty object for an empty / non-zip buffer', async () => {
    const buf = new TextEncoder().encode('not a zip').buffer as ArrayBuffer;
    const overrides = await readTwconfigFromArrayBuffer(buf);
    expect(overrides).toEqual({});
  });
});