import { describe, expect, it } from 'vitest';
import {
  readExtensionURLsFromArrayBuffer,
  stripProjectExtensions,
} from '@/runtime/extension-urls';
import JSZip from 'jszip';

/**
 * Build a minimal sb3 archive in memory. The `project.json` is the only
 * file we ever look at; everything else is irrelevant for these tests.
 */
async function buildSb3(projectJson: unknown): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(projectJson));
  // Add a placeholder asset so JSZip doesn't optimize the archive into
  // a "stored-only" zip with a single entry (some code paths assert on
  // multi-entry archives, but our reader does not).
  zip.file('assets/placeholder.txt', 'noop');
  return await zip.generateAsync({ type: 'arraybuffer' });
}

describe('readExtensionURLsFromArrayBuffer', () => {
  it('returns an empty array when project.json has no extensionURLs', async () => {
    const buf = await buildSb3({ meta: { semver: '3.0.0' } });
    const result = await readExtensionURLsFromArrayBuffer(buf);
    expect(result).toEqual([]);
  });

  it('returns one entry per (id, url) pair in extensionURLs', async () => {
    const buf = await buildSb3({
      extensionURLs: {
        lmsTempVars2: 'https://extensions.turbowarp.org/lmsTempVars2.js',
        'my-ext': 'https://example.com/my-ext.js',
      },
    });
    const result = await readExtensionURLsFromArrayBuffer(buf);
    expect(result).toEqual([
      { id: 'lmsTempVars2', url: 'https://extensions.turbowarp.org/lmsTempVars2.js' },
      { id: 'my-ext', url: 'https://example.com/my-ext.js' },
    ]);
  });

  it('drops entries with non-string id or url', async () => {
    const buf = await buildSb3({
      extensionURLs: {
        good: 'https://example.com/good.js',
        badId: 42,
        badUrl: 'not-a-url',
        emptyUrl: '',
      },
    });
    const result = await readExtensionURLsFromArrayBuffer(buf);
    expect(result).toEqual([{ id: 'good', url: 'https://example.com/good.js' }]);
  });

  it('de-duplicates by URL when the same URL appears under multiple ids', async () => {
    const buf = await buildSb3({
      extensionURLs: {
        a: 'https://example.com/dup.js',
        b: 'https://example.com/dup.js',
      },
    });
    const result = await readExtensionURLsFromArrayBuffer(buf);
    expect(result).toEqual([{ id: 'a', url: 'https://example.com/dup.js' }]);
  });

  it('returns an empty array when archive is not a zip', async () => {
    const garbage = new TextEncoder().encode('not a zip').buffer as ArrayBuffer;
    const result = await readExtensionURLsFromArrayBuffer(garbage);
    expect(result).toEqual([]);
  });

  it('returns an empty array when project.json is malformed', async () => {
    const zip = new JSZip();
    zip.file('project.json', 'not json at all');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await readExtensionURLsFromArrayBuffer(buf);
    expect(result).toEqual([]);
  });

  it('returns an empty array when extensionURLs is not an object', async () => {
    const buf = await buildSb3({ extensionURLs: 'oops' });
    const result = await readExtensionURLsFromArrayBuffer(buf);
    expect(result).toEqual([]);
  });

  it('returns an empty array when project.json is missing', async () => {
    const zip = new JSZip();
    zip.file('assets/placeholder.txt', 'noop');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await readExtensionURLsFromArrayBuffer(buf);
    expect(result).toEqual([]);
  });
});

/**
 * Build a minimal sb3 with a project.json whose shape is closer to a
 * real Scratch project (extensions array present alongside extensionURLs).
 */
async function buildProjectJson(projectJson: unknown): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(projectJson));
  return await zip.generateAsync({ type: 'arraybuffer' });
}

async function readProjectJson(buf: ArrayBuffer): Promise<unknown> {
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('project.json');
  if (!entry) throw new Error('project.json missing from output archive');
  return JSON.parse(await entry.async('string'));
}

describe('stripProjectExtensions', () => {
  it('removes both extensions and extensionURLs from project.json', async () => {
    const buf = await buildProjectJson({
      targets: [],
      monitors: [],
      meta: { semver: '3.0.0' },
      extensions: ['myExt', 'another'],
      extensionURLs: {
        myExt: 'https://example.com/myExt.js',
        another: 'https://example.com/another.js',
      },
    });
    const stripped = await stripProjectExtensions(buf);
    expect(stripped).not.toBeNull();
    const projectJson = (await readProjectJson(stripped as ArrayBuffer)) as Record<
      string,
      unknown
    >;
    expect('extensions' in projectJson).toBe(false);
    expect('extensionURLs' in projectJson).toBe(false);
    // Other fields preserved.
    expect(projectJson.targets).toEqual([]);
    expect(projectJson.monitors).toEqual([]);
  });

  it('preserves the rest of the project even when only one field is present', async () => {
    const buf = await buildProjectJson({
      targets: [{ name: 'Sprite1', isStage: false }],
      extensionURLs: { myExt: 'https://example.com/myExt.js' },
    });
    const stripped = await stripProjectExtensions(buf);
    expect(stripped).not.toBeNull();
    const projectJson = (await readProjectJson(stripped as ArrayBuffer)) as Record<
      string,
      unknown
    >;
    expect('extensions' in projectJson).toBe(false);
    expect('extensionURLs' in projectJson).toBe(false);
    expect(projectJson.targets).toEqual([{ name: 'Sprite1', isStage: false }]);
  });

  it('is a no-op when neither field is present', async () => {
    const buf = await buildProjectJson({
      targets: [],
      monitors: [],
      meta: { semver: '3.0.0' },
    });
    const stripped = await stripProjectExtensions(buf);
    expect(stripped).not.toBeNull();
    const projectJson = (await readProjectJson(stripped as ArrayBuffer)) as Record<
      string,
      unknown
    >;
    expect(projectJson.targets).toEqual([]);
  });

  it('returns null when project.json is missing', async () => {
    const zip = new JSZip();
    zip.file('assets/placeholder.txt', 'noop');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    expect(await stripProjectExtensions(buf)).toBeNull();
  });

  it('returns null on a malformed zip', async () => {
    const garbage = new TextEncoder().encode('not a zip').buffer as ArrayBuffer;
    expect(await stripProjectExtensions(garbage)).toBeNull();
  });
});
