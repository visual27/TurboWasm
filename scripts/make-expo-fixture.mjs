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
// Phase 4 (nested-parallelization-05-phase4 §3.1): nested fixture path
// lives next to the legacy `expo-fixture.sb3` in the same gitignored
// workspace. The two fixtures share block-builder helpers but produce
// different scratch layouts — `verify-gpu-kernel.mjs` exercises both.
const nestedOutPath = resolve(outDir, 'expo-fixture-nested.sb3');

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
  // §Phase 2 (15.3): the inline `, max=<uint>` suffix was removed in v9
  // alongside the `@max` directive. The dispatch cap is now derived
  // from the runtime list length read at dispatch time.
  //
  // §Phase 3 §15.4: the formula now reads `len(aabb_w)` so D2's
  // formula-reference check (axis-analysis.ts:131) sees the bound
  // list name and keeps `global_x` parallel. Previously `R0` had to
  // appear in the formula to satisfy condition (b), which broke
  // dispatch-count semantics — R0 is the iteration counter, not the
  // bound. The legacy block tree (`repeat(aabb_w length)` with body
  // reading `buff_r[R0]`) is unchanged.
  '@repeat R0:global_x = len(aabb_w)',
  '@map R0 <- 0',
].join('\n');

/**
 * Phase 4 (nested-parallelization-05-phase4 §3.1): the nested DSL layout
 * where the `@compute` marker sits on a `control_repeat` whose parent
 * chain has at least one ancestor `control_repeat`.
 *
 * Concretely the fixture builds:
 *
 *   when_flag_clicked
 *     repeat (aabb_len)             ← outer scratch loop (NOT a kernel container)
 *       repeat (aabb_h)             ← kernel container (Phase 0 promotion target)
 *         repeat (aabb_w)           ← @compute candidate (inner control_repeat)
 *           [comment: NESTED_COMPUTE_COMMENT_TEXT]
 *           result = buff_r[idx1] * tmp0    ← body entry (data_setvariableto)
 *           buff_r[idx1] = result           ← actual parallel work
 *
 * `region-extractor.findKernelContainer` walks `repeat(aabb_w).parent` and
 * picks `repeat(aabb_h)` (= kernel container). The `bodyEntry` is the
 * first substack block of `repeat(aabb_w)`. `nestedRepeatContainerBlockIds`
 * is `[repeat(aabb_w).id]` (the candidate). The body chain is just the
 * two blocks above (the `result = ...` set and the `buff_r[idx1] = ...`
 * write).
 *
 * Why this shape:
 *   - exercises `kernelContainerIsNested = true` (kernel container is
 *     promoted to ancestor).
 *   - exercises implicit 2D axis emission:
 *       kernel container (aabb_h) TIMES input → Ry:global_y
 *       nested repeat [0] (aabb_w)  TIMES input → Rx0:global_x
 *   - exercises `@bind ..., scalar` directives (`aabb_idx0`, `aabb_tmp0`,
 *     `screen_w`).
 *   - exercises the auto-detected iteration-advance pattern: the
 *     `idx1 += 1` block (when present in a fuller fixture) is filtered
 *     out of the WGSL body by `skip-block-filter`. The minimal body in
 *     this fixture skips that complication but the bound scalar uniforms
 *     still drive the implicit axes through
 *     `scratchBlockToWgslExpr → u_scratch.<wgsl_name>` rename.
 *   - exercises the indirect-access pattern via the `data_itemoflist`
 *     inside the formula (read); the `data_replaceitemoflist` is the
 *     actual parallel work that survives in the WGSL body.
 *
 * The legacy `buildProject()` (Phase 0 outer-only) layout is preserved
 * untouched — see `expo-fixture.sb3` and `scripts/verify-gpu-kernel.mjs`.
 * This nested variant lives at `expo-fixture-nested.sb3` and is gated by
 * `advanced.nestedParallelizationEnabled` in the Settings dialog.
 */
const NESTED_COMPUTE_COMMENT_TEXT = [
  '@compute',
  // scratch lists (storage buffers)
  '@bind tmp0(0) ro f32',
  '@bind buff_r(1) rw f32',
  '@bind buff_g(2) rw f32',
  '@bind buff_b(3) rw f32',
  '@bind aabb_w(5) ro f32',
  '@bind aabb_h(9) ro f32',
  '@bind aabb_minx(6) ro f32',
  '@bind aabb_miny(7) ro f32',
  // scratch variables (scalar uniforms)
  '@bind aabb_idx0(4) ro i32, scalar',
  '@bind aabb_tmp0(10) ro f32, scalar',
  '@bind screen_w(8) ro f32, scalar',
  // axes & workgroup
  '@workgroup_size(64)',
  '@repeat Ry:global_y = aabb_h[aabb_idx0]',
  '@repeat Rx:global_x = aabb_tmp0',
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

function operatorAdd(n1BlockId, n2BlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_add',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, n1BlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, n2BlockId],
    },
    parent,
  });
  return { id, block };
}

