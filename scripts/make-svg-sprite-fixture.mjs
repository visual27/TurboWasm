#!/usr/bin/env node
/**
 * Generate the SVG-sprite equivalence test fixture.
 *
 * The fixture is a minimal SB3 with three sprites carrying *distinct*
 * SVG costumes at predictable positions, drawn at sizes 50/100/200%.
 * It is consumed by `scripts/verify-turbowarp-equivalent.mjs` and the
 * matching Playwright test (`test/e2e/turbowarp-equivalent.test.ts`).
 *
 * The output lives at `test/.test-fixtures/svg-sprite-fixture.sb3`
 * (gitignored) because loading arbitrary SB3s over HTTP at smoke-test
 * time would couple the harness to the Scratch API. Regenerate with
 * `npm run fixtures:setup` (which delegates to
 * `scripts/ensure-test-fixtures.mjs`).
 *
 * Idempotent: re-running overwrites the existing file.
 */

import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// Generated fixture workspace is `test/.test-fixtures/` (gitignored).
// The directory is created on demand by `scripts/ensure-test-fixtures.mjs`.
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'svg-sprite-fixture.sb3');

function md5hex(buf) {
  return createHash('md5').update(buf).digest('hex');
}

function svgCostume(svg, name) {
  const assetId = md5hex(Buffer.from(svg, 'utf8'));
  return {
    name,
    dataFormat: 'svg',
    assetId,
    md5ext: `${assetId}.svg`,
    rotationCenterX: 0,
    rotationCenterY: 0,
    svg,
  };
}

// Each sprite carries a 100x100 base SVG so that the 50/100/200% size
// variants produce 50/100/200 pixel renders that the harness can
// distinguish by pixel count and centroid. Colors are picked with
// enough chromatic distance to survive JPEG/screenshots.
const SPRITES = [
  {
    name: 'BigSprite',
    color: '#cc3333',
    x: -160,
    y: 110,
    size: 200,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="5" y="5" width="90" height="90" fill="#cc3333"/></svg>',
  },
  {
    name: 'NormalSprite',
    color: '#33aa33',
    x: 30,
    y: -30,
    size: 100,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="5" y="5" width="90" height="90" fill="#33aa33"/></svg>',
  },
  {
    name: 'SmallSprite',
    color: '#3366cc',
    x: 200,
    y: -150,
    size: 50,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="5" y="5" width="90" height="90" fill="#3366cc"/></svg>',
  },
];

function buildProject() {
  const stageSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>';
  const stageCostume = svgCostume(stageSvg, 'stage');

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [stageCostume],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null,
  };

  const spriteTargets = SPRITES.map((s, idx) => ({
    isStage: false,
    name: s.name,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [svgCostume(s.svg, s.name)],
    sounds: [],
    volume: 100,
    layerOrder: idx + 1,
    visible: true,
    x: s.x,
    y: s.y,
    size: s.size,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around',
    isOriginalSprite: true,
  }));

  return {
    targets: [stageTarget, ...spriteTargets],
    monitors: [],
    extensions: [],
    extensionURLs: {},
    meta: {
      semver: '3.0.0',
      vm: '0.2.0',
      agent: 'turbowasm-svg-sprite-fixture',
      platform: { name: 'TurboWasm Viewer' },
    },
  };
}

async function writeProject(projectJson, assetFiles, out) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(projectJson));
  for (const [name, content] of Object.entries(assetFiles)) {
    zip.file(name, content);
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(out, buf);
  // eslint-disable-next-line no-console
  console.log(`[svg-sprite-fixture] wrote ${out} (${buf.length} bytes)`);
}

export async function makeSvgSpriteFixture() {
  const project = buildProject();
  const svgAssets = {};
  for (const target of project.targets) {
    if (!target.costumes) continue;
    for (const c of target.costumes) {
      if (c.dataFormat === 'svg' && c.svg) {
        svgAssets[c.md5ext] = c.svg;
        delete c.svg;
      }
    }
  }
  await writeProject(project, svgAssets, outPath);
  return outPath;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  mkdirSync(outDir, { recursive: true });
  makeSvgSpriteFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[svg-sprite-fixture] FAILED:', err);
    process.exit(1);
  });
}