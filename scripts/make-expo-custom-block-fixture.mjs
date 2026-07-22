/**
 * Custom-block expo fixture: a `procedures_prototype('fn_expo %s')`
 * that encloses the user's pixel-level expo calculation, with the
 * `@compute` marker on the middle `repeat(aabb_h[aabb_idx0])` block
 * (= Form A kernel container, per gpu-kernel-dsl-phase4 §4.1).
 *
 * Scratch layout
 * --------------
 *   when_flag_clicked (hat)
 *     └ procedures_call fn_expo %s arg0=0  (1 call site, the demo)
 *
 *   procedures_definition (custom block hat)
 *     └ procedures_prototype fn_expo %s
 *         SUBSTACK (prototype body, see below)
 *
 *   Prototype body:
 *     set tmp0 = e ^ (ln(2) * v)        // pow2 reduction via operator_mathop
 *     set aabb_idx0 = 0
 *     repeat (aabb_len)                  // outer scratch loop (NOT a kernel container)
 *       change aabb_idx0 by 1
 *       set aabb_tmp0 = aabb_w[aabb_idx0]
 *       set idx0 = aabb_minx[aabb_idx0] + screen_w * aabb_miny[aabb_idx0]
 *       repeat (aabb_h[aabb_idx0])       // <-- @compute marker (kernel container)
 *         set idx1 = idx0
 *         repeat (aabb_tmp0)              // <-- @repeat Rx dispatch axis
 *           change idx1 by 1
 *           set tmp1 = tmp0 * buff_r[idx1]
 *           replace item buff_r at idx1 with 1 + (tmp1 - 1) * (tmp1 < 1)
 *           set tmp1 = tmp0 * buff_g[idx1]
 *           replace item buff_g at idx1 with 1 + (tmp1 - 1) * (tmp1 < 1)
 *           set tmp1 = tmp0 * buff_b[idx1]
 *           replace item buff_b at idx1 with 1 + (tmp1 - 1) * (tmp1 < 1)
 *         change idx0 by screen_w
 *
 * DSL comment text
 * ----------------
 *   @compute
 *   @bind tmp0(0) ro f32
 *   @bind buff_r(1) rw f32
 *   @bind buff_g(2) rw f32
 *   @bind buff_b(3) rw f32
 *   @bind aabb_w(4) ro f32
 *   @bind aabb_h(5) ro f32
 *   @bind aabb_idx0(6) ro i32, scalar
 *   @bind aabb_tmp0(7) ro f32, scalar
 *   @bind screen_w(8) ro f32, scalar
 *   @bind idx0(9) ro f32, scalar
 *   @workgroup_size(64)
 *   @repeat Rx:global_x = aabb_tmp0, repeatPath="0"
 *
 * The middle `repeat(aabb_h[aabb_idx0])` is the Form A kernel container.
 * Its child repeat (`repeat(aabb_tmp0)`) becomes the `global_x` axis via
 * the `repeatPath="0"` directive. Scalar uniforms (`aabb_idx0`,
 * `aabb_tmp0`, `screen_w`, `idx0`) carry runtime state through the
 * `@group(1) @binding(0)` uniform buffer (§Phase 3 §15.4).
 *
 * Pixel-level parallelization
 * ---------------------------
 * When WebGPU is available (`enableWebgpu=true`), the kernel fires
 * once per outer `repeat(aabb_len)` iteration (= per AABB). Each
 * dispatch runs `aabb_h[aabb_idx0] × aabb_w[aabb_idx0]` work-items
 * in parallel (Rx ∈ [0, aabb_tmp0) per row, with the outer
 * `repeat(aabb_h[aabb_idx0])` frame covering the rows). When WebGPU
 * is disabled, the scratch VM executes the prototype body verbatim,
 * running the per-pixel work serially — that's the JS baseline we
 * compare against in `scripts/measure-expo-custom-block.mjs`.
 */

