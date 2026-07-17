#!/usr/bin/env node
/**
 * Generate `expo-fixture.sb3` — the canonical demo project for the GPU
 * compute kernel pipeline (spec §13 / `fn expo`).
 *
 * Purpose
 * -------
 * The fixture exists to drive the M6 pre-parse pipeline:
 *
 *   - The `@compute` block comment is detected by `region-extractor.ts`
 *     and a `RegionVerdict` is built.
 *   - The DSL parser + D1/D2/D3 verdicts + WGSL emitter run end-to-end.
 *   - The `bootstrapGpuKernels` log line
 *     `[gpu-kernel] bootstrapped <N> region(s); ... device=...` fires.
 *   - The vendored VM hook (`__turboWasmGpuKernelDispatch`) gets a
 *     non-undefined `lookup(blockId)` if the GPU tier is active.
 *
 * In dev / jsdom the WebGPU device is unavailable, so the pipeline
 * reports `device=null` and the registry is empty. That's fine: the
 * fixture's purpose is to exercise the pre-parse + hook-install paths,
 * not to actually dispatch (which requires a real WebGPU adapter).
 *
 * Project layout
 * --------------
 * Stage owns three local lists (each a 1-element list holding a single
 * numeric value — scratch's idiomatic "scalar-via-list" encoding) and a
 * scalar variable `tmp0`. One sprite carries:
 *
 *   - A `procedures_prototype` placeholder for `pow2 (v)` (the spec's
 *     helper block; lives outside the `@compute` region).
 *   - A `procedures_prototype` placeholder for the demo's "main" block.
 *   - A `when flag clicked` hat whose body contains the actual demo:
 *     a `repeat (aabb_w)` whose first substack block carries the
 *     `@compute` comment. Inside the body we read `buff_r[R0]` (the
 *     GPU-side buffer), multiply by `tmp0`, and clamp to `[0, 255]` —
 *     using only D1-safe opcodes. The actual write-back to `buff_r[idx]`
 *     is performed by the `@map R0 <- 0` directive on the GPU side.
 *
 * The fixture intentionally uses scratch block IDs that look realistic
 * but is **not** designed to be a fully runnable scratch program.
 * scratch-parser validates the JSON shape (opcodes / inputs / fields /
 * mutation) but the M6 pre-parse only walks the parsed blocks for a
 * `control_repeat` whose first substack block carries an `@compute`
 * comment — that's what the harness verifies.
 *
 * Regeneration
 * ------------
 * Run via `node scripts/make-expo-fixture.mjs` or
 * `npm run fixtures:setup` (which delegates to
 * `scripts/ensure-test-fixtures.mjs`). Idempotent: re-running overwrites
 * the existing file.
 */

import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// Generated fixture workspace is `test/.test-fixtures/` (gitignored).
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'expo-fixture.sb3');

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

// --- SB3 input shape constants (vendored scratch-vm/src/serialization/sb3.js) ---
const INPUT_SAME_BLOCK_SHADOW = 1;
const INPUT_BLOCK_NO_SHADOW = 2;
const MATH_NUM_PRIMITIVE = 4;

let nextBlockId = 1;
const nextId = () => `b${nextBlockId++}`;
const resetCounter = () => {
  nextBlockId = 1;
};

function inlineNum(value) {
  return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
}

function listShadow(listName) {
  return [INPUT_SAME_BLOCK_SHADOW, listName];
}

// --- Comment text templates -----------------------------------------------

const COMPUTE_COMMENT_TEXT = [
  '@compute',
  '@bind tmp0(0) ro f32',
  '@bind buff_r(1) rw f32',
  '@bind aabb_w(2) ro f32',
  '@workgroup_size(64)',
  '@repeat R0:global_x = aabb_w, max=4096',
  '@map R0 <- 0',
].join('\n');

// --- Block builders ------------------------------------------------------
// Each helper returns the constructed block dto. The `parent` / `next`
// pointers are wired by the caller (typically in `buildProject`).

function makeBlock({
  opcode,
  inputs = {},
  fields = {},
  next = null,
  parent = null,
  topLevel = false,
  shadow = false,
  mutation,
  x = 0,
  y = 0,
}) {
  const id = nextId();
  return {
    id,
    block: {
      id,
      opcode,
      inputs,
      fields,
      next,
      parent,
      topLevel,
      shadow,
      x,
      y,
      mutation,
    },
  };
}

