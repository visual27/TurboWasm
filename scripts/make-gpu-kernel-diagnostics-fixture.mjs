/**
 * Generate `gpu-kernel-diagnostics-fixture.sb3`.
 *
 * §Phase 5 §15.9 / §15.14 — the diagnostics fixture is intentionally
 * the FIRST GPU-kernel fixture whose primary purpose is to surface
 * diagnostics in `ErrorLogPanel`. Two triggers in a single sprite:
 *
 *   1. Two `control_repeat` blocks both carrying `@compute` comments
 *      (different first-substack blocks per marker). The extractor
 *      promotes the first to the surviving region and emits
 *      `gpu.multiple_compute_regions` (severity `error`) keyed to that
 *      region's `regionId` / `blockId`. The verdict pipeline folds the
 *      diagnostic into the surviving region's
 *      `RegionVerdict.diagnostics`, and the player forwards it to the
 *      ErrorLog via `forwardGpuDiagnostics`.
 *
 *   2. The surviving region uses `@bind let(0) ro f32`. `let` collides
 *      with a WGSL reserved keyword, so the emitter renames it and
 *      emits `gpu.identifier_collision` (severity `warn`). The shared
 *      forwarder forwards that warn into the ErrorLog store (panel
 *      filters it out — the existing `severity === 'error'` UI policy
 *      is preserved).
 *
 * The fixture is intentionally minimal: a single sprite, one Stage
 * target with the three scratch lists required by the `@bind`
 * declarations, and the two `control_repeat`s sharing the same parent
 * (`event_whenflagclicked`) so the second `@compute` comment's
 * candidate does not nest the first.
 */
import JSZip from 'jszip';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'gpu-kernel-diagnostics-fixture.sb3');

const INPUT_BLOCK_NO_SHADOW = 2;
const MATH_NUM_PRIMITIVE = 4;

let nextBlockId = 1;
const nextId = () => `b${nextBlockId++}`;
function resetCounter() {
  nextBlockId = 1;
}

function listShadow(listName) {
  return [INPUT_BLOCK_NO_SHADOW, listName];
}

function makeBlock({ opcode, inputs = {}, fields = {}, next = null, parent = null, topLevel = false, shadow = false, x = 0, y = 0 }) {
  const id = nextId();
  return {
    id,
    block: { id, opcode, inputs, fields, next, parent, topLevel, shadow, x, y },
  };
}

function whenFlagClicked() {
  return makeBlock({ opcode: 'event_whenflagclicked', topLevel: true, x: 200, y: 50 });
}

function mathNumber(value, parent = null) {
  return makeBlock({
    opcode: 'math_number',
    fields: { NUM: [value, null] },
    parent,
    shadow: true,
  });
}

function dataSetVarTo(varName, valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_setvariableto',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
    fields: { VARIABLE: [varName, null] },
    parent,
  });
  return { id, block };
}

function dataVariable(varName, parent = null) {
  return makeBlock({
    opcode: 'data_variable',
    fields: { VARIABLE: [varName, null] },
    parent,
  });
}

function dataReplaceItemOfList(listName, indexBlockId, valueBlockId, parent = null) {
  return makeBlock({
    opcode: 'data_replaceitemoflist',
    inputs: {
      LIST: listShadow(listName),
      INDEX: [INPUT_BLOCK_NO_SHADOW, indexBlockId],
      ITEM: [INPUT_BLOCK_NO_SHADOW, valueBlockId],
    },
    parent,
  });
}

function dataLengthOfList(listName, parent = null) {
  return makeBlock({
    opcode: 'data_lengthoflist',
    inputs: { LIST: listShadow(listName) },
    parent,
  });
}

function repeatBlock(timesBlockId, substackFirstChildId, parent = null) {
  return makeBlock({
    opcode: 'control_repeat',
    inputs: {
      TIMES: [INPUT_BLOCK_NO_SHADOW, timesBlockId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId],
    },
    parent,
  });
}

