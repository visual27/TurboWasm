import { describe, expect, it } from 'vitest';
import {
  buildProjectAdvanced,
  parseTwconfigFromComments,
  readTwconfigFromArrayBuffer,
} from '@/runtime/twconfig';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

describe('twconfig parser', () => {
  it('returns empty when no comments', () => {
    expect(parseTwconfigFromComments(undefined)).toEqual({});
    expect(parseTwconfigFromComments([])).toEqual({});
  });

  it('accepts comments as an object map keyed by id (real SB3 shape)', () => {
    const json = JSON.stringify({
      framerate: 60,
      runtimeOptions: { miscLimits: false },
      hq: true,
      width: 480,
      height: 270,
    });
    const comments = {
      blockA: { text: `${json} // _twconfig_` },
      blockB: { text: 'unrelated comment' },
    };
    expect(parseTwconfigFromComments(comments)).toEqual({
      fps: 60,
      removeMiscLimits: true,
      highQualityPen: true,
      stageWidth: 480,
      stageHeight: 270,
    });
  });

  it('accepts comments as a plain array (legacy / hand-written shape)', () => {
    const json = JSON.stringify({ fps: 24 });
    expect(
      parseTwconfigFromComments([{ text: `// _twconfig_\n${json}` }]),
    ).toEqual({ fps: 24 });
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
      extensionSandboxMode: 'unsandboxed',
    });
    const comments = [{ text: `header\n// _twconfig_\n${json}\nfooter` }];
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
      extensionSandboxMode: 'unsandboxed',
    });
  });

  it('parses the extension security fields in isolation', () => {
    // `allowProjectExtensions` is no longer supported — extension loading
    // is now per-URL via the Extension Permission dialog. Projects that
    // still set it should be silently ignored.
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"allowProjectExtensions": true}' }]),
    ).toEqual({});

    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"extensionSandboxMode": "iframe"}' }]),
    ).toEqual({ extensionSandboxMode: 'iframe' });
  });

  it('rejects unknown sandbox modes', () => {
    expect(
      parseTwconfigFromComments([
        { text: '// _twconfig_\n{"extensionSandboxMode": "totally-isolated"}' },
      ]),
    ).toEqual({});
  });

  it('silently drops the legacy allowProjectExtensions field', () => {
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"allowProjectExtensions": "yes"}' }]),
    ).toEqual({});
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

  it('reads from sb3 zip (project.json embedded, comments on stage target)', async () => {
    // Real SB3 / TurboWasp projects carry the `// _twconfig_` blob on
    // the **stage target's** `comments` map — not at the project
    // root. Pin that contract here so a future refactor doesn't
    // regress to reading from the wrong field.
    const JSZip = (await import('jszip')).default;
    const json = JSON.stringify({ fps: 24 });
    const projectJson = JSON.stringify({
      targets: [
        {
          isStage: true,
          name: 'Stage',
          comments: {
            blockA: { text: `// _twconfig_\n${json}` },
          },
        },
      ],
    });
    const zip = new JSZip();
    zip.file('project.json', projectJson);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await readTwconfigFromArrayBuffer(buf);
    expect(result).toEqual({ fps: 24 });
  });

  it('reads TurboWasp wire-format payload saved at the END of the comment text', async () => {
    // The canonical TurboWasp editor payload places the `// _twconfig_`
    // marker **after** the JSON object, with a multi-line prefix header
    // (Configuration for https://turbowarp.org/...). The parser must
    // find the JSON anywhere in the text and apply polarity-inverted
    // keys correctly.
    const JSZip = (await import('jszip')).default;
    const projectJson = JSON.stringify({
      targets: [
        {
          isStage: true,
          name: 'Stage',
          comments: {
            blockA: {
              text:
                "Configuration for https://turbowarp.org/\nYou can move, resize, and minimize this comment, but don't edit it by hand. This comment can be deleted to remove the stored settings.\n" +
                '{"framerate":60,"runtimeOptions":{"miscLimits":false},"hq":true,"width":480,"height":270} // _twconfig_',
            },
          },
        },
      ],
    });
    const zip = new JSZip();
    zip.file('project.json', projectJson);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await readTwconfigFromArrayBuffer(buf);
    expect(result).toEqual({
      fps: 60,
      removeMiscLimits: true,
      highQualityPen: true,
      stageWidth: 480,
      stageHeight: 270,
    });
  });

  it('returns empty for non-zip input', async () => {
    const buf = new TextEncoder().encode('not a zip').buffer;
    expect(await readTwconfigFromArrayBuffer(buf)).toEqual({});
  });

  it('returns empty when project.json has no twconfig marker', async () => {
    const JSZip = (await import('jszip')).default;
    const projectJson = JSON.stringify({
      targets: [
        {
          isStage: true,
          name: 'Stage',
          comments: { blockA: { text: 'no marker' } },
        },
      ],
    });
    const zip = new JSZip();
    zip.file('project.json', projectJson);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    expect(await readTwconfigFromArrayBuffer(buf)).toEqual({});
  });
});

