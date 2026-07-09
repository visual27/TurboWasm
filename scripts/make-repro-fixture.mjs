#!/usr/bin/env node
/**
 * Generate the `repro.sb3` smoke-test fixture.
 *
 * The fixture is a minimal SB3 used by `scripts/chrome-devtools-mcp-verify.mjs`
 * (and indirectly referenced from AGENTS.md 「検証」 step 2) to exercise
 * the extension-permission dialog flow: it declares three custom extension
 * URLs (`penP`, `lmsLooksPlus`, `SPimgEditor`) so the harness has a known
 * promptable set to drive the `ExtensionPermissionDialog` UI through the
 * real browser MCP loop.
 *
 * The output lives at `test/.test-fixtures/repro.sb3` (gitignored).
 * Regenerate with `npm run fixtures:setup`, which delegates to
 * `scripts/ensure-test-fixtures.mjs`.
 *
 * Idempotent: re-running overwrites the existing file.
 */
import JSZip from 'jszip';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'repro.sb3');

// Extension sources are inlined as data: URLs so the smoke test does not
// require network access to extension hosts. Each blob is a no-op
// `Scratch.extensions.register(...)` call that satisfies the project's
// `extensionURLs` resolution path without depending on the upstream
// extensions.turbowarp.org CDN.
const SPIMG_EDITOR_DATA_URL =
  'data:application/x-javascript;base64,' +
  Buffer.from(
    [
      '// Name: Image Editor',
      '// ID: SPimgEditor',
      '// Description: Create and Edit the Pixel Data of Images',
      '// By: SharkPool',
      '// License: MIT',
      '',
      '(function (Scratch) {',
      '  "use strict";',
      '  if (!Scratch.extensions.unsandboxed) throw new Error("Image Editor must run unsandboxed!");',
      '',
      '  const regainReporters = ["SPimgEditor_pixelHex", "SPimgEditor_pixelIndex", "SPimgEditor_setPixel"];',
      '',
      '  let imageBank = Object.create(null);',
      '',
      '  class SPimgEditor {',
      '    constructor() {',
      '      this._showUnsafeOptions = false;',
      '    }',
      '    getInfo() {',
      '      return {',
      '        id: "SPimgEditor",',
      '        name: Scratch.translate({',
      '          id: "SPimgEditor.name",',
      '          default: "Image Editor",',
      '          description: "Image Editor"',
      '        }),',
      '        color1: "#4756b3",',
      '        color2: "#1f254d",',
      '        color3: "#333d80",',
      '        menuIconURI: undefined,',
      '        blocks: []',
      '      };',
      '    }',
      '  }',
      '',
      '  Scratch.extensions.register(new SPimgEditor());',
      '})(Scratch);',
    ].join('\n'),
    'utf8',
  ).toString('base64');

const project = {
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [
        {
          name: 'blank',
          dataFormat: 'svg',
          assetId: '78f1c8994065bafc771e04e2af4f7453',
          md5ext: '78f1c8994065bafc771e04e2af4f7453.svg',
          rotationCenterX: 0,
          rotationCenterY: 0,
        },
      ],
      sounds: [],
      volume: 100,
      layerOrder: 0,
      videoTransparency: 50,
      videoState: 'on',
      textToSpeechLanguage: null,
    },
    {
      isStage: false,
      name: 'util',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [
        {
          name: 'blank',
          dataFormat: 'svg',
          assetId: '78f1c8994065bafc771e04e2af4f7453',
          md5ext: '78f1c8994065bafc771e04e2af4f7453.svg',
          rotationCenterX: 0,
          rotationCenterY: 0,
        },
        {
          name: 'test',
          bitmapResolution: 2,
          dataFormat: 'png',
          // Note: the original repro-project.json references a PNG asset by
          // MD5 that is never embedded in the .sb3; the runtime resolves it
          // to a missing-asset error, which the ExtensionPermissionDialog
          // covers gracefully. We preserve the dangling reference for
          // behavioral parity with the previously committed fixture.
          assetId: 'd10b7862893a9ae0b11cf39266d9d4d1',
          md5ext: 'd10b7862893a9ae0b11cf39266d9d4d1.png',
          rotationCenterX: 480,
          rotationCenterY: 199,
        },
      ],
      sounds: [],
      volume: 100,
      layerOrder: 1,
      visible: false,
      x: 0,
      y: 0,
      size: 100,
      direction: 90,
      draggable: false,
      rotationStyle: 'all around',
    },
  ],
  monitors: [],
  extensions: ['penP', 'lmsLooksPlus', 'SPimgEditor'],
  extensionURLs: {
    penP: 'https://extensions.turbowarp.org/obviousAlexC/penPlus.js',
    lmsLooksPlus: 'https://extensions.turbowarp.org/Lily/LooksPlus.js',
    SPimgEditor: SPIMG_EDITOR_DATA_URL,
  },
  meta: {
    semver: '3.0.0',
    vm: '0.2.0',
    agent: '',
    platform: { name: 'TurboWarp', url: 'https://turbowarp.org/' },
  },
};

async function writeReproFixture() {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, Buffer.from(buf));
  // eslint-disable-next-line no-console
  console.log(`[repro-fixture] wrote ${outPath} (${buf.byteLength} bytes)`);
  return outPath;
}

async function main() {
  await writeReproFixture();
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[repro-fixture] FAILED:', err);
    process.exit(1);
  });
}

/**
 * Library entry point: write `repro.sb3` into `.test-fixtures/`.
 * Re-exported for `scripts/ensure-test-fixtures.mjs`.
 */
export async function makeRepro() {
  return writeReproFixture();
}
