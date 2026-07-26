/**
 * Shared base for the Phase 0 / Phase 1+ scratch-vm regression
 * fixtures (see `phase-00-foundation.md` §P0-1-B).
 *
 * Phase 0 ships each generator as a minimal-but-valid sb3 so the
 * `ensure-test-fixtures` schema gate (`@turbowarp/sb3fix.fixJSON`)
 * passes. Phase 1+ expands the `buildProjectJson` body per fixture
 * to express the specific scratch behaviour the test wants to
 * exercise. The base here owns the boring parts:
 *
 *  - `INPUT_SAME_BLOCK_SHADOW`, `INPUT_BLOCK_NO_SHADOW`,
 *    `MATH_NUM_PRIMITIVE`, `LIST_PRIMITIVE` constants that match
 *    `vendored/scratch-vm/src/serialization/sb3.js`.
 *  - The sb3-zip writer that detaches SVG bodies into the asset
 *    stream (the loader refuses inlined `svg` strings).
 *  - The minimum Stage + Sprite-1 shape the scratch-parser schema
 *    demands (variables 2-tuple, lists 2-tuple, MD5 hex assetId).
 *
 * Each concrete generator imports `writeSb3Fixture` and the
 * primitives it needs, then supplies its own `buildProjectJson`.
 */

import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');
export const fixtureDir = resolve(repoRoot, 'test/.test-fixtures');

// Vendored scratch-vm/src/serialization/sb3.js — input shape constants.
export const INPUT_SAME_BLOCK_SHADOW = 1;
export const INPUT_BLOCK_NO_SHADOW = 2;
export const MATH_NUM_PRIMITIVE = 4;
// `text` primitive id (= 10 in `sb3.js`). Used to embed string
// literals in operator inputs that accept both numbers and strings
// (`operator_equals`, `operator_lt`, etc.). The sb3 schema requires
// a `[TEXT_PRIMITIVE, "..."]` tuple shape; bare strings are
// rejected as unknown optionalString types.
export const TEXT_PRIMITIVE = 10;
// `data_listcontents` primitive id. Used by `listShadow` to encode a
// list-menu drop-down as a proper scratch input descriptor instead
// of a bare block-id string (which the loader would treat as an
// unknown block reference).
export const LIST_PRIMITIVE = 13;

/**
 * MD5 hex digest. scratch-parser rejects asset IDs that are not
 * `^[a-fA-F0-9]{32}$` so this is the canonical helper.
 */
export function md5hex(buf) {
  return createHash('md5').update(buf).digest('hex');
}

/**
 * Tiny SVG body that the md5hex helper hashes deterministically.
 * The fixed digest lets us reuse the same assetId across every
 * generator so a phase-1 test does not have to recompute it.
 */
export const FIXTURE_COSTUME_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
export const FIXTURE_COSTUME_ASSET_ID = md5hex(
  Buffer.from(FIXTURE_COSTUME_SVG, 'utf8'),
);
export const FIXTURE_COSTUME_MDEXT = `${FIXTURE_COSTUME_ASSET_ID}.svg`;

/**
 * Standard Stage target. Variables / lists are 2-tuple arrays per
 * the vendored serialization schema; `costumes[].assetId` /
 * `md5ext` are MD5 hex per `sb3fix.fixJSON`. `broadcasts` is the
 * empty map shape scratch-parser expects.
 */
export function defaultStage() {
  return {
    isStage: true,
    name: 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [defaultCostume('blank')],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null,
  };
}

/**
 * Standard sprite target. The shape mirrors what the official
 * scratch-parser expects; `isOriginalSprite: true` matches a freshly
 * added sprite before any duplication.
 */
export function defaultSprite(name = 'Sprite1') {
  return {
    isStage: false,
    name,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [defaultCostume('dot')],
    sounds: [],
    volume: 100,
    layerOrder: 1,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around',
    isOriginalSprite: true,
  };
}

export function defaultCostume(name) {
  return {
    name,
    dataFormat: 'svg',
    assetId: FIXTURE_COSTUME_ASSET_ID,
    md5ext: FIXTURE_COSTUME_MDEXT,
    rotationCenterX: 0,
    rotationCenterY: 0,
    svg: FIXTURE_COSTUME_SVG,
  };
}

/**
 * Build an sb3 zip from a `project` JSON shape. Detaches inline
 * `svg` strings into separate asset entries because the loader
 * rejects inlined SVG bodies. Returns the absolute path on disk
 * so `ensure-test-fixtures.mjs` can confirm the artifact was
 * written.
 */
export async function writeSb3Fixture(filename, project) {
  const assets = {};
  for (const target of project.targets ?? []) {
    if (!target.costumes) continue;
    for (const c of target.costumes) {
      if (c.dataFormat === 'svg' && c.svg) {
        assets[c.md5ext] = c.svg;
        delete c.svg;
      }
    }
  }
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  for (const [name, body] of Object.entries(assets)) {
    zip.file(name, body);
  }
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  const outPath = resolve(fixtureDir, filename);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Default project shape: a single Stage + a single Sprite1 with
 * no scripts / variables / lists. Generators can copy this and
 * add the scratch blocks they need.
 */
export function defaultProjectJson({ agent = 'turbowasm-fixture', spriteName = 'Sprite1' } = {}) {
  return {
    targets: [defaultStage(), defaultSprite(spriteName)],
    monitors: [],
    extensions: [],
    extensionURLs: {},
    meta: {
      semver: '3.0.0',
      vm: '0.2.0',
      agent,
      platform: { name: 'TurboWasm Viewer' },
    },
  };
}

/**
 * Inline number helper. `inputs.TIMES` chains and constant slots
 * need `[1, [4, '5']]` rather than `[1, '5']`.
 */
export function inlineNum(value) {
  return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
}

/**
 * List-shadow helper. Use this for any `data_*oflist` /
 * `data_*oflist` `LIST` field — see AGENTS.md §「SB3 形状規約」
 * for why the bare-string form is loader-rejected.
 */
export function listShadow(listName, listId) {
  return [INPUT_SAME_BLOCK_SHADOW, [LIST_PRIMITIVE, listName, listId]];
}

/**
 * Convenience: read `process.argv[1]` + this module URL to decide
 * whether the script is being run directly. Returns `true` when
 * the user invoked `node scripts/make-<name>.mjs` and false when
 * the file was imported as a library by `ensure-test-fixtures`.
 */
export function isInvokedDirectly() {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}