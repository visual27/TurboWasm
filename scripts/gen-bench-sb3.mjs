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

let nextId = 1;
const nextBlockId = () => `b${nextId++}`;
const resetBlockCounter = () => {
  nextId = 1;
};

function makeBlock({ opcode, inputs = {}, fields = {}, next = null, parent = null, topLevel = false, shadow = false, x = 0, y = 0 }) {
  const id = shadow ? `s${nextId++}` : nextBlockId();
  return { id, block: { opcode, inputs, fields, next, parent, topLevel, shadow, x, y } };
}

function literalNum(value, parentId, inputName) {
  const id = `s${nextId++}`;
  return {
    id,
    block: {
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: [String(value), null] },
      next: null,
      parent: parentId,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
    ref: [1, [id]],
  };
}

function literalText(value, parentId) {
  const id = `s${nextId++}`;
  return {
    id,
    block: {
      opcode: 'text',
      inputs: {},
      fields: { TEXT: [value, null] },
      next: null,
      parent: parentId,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
    ref: [1, [id]],
  };
}

function blockRef(blockId) {
  return [1, blockId];
}

function shadowInput(name, value, parentId) {
  return { [name]: [1, [`s${nextId++}`]] };
}

function buildBlocks(builders) {
  const all = {};
  const topLevel = [];
  for (const b of builders) {
    const { id, block } = b;
    all[id] = block;
    if (block.topLevel) topLevel.push(id);
  }
  return { all, topLevel };
}

function chain(...builders) {
  let prevId = null;
  for (let i = 0; i < builders.length; i += 1) {
    const b = builders[i];
    if (prevId) {
      b.block.parent = prevId;
      const prev = builders[i - 1];
      if (prev) prev.block.next = b.id;
    }
  }
  return builders;
}

function makeSprite(name, blocks, costumes, opts = {}) {
  return {
    isStage: false,
    name,
    variables: opts.variables ?? {},
    lists: {},
    broadcasts: {},
    blocks: blocks.all,
    comments: {},
    currentCostume: 0,
    costumes,
    sounds: [],
    volume: 100,
    layerOrder: opts.layerOrder ?? 1,
    visible: opts.visible ?? true,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    size: opts.size ?? 100,
    direction: opts.direction ?? 90,
    draggable: opts.draggable ?? false,
    rotationStyle: opts.rotationStyle ?? 'all around',
    isOriginalSprite: opts.isOriginalSprite ?? true,
  };
}

function touchingObjectBlock(parentId, spriteName) {
  const id = nextBlockId();
  const inputId = `s${nextId++}`;
  const block = {
    opcode: 'sensing_touchingobject',
    inputs: { TOUCHINGOBJECTMENU: [3, spriteName, inputId] },
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
    id: inputId,
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
  const inputId = `s${nextId++}`;
  const block = {
    opcode: 'sensing_touchingcolor',
    inputs: { COLOR: [3, color, inputId] },
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
    id: inputId,
    block: {
      opcode: 'colour_picker',
      inputs: {},
      fields: { COLOUR: [color, null] },
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

function changeVarBlock(varName, parentId, delta) {
  const id = nextBlockId();
  const inputId = `s${nextId++}`;
  const shadowId = `s${nextId++}`;
  const block = {
    opcode: 'data_changevariableby',
    inputs: { VALUE: [3, String(delta), shadowId] },
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
    id: inputId,
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

function pointTowardsBlock(target, parentId) {
  const id = nextBlockId();
  const inputId = `s${nextId++}`;
  const block = {
    opcode: 'motion_pointtowards',
    inputs: { TOWARDS: [3, target, inputId] },
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
    id: inputId,
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
  const shadowId = `s${nextId++}`;
  const block = {
    opcode: 'motion_movesteps',
    inputs: { STEPS: [3, String(steps), shadowId] },
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
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: [String(steps), null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  return { id, block, shadow };
}

function gotoXYBlock(x, y, parentId) {
  const id = nextBlockId();
  const shadowX = `s${nextId++}`;
  const shadowY = `s${nextId++}`;
  const block = {
    opcode: 'motion_gotoxy',
    inputs: {
      X: [3, String(x), shadowX],
      Y: [3, String(y), shadowY],
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
  const shadow1 = {
    id: shadowX,
    block: {
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: [String(x), null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  const shadow2 = {
    id: shadowY,
    block: {
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: [String(y), null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  return { id, block, shadows: [shadow1, shadow2] };
}

function setSizeBlock(size, parentId) {
  const id = nextBlockId();
  const shadowId = `s${nextId++}`;
  const block = {
    opcode: 'motion_setsize',
    inputs: { SIZE: [3, String(size), shadowId] },
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
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: [String(size), null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  return { id, block, shadow };
}

function setEffectBlock(effect, value, parentId) {
  const id = nextBlockId();
  const shadowId = `s${nextId++}`;
  const block = {
    opcode: 'looks_seteffectto',
    inputs: { VALUE: [3, String(value), shadowId] },
    fields: { EFFECT: [effect, null] },
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
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: [String(value), null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  return { id, block, shadow };
}

function switchCostumeBlock(name, parentId) {
  const id = nextBlockId();
  const inputId = `s${nextId++}`;
  const block = {
    opcode: 'looks_switchcostumeto',
    inputs: { COSTUME: [3, name, inputId] },
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
    id: inputId,
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
  const shadowId = `s${nextId++}`;
  const block = {
    opcode: 'control_repeat',
    inputs: {
      TIMES: [3, String(count), shadowId],
      SUBSTACK: [2, 'placeholder'],
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
  const shadow = {
    id: shadowId,
    block: {
      opcode: 'math_integer',
      inputs: {},
      fields: { NUM: [String(count), null] },
      next: null,
      parent: id,
      topLevel: false,
      shadow: true,
      x: 0,
      y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  return { id, block, shadow };
}

function setSubstack(parentBlock, firstChildId) {
  parentBlock.inputs.SUBSTACK = [2, firstChildId];
}

function setSubstack2(parentBlock, firstChildId) {
  parentBlock.inputs.SUBSTACK2 = [2, firstChildId];
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
  const stageReset1 = makeBlock({ opcode: 'data_setvariableto', inputs: {}, fields: { VARIABLE: ['counter', null] }, parent: stageFlag.id, x: 0, y: 0 });
  const stageReset1Shadow = {
    id: `s${nextId++}`,
    block: {
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: ['0', null] },
      next: null,
      parent: stageReset1.id,
      topLevel: false,
      shadow: true,
      x: 0, y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  const stageReset2 = makeBlock({ opcode: 'data_setvariableto', inputs: {}, fields: { VARIABLE: ['actor_hits', null] }, parent: stageReset1.id, x: 0, y: 0 });
  const stageReset2Shadow = {
    id: `s${nextId++}`,
    block: {
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: ['0', null] },
      next: null,
      parent: stageReset2.id,
      topLevel: false,
      shadow: true,
      x: 0, y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  const stageReset3 = makeBlock({ opcode: 'data_setvariableto', inputs: {}, fields: { VARIABLE: ['other_hits', null] }, parent: stageReset2.id, x: 0, y: 0 });
  const stageReset3Shadow = {
    id: `s${nextId++}`,
    block: {
      opcode: 'math_number',
      inputs: {},
      fields: { NUM: ['0', null] },
      next: null,
      parent: stageReset3.id,
      topLevel: false,
      shadow: true,
      x: 0, y: 0,
      mutation: { tagName: 'mutation', children: [] },
    },
  };
  stageFlag.block.next = stageReset1.id;
  stageReset1.block.next = stageReset2.id;
  stageReset2.block.next = stageReset3.id;
  addBlocks(allBlocks, [stageFlag, stageReset1, stageReset2, stageReset3, stageReset1Shadow, stageReset2Shadow, stageReset3Shadow]);

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
    CONDITION: [2, otherTouchEdge.block.id, otherTouchEdge.shadow.id],
    SUBSTACK: [2, otherChangeY.block.id],
  };
  otherForever.block.x = 200;

  addBlocks(allBlocks, [otherFlag, otherGoto, otherGoto.shadows[0], otherGoto.shadows[1], otherForever, otherIf, otherTouchEdge, otherChangeY]);

  // ========== Actor sprite (original) ==========
  const actorFlag = makeBlock({ opcode: 'event_whenflagclicked', topLevel: true, x: 100, y: 100 });
  const actorGoto = gotoXYBlock(-200, 0, actorFlag.id);
  actorFlag.block.next = actorGoto.block.id;

  const actorCreateClones = makeBlock({ opcode: 'control_create_clone_of', inputs: {}, fields: { CLONE_OPTION: ['_myself_', null] }, parent: actorGoto.block.id, x: 0, y: 0 });
  actorGoto.block.next = actorCreateClones.id;

  const actorForever = makeBlock({ opcode: 'control_forever', parent: actorCreateClones.id, x: 0, y: 0 });
  actorCreateClones.block.next = actorForever.id;

  const pointMouse = pointTowardsBlock('_mouse_', actorForever.id);
  const move1 = moveStepsBlock(1, actorForever.id);
  pointMouse.block.next = move1.block.id;

  const actorIf = makeBlock({ opcode: 'control_if', parent: move1.block.id, x: 0, y: 0 });
  const actorTouch = touchingObjectBlock(actorIf.id, 'Other');
  const actorChange = changeVarBlock('actor_hits', actorIf.id, 1);
  actorChange.block.next = null;

  actorIf.block.inputs = {
    CONDITION: [2, actorTouch.block.id, actorTouch.shadow.id],
    SUBSTACK: [2, actorChange.block.id],
  };
  setSubstack(actorForever.block, pointMouse.block.id);

  actorForever.block.x = 300;

  addBlocks(allBlocks, [actorFlag, actorGoto, actorGoto.shadows[0], actorGoto.shadows[1], actorCreateClones, actorForever, pointMouse, move1, actorIf, actorTouch, actorChange]);

  // ========== Actor sprite: when I start as a clone ==========
  const cloneStart = makeBlock({ opcode: 'event_whenstartedasclone', topLevel: true, x: 100, y: 700 });
  const cloneGoto = gotoXYBlock(0, 0, cloneStart.id);
  cloneStart.block.next = cloneGoto.block.id;

  const cloneForever = makeBlock({ opcode: 'control_forever', parent: cloneGoto.block.id, x: 0, y: 0 });
  cloneGoto.block.next = cloneForever.id;
  const clonePointMouse = pointTowardsBlock('_mouse_', cloneForever.id);
  const cloneMove = moveStepsBlock(2, cloneForever.id);
  clonePointMouse.block.next = cloneMove.block.id;
  const cloneIf = makeBlock({ opcode: 'control_if', parent: cloneMove.block.id, x: 0, y: 0 });
  const cloneTouch = touchingObjectBlock(cloneIf.id, 'Other');
  const cloneChange = changeVarBlock('counter', cloneIf.id, 1);
  cloneChange.block.next = null;

  cloneIf.block.inputs = {
    CONDITION: [2, cloneTouch.block.id, cloneTouch.shadow.id],
    SUBSTACK: [2, cloneChange.block.id],
  };
  setSubstack(cloneForever.block, clonePointMouse.block.id);

  addBlocks(allBlocks, [cloneStart, cloneGoto, cloneGoto.shadows[0], cloneGoto.shadows[1], cloneForever, clonePointMouse, cloneMove, cloneIf, cloneTouch, cloneChange]);

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: stageVars,
    lists: {},
    broadcasts: {},
    blocks: {
      ...collectAll([stageFlag, stageReset1, stageReset2, stageReset3, stageReset1Shadow, stageReset2Shadow, stageReset3Shadow]),
    },
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

  const otherSprite = makeSprite('Other', { all: collectAll([otherFlag, otherGoto, otherForever, otherIf, otherTouchEdge, otherChangeY]), topLevel: [] }, [otherCostume], { layerOrder: 1, size: 200 });
  const actorSprite = makeSprite('Actor', { all: collectAll([actorFlag, actorGoto, actorCreateClones, actorForever, pointMouse, move1, actorIf, actorTouch, actorChange, cloneStart, cloneGoto, cloneForever, clonePointMouse, cloneMove, cloneIf, cloneTouch, cloneChange]), topLevel: [] }, [actorCostume], { layerOrder: 2 });

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