function proceduresPrototype(procCode, argumentNames) {
  // The mutation encodes the custom-block signature. We model the
  // bare prototype block; the M6 pre-parse pipeline does not care
  // whether the procedure body is wired up — only that the @compute
  // region exists on a control_repeat's first substack block.
  const mutation = {
    tagName: 'mutation',
    children: [],
    proccode: procCode,
    argumentnames: JSON.stringify(argumentNames),
    argumentids: JSON.stringify(argumentNames.map((_, i) => `arg-${procCode}-${i}`)),
    argumentdefaults: JSON.stringify(argumentNames.map(() => '')),
    warp: 'true',
    returns: '',
    edited: 'false',
    optype: 'void',
  };
  const { id, block } = makeBlock({
    opcode: 'procedures_prototype',
    mutation,
    x: 100,
    y: 100,
    topLevel: true,
    shadow: true,
  });
  return { id, block };
}

function mathNumber(value, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'math_number',
    fields: { NUM: [value, null] },
    parent,
    shadow: true,
  });
  return { id, block };
}

function dataReadVar(varName, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_variable',
    fields: { VARIABLE: [varName, null] },
    parent,
  });
  return { id, block };
}

function dataLengthOfList(listName, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_lengthoflist',
    inputs: { LIST: listShadow(listName) },
    parent,
  });
  return { id, block };
}

function dataItemOfList(listName, indexBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_itemoflist',
    inputs: {
      LIST: listShadow(listName),
      INDEX: [INPUT_BLOCK_NO_SHADOW, indexBlockId],
    },
    parent,
  });
  return { id, block };
}

function dataSetVarTo(varName, valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_setvariableto',
    inputs: {
      VARIABLE: [INPUT_SAME_BLOCK_SHADOW, varName], // not a real scratch shape; replaced below
      VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId],
    },
    fields: { VARIABLE: [varName, null] },
    parent,
  });
  // Remove the synthesized VARIABLE input — scratch uses the field for
  // the variable name, not an input. The serializer only inspects the
  // `fields.VARIABLE` entry.
  delete block.inputs.VARIABLE;
  return { id, block };
}

function operatorMultiply(n1BlockId, n2BlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_multiply',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, n1BlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, n2BlockId],
    },
    parent,
  });
  return { id, block };
}

function operatorMin(n1BlockId, n2BlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_min',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, n1BlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, n2BlockId],
    },
    parent,
  });
  return { id, block };
}

function operatorMax(n1BlockId, n2BlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_max',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, n1BlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, n2BlockId],
    },
    parent,
  });
  return { id, block };
}

function repeatBlock(timesBlockId, substackFirstChildId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'control_repeat',
    inputs: {
      TIMES: [INPUT_BLOCK_NO_SHADOW, timesBlockId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId],
    },
    parent,
  });
  return { id, block };
}

function whenFlagClicked() {
  const { id, block } = makeBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x: 200,
    y: 50,
  });
  return { id, block };
}

// --- Project assembly ----------------------------------------------------