function operatorLessThan(n1BlockId, n2BlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_lt',
    inputs: {
      OPERAND1: [INPUT_BLOCK_NO_SHADOW, n1BlockId],
      OPERAND2: [INPUT_BLOCK_NO_SHADOW, n2BlockId],
    },
    parent,
  });
  return { id, block };
}

function dataReplaceItemOfList(listName, indexBlockId, valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_replaceitemoflist',
    inputs: {
      LIST: listShadow(listName),
      INDEX: [INPUT_BLOCK_NO_SHADOW, indexBlockId],
      ITEM: [INPUT_BLOCK_NO_SHADOW, valueBlockId],
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

// --- Phase 4: nested @compute fixture (legacy layout preserved above) -----

/**
 * Build the nested-fixture variant of `fn expo`.
 *
 * Structure (scratch block chain):
 *
 *   when_flag_clicked (hat)
 *     └ outer_aabb_len   repeat (aabb_len)
 *         └ kernel_aabb_h   repeat (aabb_h)              ← kernel container
 *             └ candidate_aabb_w   repeat (aabb_w)       ← @compute candidate
 *                 [comment: NESTED_COMPUTE_COMMENT_TEXT] (carried on bodyEntry)
 *                 bodyEntry: result = buff_r[idx1] * tmp0
 *                   next:  buff_r[idx1] = result
 *
 * Where:
 *   - `kernel_aabb_h` is `region.kernelContainerBlockId` (= promoted
 *     ancestor; = `region.blockId` after Phase 0 promotion).
 *   - `candidate_aabb_w` is `region.nestedRepeatContainerBlockIds[0]`
 *     (= the @compute marker holder).
 *   - `bodyEntry` (= first substack block of `candidate_aabb_w`) is
 *     `region.firstSubstackBlockId`.
 *   - `bodyBlockIds` covers the body chain inside the candidate's
 *     substack only. The kernel container's body
 *     (e.g. `idx1 = idx0` / `idx0 += screen_w`) is intentionally
 *     excluded — Phase 0's `walkSubstackBody` starts at `bodyEntry` and
 *     does not climb the parent chain.
 *
 * Implicit 2D axes (Phase 2):
 *   - `Ry:global_y` from `kernel_aabb_h.inputs.TIMES` (loop count
 *     expression for the y dimension).
 *   - `Rx0:global_x` from `candidate_aabb_w.inputs.TIMES` (loop count
 *     expression for the x dimension, sourced from the
 *     `nestedRepeatContainerBlockIds[0]` slot).
 *
 * Scalar uniforms (Phase 3 Tier 2):
 *   - `aabb_idx0`, `aabb_tmp0`, `screen_w` are `@bind ..., scalar` —
 *     `scratchBlockToWgslExpr` rewrites `data_variableof` reads to
 *     `u_scratch.<wgsl_name>` lookups against the
 *     `@group(1) @binding(0)` uniform buffer populated by
 *     `runtime.__getScalarValue()` at dispatch time.
 */
function buildNestedProject() {
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

  // ===== Hat =====
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  // ===== Outer repeat (aabb_len) — outer scratch loop, NOT a kernel container.
  // The scratch side performs setup: assign the dynamic counter
  // `aabb_idx0`, fetch `aabb_w[aabb_idx0]` into `aabb_tmp0`, etc.
  // `region-extractor.findKernelContainer` only walks upward until it
  // finds the first ancestor `control_repeat`, so this outer repeat is
  // never promoted — it stays a plain scratch loop.
  const outerTimes = dataLengthOfList('aabb_len', hat.id);
  allBlocks[outerTimes.id] = outerTimes.block;

  // Setup chain inside the outer loop body (scratch opcodes; not part of
  // the @compute region). These blocks live in `outer_aabb_len`'s
  // substack but `walkSubstackBody` only starts at `bodyEntry` (= inside
  // `candidate_aabb_w`), so this whole chain is invisible to the GPU
  // pipeline. We keep it minimal — just a single scratch-side variable
  // read — to make the fixture self-contained.
  const outerSetupEntry = dataSetVarTo('scratch_setup', outerTimes.id);
  outerSetupEntry.block.parent = hat.id;
  // The VALUE input is the outer TIMES block — already wired via the
  // helper. We parent the set-statement to the hat and chain it after
  // the outer repeat (the repeat is the hat's child; the set is the
  // repeat's substack head).
  allBlocks[outerSetupEntry.id] = outerSetupEntry.block;

  const outerRepeat = repeatBlock(outerTimes.id, outerSetupEntry.id, hat.id);
  hat.block.next = outerRepeat.id;
  allBlocks[outerRepeat.id] = outerRepeat.block;

  // ===== Kernel container: repeat (aabb_h) =====
  // This is the block `findKernelContainer` will return for the nested
  // @compute marker below. Its TIMES input is `aabb_h` — Phase 2 turns
  // this into `Ry:global_y`.
  const kernelTimes = dataLengthOfList('aabb_h', outerRepeat.id);
  allBlocks[kernelTimes.id] = kernelTimes.block;

  // Placeholder first block of the kernel container's substack (NOT in
  // the @compute body — `walkSubstackBody` skips ancestorIds). It exists
  // so the kernel container has a valid SUBSTACK input shape.
  const kernelSetupEntry = dataSetVarTo('kernel_setup', kernelTimes.id);
  kernelSetupEntry.block.parent = outerRepeat.id;
  allBlocks[kernelSetupEntry.id] = kernelSetupEntry.block;

  const kernelRepeat = repeatBlock(kernelTimes.id, kernelSetupEntry.id, outerRepeat.id);
  outerSetupEntry.block.next = kernelRepeat.id;
  allBlocks[kernelRepeat.id] = kernelRepeat.block;

  // ===== @compute candidate: repeat (aabb_w) =====
  // Its TIMES input is `aabb_w` — Phase 2 turns this into `Rx0:global_x`.
  // The first block of THIS substack carries the @compute comment.
  const candidateTimes = dataLengthOfList('aabb_w', kernelRepeat.id);
  allBlocks[candidateTimes.id] = candidateTimes.block;

  // Body entry: `result = buff_r[idx1] * tmp0`. The placeholder
  // VALUE input gets overwritten below by the actual expression chain.
  const bodyEntry = dataSetVarTo('result', candidateTimes.id);
  bodyEntry.block.parent = kernelRepeat.id;
  allBlocks[bodyEntry.id] = bodyEntry.block;

  // Build the formula expression for the bodyEntry's VALUE:
  //   idx1 = aabb_idx0 + 1                              (data_changevariableby style)
  //   tmp0_value = scratch variable read (not bound — uses list path)
  //   result = buff_r[idx1] * tmp0_value
  const idx1Read = dataReadVar('idx1', bodyEntry.id);
  allBlocks[idx1Read.id] = idx1Read.block;
  const oneLit = mathNumber(1, bodyEntry.id);
  allBlocks[oneLit.id] = oneLit.block;
  const idx1AfterAdd = operatorAdd(idx1Read.id, oneLit.id, bodyEntry.id);
  allBlocks[idx1AfterAdd.id] = idx1AfterAdd.block;
  // The fixture does NOT actually reassign `idx1` (that's an iteration
  // advance pattern auto-detected by Phase 1 — `idx1 += 1` would land
  // in `effectivePatterns` and be filtered out of the WGSL body). We
  // just use the expression chain to read `buff_r[idx1]`.
  const buffRRead = dataItemOfList('buff_r', idx1AfterAdd.id, bodyEntry.id);
  allBlocks[buffRRead.id] = buffRRead.block;
  const tmp0Read = dataReadVar('tmp0', bodyEntry.id);
  allBlocks[tmp0Read.id] = tmp0Read.block;
  const product = operatorMultiply(buffRRead.id, tmp0Read.id, bodyEntry.id);
  allBlocks[product.id] = product.block;

  bodyEntry.block.inputs.VALUE = [INPUT_BLOCK_NO_SHADOW, product.id];

  // Second body block (chained after bodyEntry):
  //   buff_r[idx1] = result   (data_replaceitemoflist — actual parallel work)
  const buffRWrite = dataReplaceItemOfList('buff_r', idx1AfterAdd.id, product.id, bodyEntry.id);
  buffRWrite.block.parent = kernelRepeat.id;
  allBlocks[buffRWrite.id] = buffRWrite.block;
  bodyEntry.block.next = buffRWrite.id;

  // Wrap in the candidate control_repeat. The candidate sits inside the
  // kernel container's substack; `kernelSetupEntry.next = candidate.id`.
  const candidateRepeat = repeatBlock(
    candidateTimes.id,
    bodyEntry.id,
    kernelRepeat.id,
  );
  kernelSetupEntry.block.next = candidateRepeat.id;
  allBlocks[candidateRepeat.id] = candidateRepeat.block;

  // ===== Comments =====
  // The @compute comment must be attached to the first substack block
  // (= bodyEntry) — same convention as the legacy fixture, see
  // `region-extractor.ts` spec §3.1.
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
      text: '// main: runs the nested GPU @compute demo (Phase 4)',
    },
    cmt_compute: {
      blockId: bodyEntry.id,
      x: 200,
      y: 300,
      width: 320,
      height: 220,
      minimized: false,
      text: NESTED_COMPUTE_COMMENT_TEXT,
    },
  };

  // ===== Stage / Sprite targets =====
  const stageLists = {
    list_aabb_len: {
      name: 'aabb_len',
      isPersistent: true,
      type: 'list',
      value: [4],
      x: 0,
      y: 0,
    },
    list_aabb_w: {
      name: 'aabb_w',
      isPersistent: true,
      type: 'list',
      value: [128],
      x: 0,
      y: 0,
    },
    list_aabb_h: {
      name: 'aabb_h',
      isPersistent: true,
      type: 'list',
      value: [64],
      x: 0,
      y: 0,
    },
    list_aabb_minx: {
      name: 'aabb_minx',
      isPersistent: true,
      type: 'list',
      value: [0],
      x: 0,
      y: 0,
    },
    list_aabb_miny: {
      name: 'aabb_miny',
      isPersistent: true,
      type: 'list',
      value: [0],
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
    list_buff_g: {
      name: 'buff_g',
      isPersistent: true,
      type: 'list',
      value: [50],
      x: 0,
      y: 0,
    },
    list_buff_b: {
      name: 'buff_b',
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
    // Phase 3 Tier 2 scalar uniforms: these scratch variables are
    // referenced from the @repeat formula (`@repeat Ry = aabb_h[aabb_idx0]`)
    // and from the kernel body via `@bind ..., scalar`. The runtime
    // adapter exposes them through `runtime.__getScalarValue(name)`.
    aabb_idx0: ['aabb_idx0', 0, 0, 0],
    aabb_tmp0: ['aabb_tmp0', 0, 0, 0],
    screen_w: ['screen_w', 480, 0, 0],
    scratch_setup: ['scratch_setup', 0, 0, 0],
    kernel_setup: ['kernel_setup', 0, 0, 0],
    idx1: ['idx1', 0, 0, 0],
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
    name: 'ExpoNested',
    variables: {},
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
      agent: 'turbowasm-gpu-kernel-nested-demo',
      platform: { name: 'TurboWasm Viewer' },
    },
  };
}

/**
 * Library entry point: write `expo-fixture-nested.sb3` into
 * `.test-fixtures/`. Re-exported for `scripts/ensure-test-fixtures.mjs`.
 *
 * Phase 4 (nested-parallelization-05-phase4 §3.1). The fixture is the
 * sibling of `makeExpoFixture()` (legacy outer-only layout) and produces
 * a project whose `@compute` candidate has at least one ancestor
 * `control_repeat` — so `region-extractor.findKernelContainer` returns a
 * block distinct from the candidate (`kernelContainerIsNested = true`).
 */
export async function makeNestedExpoFixture() {
  const project = buildNestedProject();
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
  await writeProject(project, svgAssets, nestedOutPath);
  return nestedOutPath;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  mkdirSync(outDir, { recursive: true });
  // CLI: `node scripts/make-expo-fixture.mjs` writes the legacy
  // `expo-fixture.sb3`. `node scripts/make-expo-fixture.mjs nested`
  // writes the Phase 4 nested `expo-fixture-nested.sb3`. Anything else
  // writes both, which is what `npm run fixtures:setup` relies on.
  const arg = process.argv[2];
  const run = async () => {
    if (arg === 'nested') {
      await makeNestedExpoFixture();
    } else if (arg === 'legacy') {
      await makeExpoFixture();
    } else {
      await makeExpoFixture();
      await makeNestedExpoFixture();
    }
  };
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[expo-fixture] FAILED:', err);
    process.exit(1);
  });
}
