/**
 * Generate `multi-region-fixture.sb3`.
 *
 * §Phase 3 (gpu-kernel-dsl-phase3-spec §3.6) — the first fixture whose
 * primary purpose is to exercise MULTIPLE `@compute` REGIONS in the
 * same sprite (different `control_repeat` blocks). The fixture
 * intentionally:
 *
 *   - Carries TWO `@compute` markers on TWO distinct `control_repeat`
 *     blocks. Both regions are adopted (no `MULTIPLE_COMPUTE_REGIONS`
 *     diagnostic — that's reserved for the same-block-id case).
 *   - Both regions share `@bind buff_r(2) rw f32` — cross-region slot
 *     overlap is allowed per spec §3.1, and the region-verdict pipeline
 *     surfaces a `console.debug` line in DevTools (no
 *     `ErrorLogPanel` entry).
 *   - The two regions use independent workgroup sizes and `R0`/`R1`
 *     axis names so the canonical keys diverge (= two distinct
 *     pipelines in `KernelRegistry`).
 *
 * Used by:
 *   - `test/runtime/gpu-kernel/multi-region-fixture.test.ts` (loads
 *     the fixture through `collectRegionVerdictsFromArrayBuffer` and
 *     asserts `kernelRegistry.size >= 2`).
 */
import JSZip from 'jszip';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'multi-region-fixture.sb3');

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

function inlineNumberInput(value) {
  return [INPUT_BLOCK_NO_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
}

// Region A comment — uses axis R0, workgroup_size 64.
const REGION_A_COMMENT = [
  '@compute',
  '@bind tmp0(0) ro f32',
  '@bind buff_r(2) rw f32',
  '@bind aabb_w(3) ro f32',
  '@workgroup_size(64)',
  '@repeat R0:global_x = len(aabb_w)',
  '@map R0 <- 0',
].join('\n');

// Region B comment — uses axis R1 (different name → different canonical
// key), workgroup_size 32, also shares buff_r(2) (cross-region slot
// overlap is allowed and surfaces via `console.debug`).
const REGION_B_COMMENT = [
  '@compute',
  '@bind tmp1(1) ro f32',
  '@bind buff_r(2) rw f32',
  '@bind other_count(3) ro f32',
  '@workgroup_size(32)',
  '@repeat R1:global_x = len(other_count)',
  '@map R1 <- 0',
].join('\n');

function buildProject() {
  resetCounter();

  const stageSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>';
  const spriteSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" fill="#888888"/></svg>';

  const allBlocks = {};
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  // ===== Region A: buff_r[R0] = 0 (no-op, but exercises the @bind path) =====
  const aabb_wLength = dataLengthOfList('aabb_w', hat.id);
  allBlocks[aabb_wLength.id] = aabb_wLength.block;
  const aR0Var = dataVariable('R0', null);
  allBlocks[aR0Var.id] = aR0Var.block;
  const aBuffRead = makeBlock({
    opcode: 'data_itemoflist',
    inputs: {
      LIST: listShadow('buff_r'),
      INDEX: [INPUT_BLOCK_NO_SHADOW, aR0Var.id],
    },
    parent: null,
  });
  allBlocks[aBuffRead.id] = aBuffRead.block;
  // Body entry: `result = buff_r[R0] * 1` — no-op math so the emitter
  // emits a `scratch_list_write_f32` body.
  const aProduct = makeBlock({
    opcode: 'operator_multiply',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, aBuffRead.id],
      NUM2: inlineNumberInput(1),
    },
    parent: null,
  });
  allBlocks[aProduct.id] = aProduct.block;
  const aSubstack = dataSetVarTo('result', aProduct.id);
  aSubstack.block.parent = hat.id;
  aR0Var.block.parent = aSubstack.id;
  aBuffRead.block.parent = aSubstack.id;
  aProduct.block.parent = aSubstack.id;
  allBlocks[aSubstack.id] = aSubstack.block;
  const repeatA = repeatBlock(aabb_wLength.id, aSubstack.id, hat.id);
  allBlocks[repeatA.id] = repeatA.block;

  // ===== Region B: a sibling control_repeat with its own @compute marker =====
  const otherLength = dataLengthOfList('other_count', hat.id);
  allBlocks[otherLength.id] = otherLength.block;
  const bR1Var = dataVariable('R1', null);
  allBlocks[bR1Var.id] = bR1Var.block;
  const bBuffRead = makeBlock({
    opcode: 'data_itemoflist',
    inputs: {
      LIST: listShadow('buff_r'),
      INDEX: [INPUT_BLOCK_NO_SHADOW, bR1Var.id],
    },
    parent: null,
  });
  allBlocks[bBuffRead.id] = bBuffRead.block;
  const bProduct = makeBlock({
    opcode: 'operator_multiply',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, bBuffRead.id],
      NUM2: inlineNumberInput(1),
    },
    parent: null,
  });
  allBlocks[bProduct.id] = bProduct.block;
  const bSubstack = dataSetVarTo('result', bProduct.id);
  bSubstack.block.parent = hat.id;
  bR1Var.block.parent = bSubstack.id;
  bBuffRead.block.parent = bSubstack.id;
  bProduct.block.parent = bSubstack.id;
  allBlocks[bSubstack.id] = bSubstack.block;
  const repeatB = repeatBlock(otherLength.id, bSubstack.id, hat.id);
  allBlocks[repeatB.id] = repeatB.block;

  // Chain the two control_repeats under the hat (parent pointer is
  // shared but `repeatA.next` ensures region-extractor's substack walk
  // doesn't bleed across regions).
  hat.block.next = repeatA.id;
  repeatA.block.next = repeatB.id;

  const comments = {
    cmt_compute_a: {
      // §Phase 4 — Form A: the `@compute` marker sits on the
      // `control_repeat` itself (= the kernel container), not on the
      // body's first substack block.
      blockId: repeatA.id,
      x: 200,
      y: 300,
      width: 280,
      height: 200,
      minimized: false,
      text: REGION_A_COMMENT,
    },
    cmt_compute_b: {
      blockId: repeatB.id,
      x: 200,
      y: 540,
      width: 280,
      height: 200,
      minimized: false,
      text: REGION_B_COMMENT,
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
        value: new Array(128).fill(0),
        x: 0,
        y: 0,
      },
      list_other_count: {
        name: 'other_count',
        isPersistent: true,
        type: 'list',
        value: [64],
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
    name: 'MultiRegion',
    variables: {
      R0: ['R0', 0, 0, 0],
      R1: ['R1', 0, 0, 0],
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
      agent: 'turbowasm-gpu-kernel-multi-region-demo',
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
  console.log(`[multi-region-fixture] wrote ${out} (${buf.length} bytes)`);
}

/**
 * Library entry: write `multi-region-fixture.sb3` into the
 * `.test-fixtures/` directory. Re-exported for
 * `scripts/ensure-test-fixtures.mjs`.
 */
export async function makeMultiRegionFixture() {
  mkdirSync(outDir, { recursive: true });
  const project = buildProject();
  await writeProject(project, outPath);
  return outPath;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  makeMultiRegionFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[multi-region-fixture] FAILED:', err);
    process.exit(1);
  });
}