import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'expo-custom-block-fixture.sb3');

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
const LIST_PRIMITIVE = 13;

let nextBlockId = 1;
const nextId = () => `b${nextBlockId++}`;
const resetCounter = () => {
  nextBlockId = 1;
};

function inlineNum(value) {
  return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
}

function listShadow(listName, listId) {
  return [INPUT_SAME_BLOCK_SHADOW, [LIST_PRIMITIVE, listName, listId]];
}

function listIdFor(name) {
  return `list_${name}`;
}

// --- DSL comment text (placed on the Form A kernel container) -------------

const COMPUTE_COMMENT_TEXT = [
  '@compute',
  // §Scratch design — `tmp0` is a per-call scalar
  // (`set tmp0 = e ^ (ln(2) * v)` inside the prototype body). The
  // kernel reads it through the `@group(1) @binding(0)` uniform
  // buffer via the runtime adapter's `__getScalarValue('tmp0')`.
  // (`tmp1` is a scratch temporary — auto-promoted to per-write
  // WGSL `let` bindings by §Phase 6 (extended) auto-tmp detection,
  // so no explicit `@bind` is needed. Each `set tmp1 ...` block in
  // the body gets its own SSA-unique identifier so R/G/B reads
  // survive scratch's reassignment semantics.)
  //
  // §Scratch design — `aabb_tmp0` is exposed to the kernel as a
  // length-1 list binding rather than a scalar uniform so the DSL
  // formula `len(aabb_tmp0)` resolves against a non-scalar `@bind`
  // (condition (b) of `analyzeAxes` only checks list bindings —
  // `scalar` uniforms feed `data_variableof` resolution and are
  // never loop bounds). The scratch body mutates the list via
  // `replace item of aabb_tmp0 at 1 with aabb_w[aabb_idx0]`,
  // which makes the dispatch count per-AABB (= aabb_w[aabb_idx0]).
  '@bind tmp0(0) ro f32, scalar',
  '@bind buff_r(1) rw f32',
  '@bind buff_g(2) rw f32',
  '@bind buff_b(3) rw f32',
  '@bind aabb_w(4) ro f32',
  '@bind aabb_h(5) ro f32',
  '@bind aabb_idx0(6) ro i32, scalar',
  '@bind aabb_tmp0(7) rw f32',
  '@bind screen_w(8) ro f32, scalar',
  '@bind idx0(9) ro f32, scalar',
  '@workgroup_size(64)',
  // §Axis configuration — `@map Rx <- __tw_gid.x` maps the global
  // invocation id to the @map variable (= D2 condition (a)). The
  // WGSL emitter wraps the formula in `f32(...)` so the implicit
  // `u32 → f32` conversion lands cleanly. The kernel container is
  // implicit (its TIMES input becomes the kernel's outer frame; the
  // kernel runs once per outer-scratch-loop iteration and the per-
  // row iteration falls back to the kernel container's `inputs.TIMES`
  // chain).
  '@map Rx <- __tw_gid.x',
  '@repeat Rx:global_x = len(aabb_tmp0), repeatPath="0"',
].join('\n');

// --- Block builders -------------------------------------------------------

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

function dataSetVarTo(varName, valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_setvariableto',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
    fields: { VARIABLE: [varName, null] },
    parent,
  });
  return { id, block };
}

function dataChangeVarBy(varName, deltaBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_changevariableby',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, deltaBlockId] },
    fields: { VARIABLE: [varName, null] },
    parent,
  });
  return { id, block };
}

function dataItemOfList(listName, indexBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_itemoflist',
    inputs: {
      LIST: listShadow(listName, listIdFor(listName)),
      INDEX: [INPUT_BLOCK_NO_SHADOW, indexBlockId],
    },
    fields: { LIST: [listName, listIdFor(listName)] },
    parent,
  });
  return { id, block };
}

function dataLengthOfList(listName, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_lengthoflist',
    inputs: { LIST: listShadow(listName, listIdFor(listName)) },
    parent,
  });
  return { id, block };
}

