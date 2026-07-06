#!/usr/bin/env node
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test-fixtures');

function md5hex(buf) {
  return createHash('md5').update(buf).digest('hex');
}

function svgCostume(svg) {
  const assetId = md5hex(Buffer.from(svg, 'utf8'));
  return {
    name: 'costume',
    dataFormat: 'svg',
    assetId,
    md5ext: `${assetId}.svg`,
    rotationCenterX: 0,
    rotationCenterY: 0,
    svg,
  };
}

// SB3 input relationship constants. See vendored/scratch-vm/src/serialization/sb3.js
// INPUT_SAME_BLOCK_SHADOW = 1: a single block (no obscuring block, only a shadow)
// INPUT_BLOCK_NO_SHADOW = 2: a real block with no shadow
// INPUT_DIFF_BLOCK_SHADOW = 3: an obscuring block AND a separate shadow
const INPUT_SAME_BLOCK_SHADOW = 1;
const INPUT_BLOCK_NO_SHADOW = 2;

// SB3 primitive type constants. See vendored/scratch-vm/src/serialization/sb3.js
// When the shadow of an input is a primitive (math_number, colour_picker, ...),
// it can be inlined into the input array as [PRIMITIVE, value, ...].
const MATH_NUM_PRIMITIVE = 4;
const COLOR_PICKER_PRIMITIVE = 9;

let nextId = 1;
const nextBlockId = () => `b${nextId++}`;
const nextShadowId = () => `s${nextId++}`;
const resetBlockCounter = () => {
  nextId = 1;
};

function makeBlock({ opcode, inputs = {}, fields = {}, next = null, parent = null, topLevel = false, shadow = false, x = 0, y = 0 }) {
  const id = shadow ? nextShadowId() : nextBlockId();
  return { id, block: { opcode, inputs, fields, next, parent, topLevel, shadow, x, y } };
}

// Inline-primitive input: stores the value directly in the input array so that
// scratch-vm's deserializer hydrates it without requiring a separate shadow
// block entry in `blocks`. Format: [INPUT_SAME_BLOCK_SHADOW, [PRIMITIVE, value]].
function inlinePrimitiveInput(value, primitive = MATH_NUM_PRIMITIVE) {
  return [INPUT_SAME_BLOCK_SHADOW, [primitive, String(value)]];
}

// Block-reference shadow input: stores the shadow block id and emits a
// separate shadow block entry. Format: [INPUT_SAME_BLOCK_SHADOW, shadowBlockId].
// Use this when the shadow is a non-primitive menu block (e.g. sensing_touchingobjectmenu).
function menuShadowInput(shadowBlockId) {
  return [INPUT_SAME_BLOCK_SHADOW, shadowBlockId];
}

// Empty-block input (no shadow): [INPUT_BLOCK_NO_SHADOW, blockId].
function blockInput(blockId) {
  return [INPUT_BLOCK_NO_SHADOW, blockId];
}

function touchingObjectBlock(parentId, spriteName) {
  const id = nextBlockId();
  const shadowId = nextShadowId();
  const block = {
    opcode: 'sensing_touchingobject',
    inputs: { TOUCHINGOBJECTMENU: menuShadowInput(shadowId) },
    fields: {},
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  const shadow = {
    id: shadowId,
    block: {
      opcode: 'sensing_touchingobjectmenu',
      inputs: {},
      fields: { TOUCHINGOBJECTMENU: [spriteName, null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
    },
  };
  return { id, block, shadow };
}

function sensingOfColorBlock(parentId, color) {
  const id = nextBlockId();
  const block = {
    opcode: 'sensing_touchingcolor',
    inputs: { COLOR: [INPUT_SAME_BLOCK_SHADOW, [COLOR_PICKER_PRIMITIVE, color]] },
    fields: {},
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  return { id, block };
}

function changeVarBlock(varName, parentId, delta) {
  const id = nextBlockId();
  const shadowId = nextShadowId();
  const block = {
    opcode: 'data_changevariableby',
    inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(delta)]] },
    fields: { VARIABLE: [varName, null] },
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  const shadow = {
    id: shadowId,
    block: {
      opcode: 'data_variable',
      inputs: {},
      fields: { VARIABLE: [varName, null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
    },
  };
  return { id, block, shadow };
}

function setVarBlock(varName, parentId, value) {
  const id = nextBlockId();
  const block = {
    opcode: 'data_setvariableto',
    inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]] },
    fields: { VARIABLE: [varName, null] },
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  return { id, block };
}

function pointTowardsBlock(target, parentId) {
  const id = nextBlockId();
  const shadowId = nextShadowId();
  const block = {
    opcode: 'motion_pointtowards',
    inputs: { TOWARDS: menuShadowInput(shadowId) },
    fields: {},
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  const shadow = {
    id: shadowId,
    block: {
      opcode: 'motion_pointtowards_menu',
      inputs: {},
      fields: { TOWARDS: [target, null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
    },
  };
  return { id, block, shadow };
}

function moveStepsBlock(steps, parentId) {
  const id = nextBlockId();
  const block = {
    opcode: 'motion_movesteps',
    inputs: { STEPS: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(steps)]] },
    fields: {},
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  return { id, block };
}

function gotoXYBlock(x, y, parentId) {
  const id = nextBlockId();
  const block = {
    opcode: 'motion_gotoxy',
    inputs: {
      X: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(x)]],
      Y: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(y)]],
    },
    fields: {},
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  return { id, block };
}

function setSizeBlock(size, parentId) {
  const id = nextBlockId();
  const block = {
    opcode: 'motion_setsize',
    inputs: { SIZE: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(size)]] },
    fields: {},
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  return { id, block };
}