describe('twconfig parser — TurboWarp wire format', () => {
  it('parses the canonical TurboWarp twconfig example (real format)', () => {
    // The exact payload the TurboWasp web editor emits on
    // "Configuration for https://turbowarp.org/": the marker is on
    // the same line, AFTER the JSON object.
    const json = JSON.stringify({
      framerate: 60,
      runtimeOptions: { miscLimits: false },
      hq: true,
      width: 480,
      height: 270,
    });
    const comments = [{ text: `${json} // _twconfig_` }];
    expect(parseTwconfigFromComments(comments)).toEqual({
      fps: 60,
      removeMiscLimits: true,
      highQualityPen: true,
      stageWidth: 480,
      stageHeight: 270,
    });
  });

  it('inverts fencing → removeFencing (fence ON = confine)', () => {
    // fencing: true in TurboWarp means sprites are confined to the
    // stage, which is the DEFAULT in our viewer. So we flip the
    // polarity to `removeFencing: false`.
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"fencing": true}' }]),
    ).toEqual({ removeFencing: false });
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"fencing": false}' }]),
    ).toEqual({ removeFencing: true });
  });

  it('inverts runtimeOptions.fencing → removeFencing', () => {
    expect(
      parseTwconfigFromComments([
        { text: '// _twconfig_\n{"runtimeOptions": {"fencing": true}}' },
      ]),
    ).toEqual({ removeFencing: false });
  });

  it('inverts miscLimits → removeMiscLimits', () => {
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"miscLimits": false}' }]),
    ).toEqual({ removeMiscLimits: true });
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"miscLimits": true}' }]),
    ).toEqual({ removeMiscLimits: false });
  });

  it('coerces clones to infiniteClones via 1e9 sentinel', () => {
    // 1e9 is the canonical user-friendly round-trip value. Raw
    // `Infinity` is not valid JSON, so it is not handled here.
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"clones": 1e9}' }]),
    ).toEqual({ infiniteClones: true });
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"clones": 300}' }]),
    ).toEqual({ infiniteClones: false });
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"clones": 1e9}' }]),
    ).toEqual({ infiniteClones: true });
    expect(
      parseTwconfigFromComments([{ text: '// _twconfig_\n{"clones": 999999999}' }]),
    ).toEqual({ infiniteClones: false });
  });

  it('coerces runtimeOptions.maxClones to infiniteClones', () => {
    expect(
      parseTwconfigFromComments([
        { text: '// _twconfig_\n{"runtimeOptions": {"maxClones": 1e9}}' },
      ]),
    ).toEqual({ infiniteClones: true });
    expect(
      parseTwconfigFromComments([
        { text: '// _twconfig_\n{"runtimeOptions": {"maxClones": 500}}' },
      ]),
    ).toEqual({ infiniteClones: false });
  });

  it('parses direct-mapping keys (interpolation, turboMode, warpTimer)', () => {
    const json = JSON.stringify({
      interpolation: true,
      turboMode: true,
      warpTimer: true,
      disableCompilation: true,
    });
    const comments = [{ text: `// _twconfig_\n${json}` }];
    expect(parseTwconfigFromComments(comments)).toEqual({
      interpolation: true,
      turboMode: true,
      warpTimer: true,
      disableCompiler: true,
    });
  });

  it('flat key wins over runtimeOptions for the same internal field', () => {
    // Explicit flat `clones: 500` (not infinite) should override
    // `runtimeOptions.maxClones: 1e9` (infinite).
    const json = JSON.stringify({
      clones: 500,
      runtimeOptions: { maxClones: 1e9 },
    });
    const comments = [{ text: `// _twconfig_\n${json}` }];
    expect(parseTwconfigFromComments(comments)).toEqual({ infiniteClones: false });
  });

  it('falls back to runtimeOptions when flat key is absent', () => {
    const json = JSON.stringify({
      runtimeOptions: { maxClones: 1e9, fencing: false },
    });
    const comments = [{ text: `// _twconfig_\n${json}` }];
    expect(parseTwconfigFromComments(comments)).toEqual({
      infiniteClones: true,
      removeFencing: true,
    });
  });

  it('ignores runtimeOptions that is not a plain object', () => {
    // runtimeOptions as a string, number, array, or null must be
    // skipped without throwing. Flat keys still parse normally.
    const variants: ReadonlyArray<unknown> = [
      'broken',
      42,
      ['miscLimits'],
      null,
    ];
    for (const v of variants) {
      const json = JSON.stringify({ runtimeOptions: v, fencing: true });
      const comments = [{ text: `// _twconfig_\n${json}` }];
      expect(parseTwconfigFromComments(comments)).toEqual({ removeFencing: false });
    }
  });

  it('silently drops unknown TurboWarp keys (e.g. infiniteRecursion)', () => {
    const json = JSON.stringify({
      framerate: 60,
      infiniteRecursion: true,
      someFutureOption: 'whatever',
    });
    const comments = [{ text: `// _twconfig_\n${json}` }];
    expect(parseTwconfigFromComments(comments)).toEqual({ fps: 60 });
  });

  it('rejects out-of-range wire-format values', () => {
    // width outside the 1..8192 stage-dim window, and a non-finite
    // numeric for framerate, must both be silently dropped.
    expect(
      parseTwconfigFromComments([
        { text: '// _twconfig_\n{"width": 99999, "height": -1, "framerate": NaN}' },
      ]),
    ).toEqual({});
  });

  it('handles mixed flat + nested in a single payload', () => {
    const json = JSON.stringify({
      framerate: 60,
      hq: true,
      width: 640,
      height: 360,
      runtimeOptions: { miscLimits: false, fencing: true, maxClones: 300 },
    });
    const comments = [{ text: `// _twconfig_\n${json}` }];
    expect(parseTwconfigFromComments(comments)).toEqual({
      fps: 60,
      highQualityPen: true,
      stageWidth: 640,
      stageHeight: 360,
      removeMiscLimits: true,
      removeFencing: false,
      infiniteClones: false,
    });
  });
});