// Inline math_number (as an `inlineNum`-shaped shadow reporter input
// — `[MATH_NUM_PRIMITIVE, String(value)]`).
function inlineNumberInput(value) {
  return [INPUT_BLOCK_NO_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
}

const DIAGNOSTICS_COMMENT_TEXT = [
  '@compute',
  // §Phase 5 §15.14 — `let` collides with a WGSL reserved keyword, so
  // the emitter renames it and emits `gpu.identifier_collision`. The
  // fixture deliberately exercises this path so the panel's
  // diagnostics-for-warn path can be observed in DevTools (the panel
  // does not surface warns, but the store entry is greppable).
  '@bind let(0) ro f32',
  '@bind buff_r(1) rw f32',
  '@bind aabb_w(2) ro f32',
  '@workgroup_size(64)',
  '@repeat R0:global_x = len(aabb_w)',
  '@map R0 <- 0',
].join('\n');

function buildProject() {
  resetCounter();

  const stageSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>';
  const spriteSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" fill="#888888"/></svg>';

  const allBlocks = {};

  // Hat → first control_repeat (the surviving @compute region) →
  // second control_repeat (a duplicate @compute marker).
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  // ===== Surviving @compute region =====
  // repeat (aabb_w) → result = buff_r[R0] * 0   (zero literal = 0.0; trivial but valid)
  const aabb_wLength = dataLengthOfList('aabb_w', hat.id);
  allBlocks[aabb_wLength.id] = aabb_wLength.block;

  // Body entry carries the @compute comment. result = (buff_r[R0]) * 0
  // is a no-op scratch-side but exercises the `data_itemoflist` and
  // `operator_multiply` paths through the WGSL emitter so a warn
  // (`gpu.identifier_collision` from the `let` @bind) is actually
  // produced alongside the parser success.
  const r0Var = dataVariable('R0', null /* parent wired below */);
  allBlocks[r0Var.id] = r0Var.block;
  const buffRead = makeBlock({
    opcode: 'data_itemoflist',
    inputs: {
      LIST: listShadow('buff_r'),
      INDEX: [INPUT_BLOCK_NO_SHADOW, r0Var.id],
    },
    parent: null,
  });
  allBlocks[buffRead.id] = buffRead.block;
  const product = makeBlock({
    opcode: 'operator_multiply',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, buffRead.id],
      // Inline literal 0 — avoids having to allocate an extra block id.
      NUM2: inlineNumberInput(0),
    },
    parent: null,
  });
  allBlocks[product.id] = product.block;
  const substackFirst = dataSetVarTo('result', product.id);
  // Fix parent / next pointers so the chain is `r0Var → buffRead → product → substackFirst.next`
  // and the body entry is `substackFirst`.
  substackFirst.block.parent = hat.id;
  r0Var.block.parent = substackFirst.id;
  buffRead.block.parent = substackFirst.id;
  product.block.parent = substackFirst.id;
  allBlocks[substackFirst.id] = substackFirst.block;

  const repeat = repeatBlock(aabb_wLength.id, substackFirst.id, hat.id);
  hat.block.next = repeat.id;
  allBlocks[repeat.id] = repeat.block;

  // ===== Duplicate @compute region (lives inside the same sprite) =====
  // repeat (aabb_w) → result = 0   (the comment on its substack head
  // also starts with `@compute`, triggering
  // `gpu.multiple_compute_regions`).
  const dupTimes = dataLengthOfList('aabb_w', hat.id);
  allBlocks[dupTimes.id] = dupTimes.block;
  const dupZero = mathNumber(0, null);
  allBlocks[dupZero.id] = dupZero.block;
  const dupBody = dataSetVarTo('result', dupZero.id);
  dupBody.block.parent = hat.id;
  dupZero.block.parent = dupBody.id;
  allBlocks[dupBody.id] = dupBody.block;

  const dupRepeat = repeatBlock(dupTimes.id, dupBody.id, hat.id);
  // Chain the duplicate repeat after the first one (the parent
  // pointer is shared but `repeat.next` ensures region-extractor's
  // substack walk doesn't bleed across regions — only the first
  // substack block of each repeat matters).
  repeat.block.next = dupRepeat.id;
  allBlocks[dupRepeat.id] = dupRepeat.block;

  // ===== Comments =====
  // Both comments are @compute markers. They live on the FIRST substack
  // block of each repeat (per spec §3.1). The first marker wins; the
  // second is recorded as a duplicate and surfaces as
  // `gpu.multiple_compute_regions`.
  const comments = {
    cmt_compute_a: {
      blockId: substackFirst.id,
      x: 200,
      y: 300,
      width: 280,
      height: 200,
      minimized: false,
      text: DIAGNOSTICS_COMMENT_TEXT,
    },
    cmt_compute_b: {
      blockId: dupBody.id,
      x: 200,
      y: 520,
      width: 280,
      height: 120,
      minimized: false,
      // Minimal comment — any text starting with `@compute` triggers
      // the extractor. Empty `binding` set keeps the second region's
      // emit path quiet so it doesn't get logged on its own.
      text: '@compute\n@repeat S:sequential = 1\n@map S <- 0',
    },
  };

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: {
      result: ['result', 0, 0, 0],
      list_aabb_w: {
        name: 'aabb_w',
        isPersistent: true,
        type: 'list',
        value: [128],
        x: 0,
        y: 0,
      },
      list_buff_r: {
        name: 'buff_r',
        isPersistent: true,
        type: 'list',
        value: [50],
        x: 0,
        y: 0,
      },
    },
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [
      {
        name: 'blank',
        dataFormat: 'svg',
        assetId: 'blank',
        md5ext: 'blank.svg',
        rotationCenterX: 240,
        rotationCenterY: 180,
        svg: stageSvg,
      },
    ],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null,
  };

  const spriteTarget = {
    isStage: false,
    name: 'Diagnostics',
    variables: {
      R0: ['R0', 0, 0, 0],
    },
    lists: {},
    broadcasts: {},
    blocks: allBlocks,
    comments,
    currentCostume: 0,
    costumes: [
      {
        name: 'dot',
        dataFormat: 'svg',
        assetId: 'dot',
        md5ext: 'dot.svg',
        rotationCenterX: 8,
        rotationCenterY: 8,
        svg: spriteSvg,
      },
    ],
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

  return {
    targets: [stageTarget, spriteTarget],
    monitors: [],
    extensions: [],
    extensionURLs: {},
    meta: {
      semver: '3.0.0',
      vm: '0.2.0',
      agent: 'turbowasm-gpu-kernel-diagnostics-demo',
      platform: { name: 'TurboWasm Viewer' },
    },
  };
}

async function writeProject(projectJson, out) {
  const zip = new JSZip();
  const svgAssets = {};
  for (const target of projectJson.targets) {
    if (!target.costumes) continue;
    for (const c of target.costumes) {
      if (c.dataFormat === 'svg' && c.svg) {
        svgAssets[c.md5ext] = c.svg;
        delete c.svg;
      }
    }
  }
  zip.file('project.json', JSON.stringify(projectJson));
  for (const [name, content] of Object.entries(svgAssets)) {
    zip.file(name, content);
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(out, buf);
  // eslint-disable-next-line no-console
  console.log(`[gpu-kernel-diagnostics-fixture] wrote ${out} (${buf.length} bytes)`);
}

/**
 * Library entry: write `gpu-kernel-diagnostics-fixture.sb3` into the
 * `.test-fixtures/` directory. Re-exported for
 * `scripts/ensure-test-fixtures.mjs`.
 */
export async function makeGpuKernelDiagnosticsFixture() {
  mkdirSync(outDir, { recursive: true });
  const project = buildProject();
  await writeProject(project, outPath);
  return outPath;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  makeGpuKernelDiagnosticsFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[gpu-kernel-diagnostics-fixture] FAILED:', err);
    process.exit(1);
  });
}
