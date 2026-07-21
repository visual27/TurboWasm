/**
 * §Phase 5 (gpu-kernel-dsl-phase5-spec §5.6) — generate the custom
 * block fixture: `custom-block-fixture.sb3`.
 *
 * The fixture exercises the `procedure-inliner.ts` end-to-end. One
 * `procedures_prototype` (`fn_apply_expo %s`) defines an `@compute`
 * region inside its body, wired through a `procedures_definition` so
 * the project loads cleanly in pure TurboWarp. The `when_flag_clicked`
 * handler invokes the custom block via `procedures_call
 * fn_apply_expo` three times. After inlining we expect:
 *
 *   - 3 regions adopted by `region-extractor.ts` (one per call site)
 *   - All three share the same canonical key (kernel-registry has 1
 *     compiled entry, kernel-registry has 3 dispatch sites)
 *   - Each region's `inlinedPrototypeBlockIds` includes the prototype
 *     block id
 *
 * Scratch layout
 * --------------
 *   when_flag_clicked (hat)
 *     procedures_call fn_apply_expo arg0=1   ← call site A
 *     procedures_call fn_apply_expo arg0=2   ← call site B
 *     procedures_call fn_apply_expo arg0=3   ← call site C
 *
 *   procedures_definition (custom block hat)
 *     custom_block input -> procedures_prototype fn_apply_expo %s
 *       SUBSTACK -> kernelContainer (control_repeat with @compute comment)
 *         buff_r[R0] = buff_r[R0] * arg_v (via argument_reporter_string_number)
 *
 * Notes
 * -----
 * The fixture intentionally reuses the same prototype for all three
 * call sites so the post-inlining canonical key collapses to one. The
 * `arg_v` argument reporter inside the prototype body gets rewired to
 * the call-site's literal argument block (`arg1` / `arg2` / `arg3`).
 *
 * Scratch parser validates the JSON shape and pure TurboWarp can
 * execute the project end-to-end; the GPU kernel pipeline only cares
 * about the `@compute` marker / directive structure inside the
 * prototype body.
 */

import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'custom-block-fixture.sb3');

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
// `data_listcontents` primitive id (= `[13, name, id]`).
const LIST_PRIMITIVE = 13;

let nextBlockId = 1;
const nextId = () => `b${nextBlockId++}`;

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

function listShadow(listName, listId) {
  return [INPUT_SAME_BLOCK_SHADOW, [LIST_PRIMITIVE, listName, listId]];
}

function listIdFor(name) {
  return `list_${name}`;
}

// --- Comment text (one per call site; identical so canonical keys match) ---

const COMPUTE_COMMENT_TEXT = [
  '@compute',
  '@bind buff_r(1) rw f32',
  '@bind aabb_w(2) ro f32',
  '@workgroup_size(64)',
  '@repeat R0:global_x = len(aabb_w)',
].join('\n');

// --- Block builders ------------------------------------------------------

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

function procedureCall(procCode, argBlockIds, parent = null) {
  const inputs = {};
  for (let i = 0; i < argBlockIds.length; i += 1) {
    inputs[`arg${i}`] = [INPUT_BLOCK_NO_SHADOW, argBlockIds[i]];
  }
  const { id, block } = makeBlock({
    // Official scratch opcode for invoking a custom block. The previous
    // generator emitted `procedure_call` (an in-repo alias) which the
    // vendored scratch-vm loader treats as unknown.
    opcode: 'procedures_call',
    inputs,
    mutation: { proccode: procCode },
    parent,
  });
  return { id, block };
}

