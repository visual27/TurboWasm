/**
 * Generate `auto-tmp-fixture.sb3` — §Phase 6 scratch-tmp demo.
 *
 * Purpose
 * -------
 * Drives `collectRegionVerdictsFromArrayBuffer` → `initializeGpuKernels`
 * through a sprite whose `@compute` region body uses scratch `tmp`
 * variables (= `data_setvariableto` writes outside `@bind`/`@map`).
 * The fixture exercises:
 *
 *   - Two independent `tmp` writes (`tmp0` and `tmp1`) — the detector
 *     must surface both as `AutoTmpBinding`s.
 *   - Cross-tmp dependency (`tmp1 = tmp0 + 1`) — the topo order must
 *     put `tmp0` before `tmp1`.
 *   - Read path through `data_variableof` — the WGSL `let` reference
 *     must resolve to the synthesised emit identifier.
 *
 * The fixture intentionally avoids `data_changevariableby` and
 * scratch-variable writes to `@bind`-bound names so the auto-tmp
 * detector returns a clean `valid: true` verdict. Cycle / collision
 * / changevariableby paths are covered by the unit tests in
 * `test/runtime/gpu-kernel/auto-tmp-detector.test.ts`.
 *
 * Project layout
 * --------------
 * Stage owns two scratch lists (`buff_r`, `aabb_w`). One sprite
 * carries a single `control_repeat` whose kernel container carries
 * the `@compute` marker. The body:
 *
 *   - reads `aabb_w[R0]` into `tmp0` (= auto-tmp)
 *   - computes `tmp1 = tmp0 + 1` (= cross-tmp dependency)
 *   - writes `buff_r[R0] = tmp1` (= `scratch_list_write_f32` with the
 *     auto-tmp value as the source)
 *
 * Regeneration
 * ------------
 * Run via `node scripts/make-auto-tmp-fixture.mjs` or
 * `npm run fixtures:setup` (which delegates to
 * `scripts/ensure-test-fixtures.mjs`). Idempotent: re-running
 * overwrites the existing file.
 */
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function md5hex(buf) {
  return createHash('md5').update(buf).digest('hex');
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'auto-tmp-fixture.sb3');

const INPUT_BLOCK_NO_SHADOW = 2;
const MATH_NUM_PRIMITIVE = 4;
// `data_listcontents` primitive id (= `[13, name, id]`).
const LIST_PRIMITIVE = 13;

let nextBlockId = 1;
const nextId = () => `b${nextBlockId++}`;
function resetCounter() {
  nextBlockId = 1;
}

function listIdFor(name) {
  return `list_${name}`;
}

function listShadow(listName) {
  return [INPUT_BLOCK_NO_SHADOW, [LIST_PRIMITIVE, listName, listIdFor(listName)]];
}

function inlineNumberInput(value) {
  return [INPUT_BLOCK_NO_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
}

function makeBlock({
  opcode,
  inputs = {},
  fields = {},
  next = null,
  parent = null,
  topLevel = false,
  shadow = false,
  x = 0,
  y = 0,
}) {
  const id = nextId();
  return {
    id,
    block: { id, opcode, inputs, fields, next, parent, topLevel, shadow, x, y },
  };
}

function whenFlagClicked() {
  return makeBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x: 200,
    y: 50,
  });
}

function dataLengthOfList(listName, parent = null) {
  return makeBlock({
    opcode: 'data_lengthoflist',
    inputs: { LIST: listShadow(listName) },
    parent,
  });
}

function dataVariable(varName, parent = null) {
  return makeBlock({
    opcode: 'data_variable',
    fields: { VARIABLE: [varName, varName] },
    parent,
  });
}

function dataItemOfList(listName, indexBlockId, parent = null) {
  return makeBlock({
    opcode: 'data_itemoflist',
    inputs: {
      LIST: listShadow(listName),
      INDEX: [INPUT_BLOCK_NO_SHADOW, indexBlockId],
    },
    fields: { LIST: [listName, listIdFor(listName)] },
    parent,
  });
}

function operatorAdd(leftBlockId, rightBlockId, parent = null) {
  return makeBlock({
    opcode: 'operator_add',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, leftBlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, rightBlockId],
    },
    parent,
  });
}