function setEffectBlock(effect, value, parentId) {
  const id = nextBlockId();
  const block = {
    opcode: 'looks_seteffectto',
    inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]] },
    fields: { EFFECT: [effect, null] },
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  return { id, block };
}

function switchCostumeBlock(name, parentId) {
  const id = nextBlockId();
  const shadowId = nextShadowId();
  const block = {
    opcode: 'looks_switchcostumeto',
    inputs: { COSTUME: menuShadowInput(shadowId) },
    fields: {},
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  const shadow = {
    id: shadowId,
    block: {
      opcode: 'looks_costume',
      inputs: {},
      fields: { COSTUME: [name, null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
    },
  };
  return { id, block, shadow };
}

function repeatBlock(count, parentId) {
  const id = nextBlockId();
  const block = {
    opcode: 'control_repeat',
    inputs: {
      TIMES: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(count)]],
      SUBSTACK: blockInput('placeholder'),
    },
    fields: {},
    next: null,
    parent: parentId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    id,
  };
  return { id, block };
}

function setSubstack(parentBlock, firstChildId) {
  parentBlock.inputs.SUBSTACK = blockInput(firstChildId);
}

function collectAll(builderOutputs) {
  const all = {};
  const ingest = (item) => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const x of item) ingest(x);
      return;
    }
    if (item.block || item.shadow || item.shadows) {
      if (item.id && item.block) all[item.id] = item.block;
      if (item.shadow && item.shadow.id) all[item.shadow.id] = item.shadow.block;
      if (item.shadows) {
        for (const s of item.shadows) {
          if (s && s.id) all[s.id] = s.block;
        }
      }
      return;
    }
    if (item.id && (item.opcode || item.mutation !== undefined)) {
      all[item.id] = item;
    }
  };
  for (const out of builderOutputs) ingest(out);
  return all;
}

function addBlocks(allBlocks, more) {
  Object.assign(allBlocks, collectAll(more));
}