function dataReplaceItemOfList(listName, indexBlockId, valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_replaceitemoflist',
    inputs: {
      LIST: listShadow(listName, listIdFor(listName)),
      INDEX: [INPUT_BLOCK_NO_SHADOW, indexBlockId],
      ITEM: [INPUT_BLOCK_NO_SHADOW, valueBlockId],
    },
    fields: { LIST: [listName, listIdFor(listName)] },
    parent,
  });
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

function operatorSubtract(n1BlockId, n2BlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_subtract',
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

function operatorLessThan(leftId, rightId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_lt',
    inputs: {
      OPERAND1: [INPUT_BLOCK_NO_SHADOW, leftId],
      OPERAND2: [INPUT_BLOCK_NO_SHADOW, rightId],
    },
    parent,
  });
  return { id, block };
}

function mathopBlock(op, valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_mathop',
    inputs: { NUM: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
    fields: { OPERATOR: [op, null] },
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

function procedureCall(procCode, argBlockIds, parent = null) {
  const inputs = {};
  for (let i = 0; i < argBlockIds.length; i += 1) {
    inputs[`arg${i}`] = [INPUT_BLOCK_NO_SHADOW, argBlockIds[i]];
  }
  const { id, block } = makeBlock({
    opcode: 'procedures_call',
    inputs,
    // §scratch-vm `mutationToXML` requires `mutation.children` to be
    // defined (line 40926 of `scaffolding-min.js`). An empty array is
    // valid — the prototype supplies the actual `<arg>` nodes during
    // XML round-trip via the loader. Without `children`, the project's
    // first `emitWorkspaceUpdate` throws TypeError and the project
    // never finishes loading. `custom-block-fixture.sb3` has the same
    // gap; see the comment at `make-custom-block-fixture.mjs:210`
    // for the eventual fix path (probably needs to add `children: []`
    // there too).
    mutation: { tagName: 'mutation', children: [], proccode: procCode },
    parent,
  });
  return { id, block };
}

function proceduresPrototype(procCode, argumentNames, substackHeadId) {
  // §scratch-vm `mutationToXML` recursively serializes
  // `mutation.children`. For `procedures_prototype`, the children
  // are `<arg>` node descriptors — one per argument — each a
  // `mutation`-shaped sub-object with its own `tagName` /
  // `children`. The loader walks these to set up argument reporter
  // blocks. `custom-block-fixture.mjs` skips this and falls back to
  // the same empty-`children` workaround; we add the proper
  // descriptor list so the in-browser serializer doesn't blow up.
  const argDescriptors = argumentNames.map((name) => ({
    tagName: 'arg',
    children: [],
    name,
  }));
  const mutation = {
    tagName: 'mutation',
    children: argDescriptors,
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
    inputs: { SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackHeadId] },
    mutation,
    topLevel: true,
    shadow: true,
    x: 100,
    y: 100,
  });
  return { id, block };
}

function proceduresDefinition(prototypeId) {
  const { id, block } = makeBlock({
    opcode: 'procedures_definition',
    inputs: { custom_block: [INPUT_SAME_BLOCK_SHADOW, prototypeId] },
    topLevel: true,
    x: 350,
    y: 100,
  });
  return { id, block };
}