function proceduresPrototype(procCode, argumentNames, substackHeadId) {
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
    // SUBSTACK must be an input descriptor (`[shadowKind, blockId]`),
    // not a bare block-id string — the loader silently drops a bare
    // string and the prototype ends up with no executable body.
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
  // Custom-block hat. Required by scratch-vm so the procedures_call sites
  // can resolve the prototype by `proccode`. Without this the project
  // loads but the call sites surface as unknown blocks at runtime.
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
    // Official scratch opcode for an argument value reporter. The
    // argument name lives in `fields.VALUE` (not `fields.VARIABLE`),
    // matching the scratch-vm `argumentReporterStringNumber` handler.
    opcode: 'argument_reporter_string_number',
    fields: { VALUE: [name, null] },
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
  nextBlockId = 1;

  const stageSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>';
  const spriteSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" fill="#888888"/></svg>';

  const allBlocks = {};

  // ===== Prototype body: read R0, multiply buff_r[R0] by `v`, write back =====
  const r0Read = dataReadVar('R0', null);
  allBlocks[r0Read.id] = r0Read.block;

  // `argument_reporter_string` for `v` — the inliner rewires this to
  // the call-site's argument block id.
  const argVReporter = argumentReporterString('v', null);
  allBlocks[argVReporter.id] = argVReporter.block;

  const buffRRead = dataItemOfList('buff_r', r0Read.id, null);
  allBlocks[buffRRead.id] = buffRRead.block;
  const product = operatorMultiply(buffRRead.id, argVReporter.id, null);
  allBlocks[product.id] = product.block;
  const resultSet = dataReplaceItemOfList('buff_r', r0Read.id, product.id, null);
  allBlocks[resultSet.id] = resultSet.block;

  // The kernel container — the control_repeat carrying the @compute
  // comment.
  const aabbWLength = dataLengthOfList('aabb_w', null);
  allBlocks[aabbWLength.id] = aabbWLength.block;
  const kernelContainer = repeatBlock(aabbWLength.id, resultSet.id, null);
  allBlocks[kernelContainer.id] = kernelContainer.block;

  // ===== Prototype declaration =====
  const prototype = proceduresPrototype('fn_apply_expo %s', ['v'], kernelContainer.id);
  allBlocks[prototype.id] = prototype.block;

  // ===== Custom-block hat (procedures_definition) =====
  // Pairs the prototype with a definition so the vendored scratch-vm
  // loader registers the custom block by proccode. Pure TurboWarp
  // executes the prototype body when any of the procedures_call sites
  // below fire; without this hat the callsites surface as unknown
  // blocks at runtime and the project is effectively unrunnable.
  const definition = proceduresDefinition(prototype.id);
  allBlocks[definition.id] = definition.block;

  // ===== Hat with 3 procedures_call sites =====
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  const arg1 = mathNumber(1);
  allBlocks[arg1.id] = arg1.block;
  const arg2 = mathNumber(2);
  allBlocks[arg2.id] = arg2.block;
  const arg3 = mathNumber(3);
  allBlocks[arg3.id] = arg3.block;

  const callA = procedureCall('fn_apply_expo %s', [arg1.id], hat.id);
  hat.block.next = callA.id;
  allBlocks[callA.id] = callA.block;

  const callB = procedureCall('fn_apply_expo %s', [arg2.id], callA.id);
  callA.block.next = callB.id;
  allBlocks[callB.id] = callB.block;

  const callC = procedureCall('fn_apply_expo %s', [arg3.id], callB.id);
  callB.block.next = callC.id;
  allBlocks[callC.id] = callC.block;

  // ===== Comments =====
  // §Phase 4 (Form A): the @compute marker sits on the
  // `kernelContainer` (the prototype body's control_repeat itself).
  // The same comment text is used for every call site so the
  // canonical keys collapse to one.
  const comments = {
    cmt_compute: {
      blockId: kernelContainer.id,
      x: 200,
      y: 300,
      width: 280,
      height: 160,
      minimized: false,
      text: COMPUTE_COMMENT_TEXT,
    },
  };

  // ===== Stage / Sprite targets =====
  // §SB3 format — lists belong under `target.lists` as `[name, value[]]`
  // (the scratch-parser schema rejects the internal-VM object shape).
  const stageLists = {
    list_aabb_w: ['aabb_w', [128]],
    list_buff_r: ['buff_r', [50]],
  };
  const stageVars = {
    R0: ['R0', 0],
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
    name: 'CustomBlock',
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
      agent: 'turbowasm-gpu-kernel-custom-block-demo',
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
  console.log(`[custom-block-fixture] wrote ${out} (${buf.length} bytes)`);
}

/**
 * Library entry point. Re-exported for `ensure-test-fixtures.mjs`.
 */
export async function makeCustomBlockFixture() {
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
  makeCustomBlockFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[custom-block-fixture] FAILED:', err);
    process.exit(1);
  });
}