export function buildBenchTouching() {
  resetBlockCounter();

  const circleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" width="100" height="100"><circle cx="0" cy="0" r="40" fill="#3366cc"/></svg>`;
  const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 200 200" width="200" height="200"><rect x="-80" y="-80" width="160" height="160" fill="#cc3333"/></svg>`;

  const stageCostume = svgCostume('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-240 -180 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>');
  const actorCostume = svgCostume(circleSvg);
  const otherCostume = svgCostume(bigSvg);

  const stageVars = {
    counter: ['counter', 0],
    actor_hits: ['actor_hits', 0],
    other_hits: ['other_hits', 0],
  };

  const allBlocks = {};

  // ========== Stage: when flag clicked, reset variables ==========
  const stageFlag = makeBlock({ opcode: 'event_whenflagclicked', topLevel: true, x: 100, y: 100 });
  const stageReset1 = setVarBlock('counter', stageFlag.id, 0);
  const stageReset2 = setVarBlock('actor_hits', stageReset1.id, 0);
  const stageReset3 = setVarBlock('other_hits', stageReset2.id, 0);
  stageFlag.block.next = stageReset1.id;
  stageReset1.block.next = stageReset2.id;
  stageReset2.block.next = stageReset3.id;
  addBlocks(allBlocks, [stageFlag, stageReset1, stageReset2, stageReset3]);

  // ========== Other sprite (positioned at center) ==========
  const otherFlag = makeBlock({ opcode: 'event_whenflagclicked', topLevel: true, x: 100, y: 100 });
  const otherGoto = gotoXYBlock(0, 0, otherFlag.id);
  otherFlag.block.next = otherGoto.block.id;

  const otherForever = makeBlock({ opcode: 'control_forever', parent: otherGoto.block.id, x: 0, y: 0 });
  otherGoto.block.next = otherForever.id;

  const otherIf = makeBlock({ opcode: 'control_if', parent: otherForever.id, x: 0, y: 0 });
  setSubstack(otherForever.block, otherIf.id);

  const otherTouchEdge = touchingObjectBlock(otherIf.id, '_edge_');
  const otherChangeY = changeVarBlock('other_hits', otherIf.id, 1);
  otherChangeY.block.next = null;

  otherIf.block.inputs = {
    CONDITION: blockInput(otherTouchEdge.block.id),
    SUBSTACK: blockInput(otherChangeY.block.id),
  };
  otherForever.block.x = 200;

  addBlocks(allBlocks, [otherFlag, otherGoto, otherForever, otherIf, otherTouchEdge, otherChangeY]);

  // ========== Actor sprite (original) ==========
  const actorFlag = makeBlock({ opcode: 'event_whenflagclicked', topLevel: true, x: 100, y: 100 });
  const actorGoto = gotoXYBlock(-200, 0, actorFlag.id);
  actorFlag.block.next = actorGoto.block.id;

  // control_create_clone_of uses an INPUT (menu shadow) for CLONE_OPTION,
  // not a field. The menu shadow is the built-in control_create_clone_of_menu.
  const cloneMenuShadowId = nextShadowId();
  const actorCreateClones = makeBlock({
    opcode: 'control_create_clone_of',
    parent: actorGoto.block.id,
  });
  actorCreateClones.block.inputs = { CLONE_OPTION: menuShadowInput(cloneMenuShadowId) };
  actorCreateClones.shadow = {
    id: cloneMenuShadowId,
    block: {
      opcode: 'control_create_clone_of_menu',
      inputs: {},
      fields: { CLONE_OPTION: ['_myself_', null] },
      next: null,
      parent: actorCreateClones.id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
    },
  };
  actorGoto.block.next = actorCreateClones.id;

  const actorForever = makeBlock({ opcode: 'control_forever', parent: actorCreateClones.id, x: 0, y: 0 });
  actorCreateClones.block.next = actorForever.id;

  const pointMouse = pointTowardsBlock('_mouse_', actorForever.id);
  const move1 = moveStepsBlock(1, actorForever.id);
  pointMouse.block.next = move1.block.id;

  const actorIf = makeBlock({ opcode: 'control_if', parent: move1.block.id, x: 0, y: 0 });
  move1.block.next = actorIf.id;
  const actorTouch = touchingObjectBlock(actorIf.id, 'Other');
  const actorChange = changeVarBlock('actor_hits', actorIf.id, 1);
  actorChange.block.next = null;

  actorIf.block.inputs = {
    CONDITION: blockInput(actorTouch.block.id),
    SUBSTACK: blockInput(actorChange.block.id),
  };
  setSubstack(actorForever.block, pointMouse.block.id);

  actorForever.block.x = 300;

  addBlocks(allBlocks, [actorFlag, actorGoto, actorCreateClones, actorForever, pointMouse, move1, actorIf, actorTouch, actorChange]);

  // ========== Actor sprite: when I start as a clone ==========
  // NOTE: the official opcode is `control_start_as_clone` (snake_case under
  // the `control` namespace), not `event_whenstartedasclone`. Using the
  // wrong one makes scratch-vm drop the hat entirely, leaving the clone
  // without a startup script.
  const cloneStart = makeBlock({ opcode: 'control_start_as_clone', topLevel: true, x: 100, y: 700 });
  const cloneGoto = gotoXYBlock(0, 0, cloneStart.id);
  cloneStart.block.next = cloneGoto.block.id;

  const cloneForever = makeBlock({ opcode: 'control_forever', parent: cloneGoto.block.id, x: 0, y: 0 });
  cloneGoto.block.next = cloneForever.id;
  const clonePointMouse = pointTowardsBlock('_mouse_', cloneForever.id);
  const cloneMove = moveStepsBlock(2, cloneForever.id);
  clonePointMouse.block.next = cloneMove.block.id;
  const cloneIf = makeBlock({ opcode: 'control_if', parent: cloneMove.block.id, x: 0, y: 0 });
  cloneMove.block.next = cloneIf.id;
  const cloneTouch = touchingObjectBlock(cloneIf.id, 'Other');
  const cloneChange = changeVarBlock('counter', cloneIf.id, 1);
  cloneChange.block.next = null;

  cloneIf.block.inputs = {
    CONDITION: blockInput(cloneTouch.block.id),
    SUBSTACK: blockInput(cloneChange.block.id),
  };
  setSubstack(cloneForever.block, clonePointMouse.block.id);

  addBlocks(allBlocks, [cloneStart, cloneGoto, cloneForever, clonePointMouse, cloneMove, cloneIf, cloneTouch, cloneChange]);

  // Stage target only contains the Stage-specific blocks (the variable
  // resets). Sprite blocks live in their own target's `blocks` table.
  const stageBlocks = collectAll([
    stageFlag, stageReset1, stageReset2, stageReset3,
  ]);

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: stageVars,
    lists: {},
    broadcasts: {},
    blocks: stageBlocks,
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

  // Actors and Other sprite are stored on their own target entries with
  // their own blocks table, mirroring the Scratch multi-target layout.
  const otherSpriteBlocks = collectAll([otherFlag, otherGoto, otherForever, otherIf, otherTouchEdge, otherChangeY]);
  const otherSprite = {
    isStage: false,
    name: 'Other',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: otherSpriteBlocks,
    comments: {},
    currentCostume: 0,
    costumes: [otherCostume],
    sounds: [],
    volume: 100,
    layerOrder: 1,
    visible: true,
    x: 0,
    y: 0,
    size: 200,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around',
    isOriginalSprite: true,
  };

  const actorSpriteBlocks = collectAll([
    actorFlag, actorGoto, actorCreateClones, actorForever,
    pointMouse, move1, actorIf, actorTouch, actorChange,
    cloneStart, cloneGoto, cloneForever, clonePointMouse, cloneMove, cloneIf, cloneTouch, cloneChange,
  ]);
  const actorSprite = {
    isStage: false,
    name: 'Actor',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: actorSpriteBlocks,
    comments: {},
    currentCostume: 0,
    costumes: [actorCostume],
    sounds: [],
    volume: 100,
    layerOrder: 2,
    visible: true,
    x: -200,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around',
    isOriginalSprite: true,
  };

  return {
    targets: [stageTarget, otherSprite, actorSprite],
    monitors: [
      {
        id: 'monitor_counter',
        mode: 'default',
        opcode: 'data_variable',
        params: { VARIABLE: 'counter' },
        spriteName: null,
        x: 5,
        y: 5,
        width: 120,
        height: 30,
        visible: true,
      },
      {
        id: 'monitor_actor_hits',
        mode: 'default',
        opcode: 'data_variable',
        params: { VARIABLE: 'actor_hits' },
        spriteName: null,
        x: 5,
        y: 40,
        width: 120,
        height: 30,
        visible: true,
      },
      {
        id: 'monitor_other_hits',
        mode: 'default',
        opcode: 'data_variable',
        params: { VARIABLE: 'other_hits' },
        spriteName: null,
        x: 5,
        y: 75,
        width: 120,
        height: 30,
        visible: true,
      },
    ],
    extensions: [],
    extensionURLs: {},
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'tw-bench-gen', platform: { name: 'TurboWasm Viewer' } },
  };
}

async function writeProject(projectJson, assetFiles, outPath) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(projectJson));
  for (const [name, content] of Object.entries(assetFiles)) {
    zip.file(name, content);
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(outPath, buf);
  console.log(`[bench] wrote ${outPath} (${buf.length} bytes)`);
}

async function main() {
  const project = buildBenchTouching();
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
  await writeProject(project, svgAssets, resolve(outDir, 'bench-touching.sb3'));
}

main().catch((err) => {
  console.error('[bench] FAILED:', err);
  process.exit(1);
});