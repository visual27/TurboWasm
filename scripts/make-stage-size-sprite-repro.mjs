#!/usr/bin/env/node
/**
 * Generate a `stage-size-sprite-repro.sb3` fixture with a visible sprite
 * positioned at the center of the stage. Used to reproduce the user-reported
 * "sprite drawing offset on 2nd project load with twconfig" bug.
 *
 * The fixture has:
 *  - A stage with a blank (white) costume (480x360 default).
 *  - A visible sprite at scratch (0, 0) (center of the stage) with a
 *    distinctive red costume (50x50 red square) so the offset, if any,
 *    is visually obvious.
 *  - A `// _twconfig_` comment that pins the stage size to 720x405
 *    (16:9) so we can exercise the "load with twconfig" path. 720x405
 *    was chosen over 480x270 because the larger canvas makes the
 *    horizontal/vertical offset of the sprite immediately obvious. The
 *    defaultAdvanced in localStorage is set to 800x600 so the first
 *    project loads at 800x600, the user opens settings (no change),
 *    then loads this fixture which triggers the twconfig stage-size
 *    switch.
 *
 * Regenerate with `node scripts/make-stage-size-sprite-repro.mjs`.
 * Re-exported through `scripts/ensure-test-fixtures.mjs` for `npm run
 * fixtures:setup`.
 */
import JSZip from 'jszip';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'stage-size-sprite-repro.sb3');
mkdirSync(outDir, { recursive: true });

// 50x50 red square SVG, so the sprite is visually obvious when offset.
const RED_SQUARE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50">
  <rect x="0" y="0" width="50" height="50" fill="#ff0000"/>
  <rect x="25" y="25" width="50" height="50" fill="#ff0000" transform="translate(-25, -25)"/>
</svg>`;

// Blank (white) stage costume.
const BLANK_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <rect width="480" height="360" fill="#ffffff"/>
</svg>`;

// twconfig comment with stageWidth=720, stageHeight=405 (16:9).
const twconfigText = [
  'Configuration for https://turbowarp.org/',
  "You can move, resize, and minimize this comment, but don't edit it by hand. This comment can be deleted to remove the stored settings.",
  '{"framerate":60,"hq":true,"width":720,"height":405} // _twconfig_',
].join('\n');

const project = {
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {
        twconfigComment: {
          blockId: null,
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          minimized: false,
          text: twconfigText,
        },
      },
      currentCostume: 0,
      costumes: [
        {
          name: 'blank',
          dataFormat: 'svg',
          assetId: 'blank-stage',
          md5ext: 'blank-stage.svg',
          rotationCenterX: 240,
          rotationCenterY: 180,
          // Embed the SVG directly so the runtime doesn't try to fetch a
          // separate asset file (which doesn't exist in this minimal
          // fixture).
          fileContent: BLANK_SVG,
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
      name: 'CenterMarker',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [
        {
          name: 'redsquare',
          dataFormat: 'svg',
          assetId: 'redsquare',
          md5ext: 'redsquare.svg',
          rotationCenterX: 25,
          rotationCenterY: 25,
          fileContent: RED_SQUARE_SVG,
        },
      ],
      sounds: [],
      volume: 100,
      layerOrder: 1,
      // Position at the center of the stage.
      visible: true,
      x: 0,
      y: 0,
      size: 100,
      direction: 90,
      draggable: false,
      rotationStyle: 'all around',
    },
  ],
  monitors: [],
  extensions: [],
  extensionURLs: {},
  meta: {
    semver: '3.0.0',
    vm: '0.2.0',
    agent: '',
    platform: { name: 'TurboWasm Viewer', url: 'https://github.com/visual27/TurboWasm' },
  },
};

async function writeStageSizeSpriteRepro() {
  const zip = new JSZip();
  // Embed the costumes as separate files. The runtime expects
  // `assetId + md5ext` to resolve to a file in the zip.
  zip.file('blank-stage.svg', BLANK_SVG);
  zip.file('redsquare.svg', RED_SQUARE_SVG);
  zip.file('project.json', JSON.stringify(project));
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  writeFileSync(outPath, Buffer.from(buf));
  // eslint-disable-next-line no-console
  console.log(`[stage-size-sprite-repro] wrote ${outPath} (${buf.byteLength} bytes)`);
  return outPath;
}

async function main() {
  await writeStageSizeSpriteRepro();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[stage-size-sprite-repro] FAILED:', err);
  process.exit(1);
});

export { writeStageSizeSpriteRepro };