function argumentReporterString(name, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'argument_reporter_string_number',
    fields: { VALUE: [name, null] },
    parent,
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

  // ===== Inner body: per-pixel expo calculation (per-channel R/G/B)
  // Buffers are read at idx1 for `tmp1 = tmp0 * buff_*[idx1]`.
  // We pass the `innerRepeat` placeholder as the `parent` for every
  // block in this inner body so scratch-vm's `blockToXML` can walk the
  // tree correctly (otherwise it falls into infinite recursion trying to
  // walk via `inputs.*` alone — see AGENTS.md §SB3 形状規約 and the
  // `procedures_call` discussion in the existing `make-expo-fixture.mjs`
  // nested generator).
  const idx1ReadForBuffR = dataReadVar('idx1', 'innerRepeat');
  allBlocks[idx1ReadForBuffR.id] = idx1ReadForBuffR.block;
  const idx1ReadForBuffG = dataReadVar('idx1', 'innerRepeat');
  allBlocks[idx1ReadForBuffG.id] = idx1ReadForBuffG.block;
  const idx1ReadForBuffB = dataReadVar('idx1', 'innerRepeat');
  allBlocks[idx1ReadForBuffB.id] = idx1ReadForBuffB.block;

  const tmp0Read = dataReadVar('tmp0', 'innerRepeat');
  allBlocks[tmp0Read.id] = tmp0Read.block;

  const buffRRead = dataItemOfList('buff_r', idx1ReadForBuffR.id, 'innerRepeat');
  allBlocks[buffRRead.id] = buffRRead.block;
  const buffGRead = dataItemOfList('buff_g', idx1ReadForBuffG.id, 'innerRepeat');
  allBlocks[buffGRead.id] = buffGRead.block;
  const buffBRead = dataItemOfList('buff_b', idx1ReadForBuffB.id, 'innerRepeat');
  allBlocks[buffBRead.id] = buffBRead.block;

  const productR = operatorMultiply(tmp0Read.id, buffRRead.id, 'innerRepeat');
  allBlocks[productR.id] = productR.block;
  const setTmp1R = dataSetVarTo('tmp1', productR.id, 'innerRepeat');
  allBlocks[setTmp1R.id] = setTmp1R.block;

  const tmp1ReadForR = dataReadVar('tmp1', 'innerRepeat');
  allBlocks[tmp1ReadForR.id] = tmp1ReadForR.block;
  const oneLitForR = mathNumber(1, 'innerRepeat');
  allBlocks[oneLitForR.id] = oneLitForR.block;
  const tmp1Minus1 = operatorSubtract(tmp1ReadForR.id, oneLitForR.id, 'innerRepeat');
  allBlocks[tmp1Minus1.id] = tmp1Minus1.block;
  const tmp1LessThan1 = operatorLessThan(tmp1ReadForR.id, oneLitForR.id, 'innerRepeat');
  allBlocks[tmp1LessThan1.id] = tmp1LessThan1.block;
  const productClampR = operatorMultiply(tmp1Minus1.id, tmp1LessThan1.id, 'innerRepeat');
  allBlocks[productClampR.id] = productClampR.block;
  const sumClampR = operatorAdd(oneLitForR.id, productClampR.id, 'innerRepeat');
  allBlocks[sumClampR.id] = sumClampR.block;
  const writeR = dataReplaceItemOfList('buff_r', idx1ReadForBuffR.id, sumClampR.id, 'innerRepeat');
  allBlocks[writeR.id] = writeR.block;

  const productG = operatorMultiply(tmp0Read.id, buffGRead.id, 'innerRepeat');
  allBlocks[productG.id] = productG.block;
  const setTmp1G = dataSetVarTo('tmp1', productG.id, 'innerRepeat');
  allBlocks[setTmp1G.id] = setTmp1G.block;

  const tmp1ReadForG = dataReadVar('tmp1', 'innerRepeat');
  allBlocks[tmp1ReadForG.id] = tmp1ReadForG.block;
  const oneLitForG = mathNumber(1, 'innerRepeat');
  allBlocks[oneLitForG.id] = oneLitForG.block;
  const tmp1GMinus1 = operatorSubtract(tmp1ReadForG.id, oneLitForG.id, 'innerRepeat');
  allBlocks[tmp1GMinus1.id] = tmp1GMinus1.block;
  const tmp1GLessThan1 = operatorLessThan(tmp1ReadForG.id, oneLitForG.id, 'innerRepeat');
  allBlocks[tmp1GLessThan1.id] = tmp1GLessThan1.block;
  const productClampG = operatorMultiply(tmp1GMinus1.id, tmp1GLessThan1.id, 'innerRepeat');
  allBlocks[productClampG.id] = productClampG.block;
  const sumClampG = operatorAdd(oneLitForG.id, productClampG.id, 'innerRepeat');
  allBlocks[sumClampG.id] = sumClampG.block;
  const writeG = dataReplaceItemOfList('buff_g', idx1ReadForBuffG.id, sumClampG.id, 'innerRepeat');
  allBlocks[writeG.id] = writeG.block;

  const productB = operatorMultiply(tmp0Read.id, buffBRead.id, 'innerRepeat');
  allBlocks[productB.id] = productB.block;
  const setTmp1B = dataSetVarTo('tmp1', productB.id, 'innerRepeat');
  allBlocks[setTmp1B.id] = setTmp1B.block;

  const tmp1ReadForB = dataReadVar('tmp1', 'innerRepeat');
  allBlocks[tmp1ReadForB.id] = tmp1ReadForB.block;
  const oneLitForB = mathNumber(1, 'innerRepeat');
  allBlocks[oneLitForB.id] = oneLitForB.block;
  const tmp1BMinus1 = operatorSubtract(tmp1ReadForB.id, oneLitForB.id, 'innerRepeat');
  allBlocks[tmp1BMinus1.id] = tmp1BMinus1.block;
  const tmp1BLessThan1 = operatorLessThan(tmp1ReadForB.id, oneLitForB.id, 'innerRepeat');
  allBlocks[tmp1BLessThan1.id] = tmp1BLessThan1.block;
  const productClampB = operatorMultiply(tmp1BMinus1.id, tmp1BLessThan1.id, 'innerRepeat');
  allBlocks[productClampB.id] = productClampB.block;
  const sumClampB = operatorAdd(oneLitForB.id, productClampB.id, 'innerRepeat');
  allBlocks[sumClampB.id] = sumClampB.block;
  const writeB = dataReplaceItemOfList('buff_b', idx1ReadForBuffB.id, sumClampB.id, 'innerRepeat');
  allBlocks[writeB.id] = writeB.block;

  // Inner-body chain: changeIdx1 -> setTmp1R -> writeR -> setTmp1G -> writeG -> setTmp1B -> writeB
  const incOneLit = mathNumber(1, 'innerRepeat');
  allBlocks[incOneLit.id] = incOneLit.block;
  const changeIdx1 = dataChangeVarBy('idx1', incOneLit.id, 'innerRepeat');
  allBlocks[changeIdx1.id] = changeIdx1.block;
  changeIdx1.block.next = setTmp1R.id;
  setTmp1R.block.next = writeR.id;
  writeR.block.next = setTmp1G.id;
  setTmp1G.block.next = writeG.id;
  writeG.block.next = setTmp1B.id;
  setTmp1B.block.next = writeB.id;

  // ===== inner dispatch axis: repeat (aabb_tmp0) — substack starts at changeIdx1
  const aabbTmp0Read = dataReadVar('aabb_tmp0', 'kernelContainer');
  allBlocks[aabbTmp0Read.id] = aabbTmp0Read.block;
  const innerRepeat = repeatBlock(aabbTmp0Read.id, changeIdx1.id, 'kernelContainer');
  allBlocks[innerRepeat.id] = innerRepeat.block;

  // ===== inside kernel container: set idx1 = idx0 (first substack block)
  const idx0ReadInside = dataReadVar('idx0', 'kernelContainer');
  allBlocks[idx0ReadInside.id] = idx0ReadInside.block;
  const setIdx1 = dataSetVarTo('idx1', idx0ReadInside.id, 'kernelContainer');
  setIdx1.block.next = innerRepeat.id;
  allBlocks[setIdx1.id] = setIdx1.block;

  // ===== After innerRepeat: change idx0 by screen_w (kernel-container substack tail)
  const screenWReadForChange = dataReadVar('screen_w', 'kernelContainer');
  allBlocks[screenWReadForChange.id] = screenWReadForChange.block;
  const changeIdx0 = dataChangeVarBy('idx0', screenWReadForChange.id, 'kernelContainer');
  allBlocks[changeIdx0.id] = changeIdx0.block;
  innerRepeat.block.next = changeIdx0.id;

  // ===== kernel container: repeat (aabb_h[aabb_idx0]) =====
  // Form A: `@compute` marker sits on this control_repeat block.
  // The substack starts at `setIdx1` (= first block inside).
  const aabbIdx0ForH = dataReadVar('aabb_idx0', 'outerRepeat');
  allBlocks[aabbIdx0ForH.id] = aabbIdx0ForH.block;
  const aabbHRead = dataItemOfList('aabb_h', aabbIdx0ForH.id, 'outerRepeat');
  allBlocks[aabbHRead.id] = aabbHRead.block;
  const kernelContainer = repeatBlock(aabbHRead.id, setIdx1.id, 'outerRepeat');
  allBlocks[kernelContainer.id] = kernelContainer.block;

  // ===== outer repeat (aabb_len) — pure scratch setup loop.
  // The body starts at `changeAabbIdx0` and chains through the
  // setup steps. The kernelContainer is the LAST block of the outer
  // repeat body — so `outerRepeat.next = kernelContainer.id` via the
  // chain. Every block in the outer body has `parent = outerRepeat`
  // so scratch-vm's `blockToXML` walker doesn't infinite-recurse.
  const oneLit = mathNumber(1, 'outerRepeat');
  allBlocks[oneLit.id] = oneLit.block;
  const changeAabbIdx0 = dataChangeVarBy('aabb_idx0', oneLit.id, 'outerRepeat');
  allBlocks[changeAabbIdx0.id] = changeAabbIdx0.block;

  const aabbWReadForTmp0 = dataItemOfList(
    'aabb_w',
    // §Avoid blockToXML infinite recursion — `dataItemOfList`'s
    // `INDEX` slot MUST NOT reference a block that itself has a
    // `next` chain leading back to `dataItemOfList`'s parent
    // (`data_replaceitemoflist` here) via `inputs`. Reusing
    // `changeAabbIdx0` as the INDEX produced a `b47 → b49 →
    // b48 → b47` cycle in the scratch-vm input graph and the
    // `emitWorkspaceUpdate` walker overflowed the JS stack. A
    // dedicated `data_variableof aabb_idx0` reader gives us the
    // post-`change` value without back-referencing the assignment
    // block.
    dataReadVar('aabb_idx0', 'outerRepeat').id,
    'outerRepeat',
  );
  allBlocks[aabbWReadForTmp0.id] = aabbWReadForTmp0.block;
  // §Scratch design — `aabb_tmp0` is exposed to the kernel as a
  // length-1 list (matching the `@bind aabb_tmp0(7) rw f32` line
  // in `COMPUTE_COMMENT_TEXT`). The DSL formula `len(aabb_tmp0)`
  // resolves to the runtime list length (= 1). The dispatcher
  // `dispatchWorkgroups(ceil(len(aabb_tmp0) / 64), 1, 1)` runs
  // the kernel body once per AABB; the per-row loop comes from
  // the kernel container's `inputs.TIMES` chain. The list element
  // itself is unused on the GPU side — we only need its length
  // to satisfy condition (b) of the D2 axis analysis (formula must
  // reference a non-scalar `@bind`).
  const writeAabbTmp0 = dataReplaceItemOfList(
    'aabb_tmp0',
    oneLit,
    aabbWReadForTmp0.id,
    'outerRepeat',
  );
  allBlocks[writeAabbTmp0.id] = writeAabbTmp0.block;

  // §Avoid blockToXML recursion — these `data_itemoflist` INDEX slots
  // must reference a block whose own `next` chain doesn't loop back
  // through `setIdx0` (the consumer). Use a dedicated
  // `data_variableof aabb_idx0` reader instead of reusing
  // `changeAabbIdx0`.
  const aabbIdx0ForMinx = dataReadVar('aabb_idx0', 'outerRepeat');
  allBlocks[aabbIdx0ForMinx.id] = aabbIdx0ForMinx.block;
  const aabbMinxRead = dataItemOfList('aabb_minx', aabbIdx0ForMinx.id, 'outerRepeat');
  allBlocks[aabbMinxRead.id] = aabbMinxRead.block;
  const aabbIdx0ForMiny = dataReadVar('aabb_idx0', 'outerRepeat');
  allBlocks[aabbIdx0ForMiny.id] = aabbIdx0ForMiny.block;
  const aabbMinyRead = dataItemOfList('aabb_miny', aabbIdx0ForMiny.id, 'outerRepeat');
  allBlocks[aabbMinyRead.id] = aabbMinyRead.block;
  const screenWRead = dataReadVar('screen_w', 'outerRepeat');
  allBlocks[screenWRead.id] = screenWRead.block;
  const screenWProduct = operatorMultiply(screenWRead.id, aabbMinyRead.id, 'outerRepeat');
  allBlocks[screenWProduct.id] = screenWProduct.block;
  const idx0Sum = operatorAdd(aabbMinxRead.id, screenWProduct.id, 'outerRepeat');
  allBlocks[idx0Sum.id] = idx0Sum.block;
  const setIdx0 = dataSetVarTo('idx0', idx0Sum.id, 'outerRepeat');
  allBlocks[setIdx0.id] = setIdx0.block;

  const aabbLenLength = dataLengthOfList('aabb_len', null);
  allBlocks[aabbLenLength.id] = aabbLenLength.block;
  const outerRepeat = repeatBlock(aabbLenLength.id, changeAabbIdx0.id, null);
  // Outer body chain: changeAabbIdx0 -> writeAabbTmp0 -> setIdx0 -> kernelContainer
  changeAabbIdx0.block.next = writeAabbTmp0.id;
  writeAabbTmp0.block.next = setIdx0.id;
  setIdx0.block.next = kernelContainer.id;
  allBlocks[outerRepeat.id] = outerRepeat.block;

  // ===== pow2 reduction = e ^ (ln(2) * v) — built from operator_mathop chain
  // These blocks live in the prototype body (outside any substack).
  const argVReporter = argumentReporterString('v', null);
  allBlocks[argVReporter.id] = argVReporter.block;
  const twoLit = mathNumber(2, null);
  allBlocks[twoLit.id] = twoLit.block;
  const lnOp = mathopBlock('ln', twoLit.id, null);
  allBlocks[lnOp.id] = lnOp.block;
  const product = operatorMultiply(lnOp.id, argVReporter.id, null);
  allBlocks[product.id] = product.block;
  const expOp = mathopBlock('e ^', product.id, null);
  allBlocks[expOp.id] = expOp.block;

  // set tmp0 = e ^ (ln(2) * v)
  const setTmp0 = dataSetVarTo('tmp0', expOp.id, null);
  allBlocks[setTmp0.id] = setTmp0.block;

  // set aabb_idx0 = 0
  const zeroLit = mathNumber(0, null);
  allBlocks[zeroLit.id] = zeroLit.block;
  const setAabbIdx0 = dataSetVarTo('aabb_idx0', zeroLit.id, null);
  allBlocks[setAabbIdx0.id] = setAabbIdx0.block;

  // Prototype body chain: setTmp0 -> setAabbIdx0 -> outerRepeat
  setTmp0.block.next = setAabbIdx0.id;
  setAabbIdx0.block.next = outerRepeat.id;

  // Placeholder for the deferred parent-id references used above
  // (`'innerRepeat'`, `'kernelContainer'`, `'outerRepeat'`). The
  // builders wrote the `parent` string verbatim into `block.parent`;
  // resolve them now that every block id is final so scratch-vm's
  // tree walker has the correct parent pointers.
  for (const block of Object.values(allBlocks)) {
    if (block.parent === 'innerRepeat') block.parent = innerRepeat.id;
    else if (block.parent === 'kernelContainer') block.parent = kernelContainer.id;
    else if (block.parent === 'outerRepeat') block.parent = outerRepeat.id;
  }

  // ===== Custom-block hat (procedures_definition) — pairs the prototype with
  // a hat so the vendored scratch-vm loader registers the custom block by
  // proccode.
  const prototype = proceduresPrototype('fn_expo %s', ['v'], setTmp0.id);
  allBlocks[prototype.id] = prototype.block;
  const definition = proceduresDefinition(prototype.id);
  allBlocks[definition.id] = definition.block;

  // ===== when_flag_clicked hat with one procedures_call site =====
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;
  const arg0 = mathNumber(0);
  allBlocks[arg0.id] = arg0.block;
  const call = procedureCall('fn_expo %s', [arg0.id], hat.id);
  hat.block.next = call.id;
  allBlocks[call.id] = call.block;

  // ===== Comments =====
  // §Phase 4 (Form A): the `@compute` marker sits on the kernel
  // container (`repeat(aabb_h[aabb_idx0])`) — the control_repeat itself.
  const comments = {
    cmt_compute: {
      blockId: kernelContainer.id,
      x: 200,
      y: 320,
      width: 360,
      height: 220,
      minimized: false,
      text: COMPUTE_COMMENT_TEXT,
    },
  };

  // ===== Stage / Sprite targets =====
  // §SB3 format — lists belong under `target.lists` as `[name, value[]]`.
  // The scratch-parser schema rejects any other shape (see AGENTS.md §SB3
  // 形状規約). Buffers hold `aabb_w * aabb_h = 480 * 200 = 96000`
  // entries (= full per-pixel scratch buffer for one AABB at the
  // user's `aabb_w = [480]` / `aabb_h = [200]` sizing).
  const stageLists = {
    list_aabb_len: ['aabb_len', [1]],
    list_aabb_w: ['aabb_w', [480]],
    list_aabb_h: ['aabb_h', [200]],
    list_aabb_minx: ['aabb_minx', [0]],
    list_aabb_miny: ['aabb_miny', [0]],
    // §Scratch design — `aabb_tmp0` is a length-1 list whose
    // element carries the per-AABB count (= aabb_w[aabb_idx0]).
    // The DSL formula `len(aabb_tmp0)` evaluates to 1, but the
    // kernel dispatch goes through the runtime adapter which
    // reads the actual count via `runtime.readScalar`. See the
    // discussion in the COMPUTE_COMMENT_TEXT block above for why
    // the binding is non-scalar.
    list_aabb_tmp0: ['aabb_tmp0', [480]],
    list_buff_r: ['buff_r', new Array(96000).fill(50)],
    list_buff_g: ['buff_g', new Array(96000).fill(50)],
    list_buff_b: ['buff_b', new Array(96000).fill(50)],
  };
  const stageVars = {
    tmp0: ['tmp0', 0],
    tmp1: ['tmp1', 0],
    ln: ['ln', 0],
    aabb_idx0: ['aabb_idx0', 0],
    aabb_tmp0: ['aabb_tmp0', 0],
    screen_w: ['screen_w', 480],
    idx0: ['idx0', 0],
    idx1: ['idx1', 0],
  };

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: stageVars,
    lists: stageLists,
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
    name: 'ExpoCustomBlock',
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
      agent: 'turbowasm-gpu-kernel-expo-custom-block-demo',
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
  console.log(`[expo-custom-block-fixture] wrote ${out} (${buf.length} bytes)`);
}

export async function makeExpoCustomBlockFixture() {
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
  makeExpoCustomBlockFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[expo-custom-block-fixture] FAILED:', err);
    process.exit(1);
  });
}