function operatorMultiply(leftBlockId, rightBlockId, parent = null) {
  return makeBlock({
    opcode: 'operator_multiply',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, leftBlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, rightBlockId],
    },
    parent,
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

function dataReplaceItemOfList(listName, indexBlockId, valueBlockId, parent = null) {
  return makeBlock({
    opcode: 'data_replaceitemoflist',
    inputs: {
      LIST: listShadow(listName),
      INDEX: [INPUT_BLOCK_NO_SHADOW, indexBlockId],
      ITEM: [INPUT_BLOCK_NO_SHADOW, valueBlockId],
    },
    fields: { LIST: [listName, listIdFor(listName)] },
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

const REGION_COMMENT = [
  '@compute',
  '@bind buff_r(0) rw f32',
  '@bind aabb_w(1) ro f32',
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
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  // Loop bound: len(aabb_w) — feeds `@repeat R0`.
  const aabbLen = dataLengthOfList('aabb_w', hat.id);
  allBlocks[aabbLen.id] = aabbLen.block;

  // Index var reporter (R0).
  const r0Reporter = dataVariable('R0', null);
  allBlocks[r0Reporter.id] = r0Reporter.block;

  // Body entry: `tmp0 = aabb_w[R0]` (auto-tmp, depends on @bind
  // list `aabb_w` only — no other auto-tmp).
  const aabbRead = dataItemOfList('aabb_w', r0Reporter.id, null);
  allBlocks[aabbRead.id] = aabbRead.block;
  const tmp0Set = dataSetVarTo('tmp0', aabbRead.id);
  allBlocks[tmp0Set.id] = tmp0Set.block;

  // `tmp1 = tmp0 + 1` (auto-tmp with cross-tmp dependency on tmp0).
  const tmp0Reporter = dataVariable('tmp0', null);
  allBlocks[tmp0Reporter.id] = tmp0Reporter.block;
  const one = makeBlock({
    opcode: 'math_number',
    fields: { NUM: ['1', null] },
    shadow: true,
  });
  allBlocks[one.id] = one.block;
  const tmp1Add = operatorAdd(tmp0Reporter.id, one.id, null);
  allBlocks[tmp1Add.id] = tmp1Add.block;
  const tmp1Set = dataSetVarTo('tmp1', tmp1Add.id);
  allBlocks[tmp1Set.id] = tmp1Set.block;

  // `buff_r[R0] = tmp1 * 2` — body exit. `data_replaceitemoflist`
  // emits the actual write; tmp1 is read via `data_variableof`.
  const tmp1ReadForWrite = dataVariable('tmp1', null);
  allBlocks[tmp1ReadForWrite.id] = tmp1ReadForWrite.block;
  const two = makeBlock({
    opcode: 'math_number',
    fields: { NUM: ['2', null] },
    shadow: true,
  });
  allBlocks[two.id] = two.block;
  const mul = operatorMultiply(tmp1ReadForWrite.id, two.id, null);
  allBlocks[mul.id] = mul.block;
  const writeBack = dataReplaceItemOfList('buff_r', r0Reporter.id, mul.id, null);
  allBlocks[writeBack.id] = writeBack.block;

  // Chain substack: tmp0Set -> tmp1Set -> writeBack.
  tmp0Set.block.next = tmp1Set.id;
  tmp1Set.block.next = writeBack.id;

  // Walk parents: each body block parents to the previous one so
  // scratch-vm serializer renders them as a contiguous stack.
  r0Reporter.block.parent = tmp0Set.id;
  aabbRead.block.parent = tmp0Set.id;
  tmp0Reporter.block.parent = tmp1Set.id;
  one.block.parent = tmp1Set.id;
  tmp1Add.block.parent = tmp1Set.id;
  tmp1ReadForWrite.block.parent = writeBack.id;
  two.block.parent = writeBack.id;
  mul.block.parent = writeBack.id;

  const repeat = repeatBlock(aabbLen.id, tmp0Set.id, hat.id);
  allBlocks[repeat.id] = repeat.block;
  hat.block.next = repeat.id;

  const comments = {
    cmt_compute: {
      blockId: repeat.id,
      x: 200,
      y: 300,
      width: 280,
      height: 200,
      minimized: false,
      text: REGION_COMMENT,
    },
  };

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: {
      tmp0: ['tmp0', 0],
      tmp1: ['tmp1', 0],
    },
    lists: {
      list_aabb_w: ['aabb_w', [128]],
      list_buff_r: ['buff_r', new Array(128).fill(0)],
    },
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [
      {
        name: 'blank',
        dataFormat: 'svg',
        assetId: md5hex(Buffer.from(stageSvg, 'utf8')),
        md5ext: `${md5hex(Buffer.from(stageSvg, 'utf8'))}.svg`,
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
    name: 'AutoTmpSprite',
    variables: {
      R0: ['R0', 0],
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
        assetId: md5hex(Buffer.from(spriteSvg, 'utf8')),
        md5ext: `${md5hex(Buffer.from(spriteSvg, 'utf8'))}.svg`,
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
      agent: 'turbowasm-gpu-kernel-auto-tmp-demo',
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
  console.log(`[auto-tmp-fixture] wrote ${out} (${buf.length} bytes)`);
}

/**
 * Library entry: write `auto-tmp-fixture.sb3` into the
 * `.test-fixtures/` directory. Re-exported for
 * `scripts/ensure-test-fixtures.mjs`.
 */
export async function makeAutoTmpFixture() {
  mkdirSync(outDir, { recursive: true });
  const project = buildProject();
  await writeProject(project, outPath);
  return outPath;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  makeAutoTmpFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[auto-tmp-fixture] FAILED:', err);
    process.exit(1);
  });
}