function buildProject() {
  resetCounter();

  const stageSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>';
  const spriteSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" fill="#888888"/></svg>';

  const allBlocks = {};

  // ===== Custom-block prototypes (decorative; not wired into a body) =====
  const pow2Proto = proceduresPrototype('pow2 %s', ['v']);
  pow2Proto.block.x = 100;
  pow2Proto.block.y = 200;
  allBlocks[pow2Proto.id] = pow2Proto.block;

  const expoProto = proceduresPrototype('expo', []);
  expoProto.block.x = 300;
  expoProto.block.y = 200;
  allBlocks[expoProto.id] = expoProto.block;

  // ===== when flag clicked → @compute region =====
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  // Inside the when-flag body: repeat (aabb_w) with the @compute comment
  // on its first substack block.
  const aabb_wLength = dataLengthOfList('aabb_w', hat.id);
  allBlocks[aabb_wLength.id] = aabb_wLength.block;

  // First substack block of the repeat — carries the @compute comment.
  const substackFirst = dataSetVarTo('result', '__placeholder__');
  // The placeholder VALUE will be overwritten below; we point it at the
  // first real expression block (the buff_r read).
  allBlocks[substackFirst.id] = substackFirst.block;

  // Body chain (all set-statement blocks, GPU-safe opcodes only):
  //   result = buff_r[R0] * tmp0
  //   result = min(255, max(0, result))
  const r0Var = dataReadVar('R0', substackFirst.id);
  allBlocks[r0Var.id] = r0Var.block;
  const buffRead = dataItemOfList('buff_r', r0Var.id, substackFirst.id);
  allBlocks[buffRead.id] = buffRead.block;
  const tmp0Var = dataReadVar('tmp0', substackFirst.id);
  allBlocks[tmp0Var.id] = tmp0Var.block;
  const product = operatorMultiply(buffRead.id, tmp0Var.id, substackFirst.id);
  allBlocks[product.id] = product.block;

  // Re-wire resultSet1.VALUE to the product.
  substackFirst.block.inputs.VALUE = [INPUT_BLOCK_NO_SHADOW, product.id];

  // Clamp result via min(255, max(0, result)).
  const resultVar1 = dataReadVar('result', substackFirst.id);
  allBlocks[resultVar1.id] = resultVar1.block;
  const zeroLit = mathNumber(0, substackFirst.id);
  allBlocks[zeroLit.id] = zeroLit.block;
  const twofiftyLit = mathNumber(255, substackFirst.id);
  allBlocks[twofiftyLit.id] = twofiftyLit.block;
  const maxOp = operatorMax(zeroLit.id, resultVar1.id, substackFirst.id);
  allBlocks[maxOp.id] = maxOp.block;
  const minOp = operatorMin(twofiftyLit.id, maxOp.id, substackFirst.id);
  allBlocks[minOp.id] = minOp.block;

  // Second set statement (chained after substackFirst): result = minOp.
  const substackSecond = dataSetVarTo('result', minOp.id);
  substackSecond.block.parent = hat.id;
  allBlocks[substackSecond.id] = substackSecond.block;
  substackFirst.block.next = substackSecond.id;

  // Wrap in the control_repeat. The TIMES input reads the aabb_w length.
  const repeat = repeatBlock(aabb_wLength.id, substackFirst.id, hat.id);
  // control_repeat sits as a child of the hat; the chain is hat → repeat.
  hat.block.next = repeat.id;
  allBlocks[repeat.id] = repeat.block;

  // ===== Comments =====
  // The @compute comment must be attached to the first substack block
  // (spec §3.1). Other comments are decorative.
  const comments = {
    cmt_pow2: {
      blockId: pow2Proto.id,
      x: 50,
      y: 250,
      width: 200,
      height: 60,
      minimized: false,
      text: '// helper: sets tmp0 = 2^v (uses operator_mathop "e ^")',
    },
    cmt_expo: {
      blockId: expoProto.id,
      x: 250,
      y: 250,
      width: 200,
      height: 60,
      minimized: false,
      text: '// main: runs the GPU @compute demo',
    },
    cmt_compute: {
      blockId: substackFirst.id,
      x: 200,
      y: 300,
      width: 280,
      height: 160,
      minimized: false,
      text: COMPUTE_COMMENT_TEXT,
    },
  };

  // ===== Stage / Sprite targets =====
  const stageLists = {
    list_aabb_w: {
      name: 'aabb_w',
      isPersistent: true,
      type: 'list',
      value: [100],
      x: 0,
      y: 0,
    },
    list_aabb_height: {
      name: 'aabb_height',
      isPersistent: true,
      type: 'list',
      value: [200],
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
  };
  const stageVars = {
    tmp0: ['tmp0', 0, 0, 0],
    result: ['result', 0, 0, 0],
  };

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: { ...stageVars, ...stageLists },
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [svgCostume(stageSvg, 'blank')],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null,
  };

  const spriteTarget = {
    isStage: false,
    name: 'Expo',
    variables: {
      R0: ['R0', 0, 0, 0],
    },
    lists: {},
    broadcasts: {},
    blocks: allBlocks,
    comments,
    currentCostume: 0,
    costumes: [svgCostume(spriteSvg, 'dot')],
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
      agent: 'turbowasm-gpu-kernel-demo',
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
  console.log(`[expo-fixture] wrote ${out} (${buf.length} bytes)`);
}

/**
 * Library entry point: write `expo-fixture.sb3` into `.test-fixtures/`.
 * Re-exported for `scripts/ensure-test-fixtures.mjs`.
 */
export async function makeExpoFixture() {
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
  makeExpoFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[expo-fixture] FAILED:', err);
    process.exit(1);
  });
}