describe('buildProjectAdvanced (defaultAdvanced ∪ overrides merge)', () => {
  it('returns the baseline when overrides is empty', () => {
    const result = buildProjectAdvanced(DEFAULT_ADVANCED_SETTINGS, {});
    expect(result).toEqual({
      ...DEFAULT_ADVANCED_SETTINGS,
      disableCompiler: false,
    });
  });

  it('overrides take priority over the baseline for each specified key', () => {
    const baseline = { ...DEFAULT_ADVANCED_SETTINGS, fps: 30, stageWidth: 480 };
    const result = buildProjectAdvanced(baseline, { fps: 60 });
    expect(result.fps).toBe(60);
    // Other keys fall back to the baseline.
    expect(result.stageWidth).toBe(480);
  });

  it('forces disableCompiler to false regardless of the override', () => {
    const baseline = { ...DEFAULT_ADVANCED_SETTINGS, disableCompiler: false };
    const result = buildProjectAdvanced(baseline, { disableCompiler: true });
    expect(result.disableCompiler).toBe(false);
  });

  it('preserves turboWasmAccelerationEnabled from the baseline', () => {
    const baseline = { ...DEFAULT_ADVANCED_SETTINGS, turboWasmAccelerationEnabled: false };
    const result = buildProjectAdvanced(baseline, { fps: 60 });
    expect(result.turboWasmAccelerationEnabled).toBe(false);
  });

  it('does not leak between successive calls', () => {
    // Simulate the project-load flow: build for project A with
    // overrides, then build for project B without any. The second
    // result must NOT carry the first project's overrides.
    const baseline = { ...DEFAULT_ADVANCED_SETTINGS };
    const a = buildProjectAdvanced(baseline, { fps: 60, stageWidth: 999 });
    expect(a.fps).toBe(60);
    expect(a.stageWidth).toBe(999);
    const b = buildProjectAdvanced(baseline, {});
    expect(b.fps).toBe(DEFAULT_ADVANCED_SETTINGS.fps);
    expect(b.stageWidth).toBe(DEFAULT_ADVANCED_SETTINGS.stageWidth);
  });
});
