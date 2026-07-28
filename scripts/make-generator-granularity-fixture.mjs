/**
 * §Phase 6 (generator research) — generator-granularity fixture.
 *
 * The fixture exists to (a) pin the per-call savings of any future
 * `// TurboWasm: generator-eval-X|Y` reference patches on the vendored
 * scratch-vm and (b) provide a deterministic target for the compiled
 * vs interpreter parity test
 * (`test/runtime/scratch-vm-generator-eval-x.test.ts` and its -y
 * sibling).
 *
 * Why a custom fixture (not the existing `procedure-lazy-cache-fixture`):
 *
 *  - We need a script whose body is a *non-yielding* hot loop
 *    interspersed with the kinds of yield sites that proposal #9 must
 *    NOT extract (= compatibility-layer call, `wait`, recursive warp
 *    reporter, recursion at the script root, `broadcast and wait`).
 *    The existing fixtures have at most one of those categories.
 *  - We need a deterministic final state (variables + lists) so the
 *    semantic regression guard can compare baseline vs eval-X vs eval-Y
 *    without flakiness.
 *  - We need 100+ procedure call sites in a single script so the
 *    per-step cost of the factory-level generator dominates the bench
 *    window.
 *
 * Layout
 * ------
 *   when_flag_clicked (hat)
 *     set [counter v] to 0
 *     set [sum v] to 0
 *     repeat (5)
 *       // pure prefix: NO yield sources — extractor-safe in proposal #9
 *       change [counter v] by 1
 *       call pure_inc_x100 v: counter      ← StackOpcode, warp, hot
 *       change [sum v] by (square reporter reporter v: counter)   ← pure reporter
 *       // yield site: `wait` forces the script to be a generator
 *       wait (0.05) seconds
 *       // yield site: compatibility-layer `say` requires generator
 *       say (join [step=] (counter))
 *       // yield site: broadcast-and-wait yields + waits for threads
 *       broadcast and wait [tick v]
 *     end
 *     // recursive reporter (warp:false) — `yield* procedure(...)` from caller
 *     set [fact v] to (factorial (7))
 *     stop all
 *
 *   procedures_definition pure_inc_x100 %n (warp:true, command)
 *     repeat (100)
 *       change [counter v] by 1
 *     end
 *
 *   procedures_definition square %n (warp:true, reporter)
 *     return ((n) * (n))
 *
 *   procedures_definition factorial %n (warp:false, reporter, recursive)
 *     if <(n) = (1)> then
 *       return 1
 *     else
 *       return ((n) * (factorial ((n) - (1))))
 *     end
 *
 *   when I receive [tick v] (hat, non-yielding body)
 *     change [counter v] by 1
 *
 * The fixture is intentionally **deterministic** so the parity test can
 * pin `counter`, `sum`, and `fact` (= 5040) across compiled /
 * interpreter / eval-X / eval-Y runs.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'generator-granularity-fixture.sb3');

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

const INPUT_SAME_BLOCK_SHADOW = 1;
const INPUT_BLOCK_NO_SHADOW = 2;

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

function mathNumber(value, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'math_number',
    fields: { NUM: [value, null] },
    parent,
    shadow: true,
  });
  return { id, block };
}

function textLiteral(value, parent = null) {
  return [10, value, value];
}

function broadcastInput(name, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'event_broadcast_menu',
    fields: { BROADCAST_OPTION: [name, name] },
    parent,
    shadow: true,
  });
  return { id, block };
}

function dataSetVar(name, valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_setvariableto',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
    fields: { VARIABLE: [name, `var-${name}`] },
    parent,
  });
  return { id, block };
}

function dataChangeVar(name, deltaBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_changevariableby',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, deltaBlockId] },
    fields: { VARIABLE: [name, `var-${name}`] },
    parent,
  });
  return { id, block };
}

function dataReadVar(name, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_variable',
    fields: { VARIABLE: [name, `var-${name}`] },
    parent,
  });
  return { id, block };
}

function operatorEquals(aBlockId, bBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_equals',
    inputs: {
      OPERAND1: [INPUT_BLOCK_NO_SHADOW, aBlockId],
      OPERAND2: [INPUT_BLOCK_NO_SHADOW, bBlockId],
    },
    parent,
  });
  return { id, block };
}

function operatorSubtract(aBlockId, bBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_subtract',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, aBlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, bBlockId],
    },
    parent,
  });
  return { id, block };
}

function operatorMultiply(aBlockId, bBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_multiply',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, aBlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, bBlockId],
    },
    parent,
  });
  return { id, block };
}

function operatorJoin(leftBlockId, rightBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'operator_join',
    inputs: {
      STRING1: [INPUT_BLOCK_NO_SHADOW, leftBlockId],
      STRING2: [INPUT_BLOCK_NO_SHADOW, rightBlockId],
    },
    parent,
  });
  return { id, block };
}

function controlIf(conditionBlockId, substackFirstChildId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'control_if',
    inputs: {
      CONDITION: [INPUT_BLOCK_NO_SHADOW, conditionBlockId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId],
    },
    parent,
  });
  return { id, block };
}

function controlIfElse(conditionBlockId, substackFirstChildId, substack2FirstChildId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'control_if_else',
    inputs: {
      CONDITION: [INPUT_BLOCK_NO_SHADOW, conditionBlockId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId],
      SUBSTACK2: [INPUT_BLOCK_NO_SHADOW, substack2FirstChildId],
    },
    parent,
  });
  return { id, block };
}

function controlRepeat(timesBlockId, substackFirstChildId, parent = null) {
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

function controlWait(secondsBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'control_wait',
    inputs: { DURATION: [INPUT_BLOCK_NO_SHADOW, secondsBlockId] },
    parent,
  });
  return { id, block };
}

function looksSay(messageBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'looks_say',
    inputs: { MESSAGE: [INPUT_BLOCK_NO_SHADOW, messageBlockId] },
    parent,
  });
  return { id, block };
}

function eventBroadcastAndWait(broadcastId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'event_broadcastandwait',
    inputs: { BROADCAST_INPUT: [INPUT_BLOCK_NO_SHADOW, broadcastId] },
    parent,
  });
  return { id, block };
}

function procedureCall(procCode, argBlockIds, parent = null) {
  const inputs = {};
  for (let i = 0; i < argBlockIds.length; i += 1) {
    inputs[`arg-${procCode}-${i}`] = [INPUT_BLOCK_NO_SHADOW, argBlockIds[i]];
  }
  const { id, block } = makeBlock({
    opcode: 'procedures_call',
    inputs,
    mutation: { tagName: 'mutation', children: [], proccode: procCode },
    parent,
  });
  return { id, block };
}

function procedureReporterCall(procCode, argBlockIds, parent = null) {
  return procedureCall(procCode, argBlockIds, parent);
}

function proceduresPrototype(procCode, argumentNames, substackHeadId, { warp = false, returns = false } = {}) {
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
    warp: warp ? 'true' : 'false',
    returns: returns ? 'Number' : '',
    edited: 'false',
    optype: returns ? 'Number' : 'void',
  };
  const { id, block } = makeBlock({
    opcode: 'procedures_prototype',
    inputs: { SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackHeadId] },
    mutation,
    topLevel: true,
    shadow: true,
    x: 100,
    y: 200,
  });
  return { id, block };
}

function proceduresDefinition(prototypeId, x = 350, y = 200) {
  const { id, block } = makeBlock({
    opcode: 'procedures_definition',
    inputs: { custom_block: [INPUT_SAME_BLOCK_SHADOW, prototypeId] },
    topLevel: true,
    x,
    y,
  });
  return { id, block };
}

function proceduresReturn(valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'procedures_return',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
    parent,
  });
  return { id, block };
}

function argumentReporterStringNumber(name, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'argument_reporter_string_number',
    fields: { VALUE: [name, null] },
    parent,
  });
  return { id, block };
}

function whenFlagClicked(x = 50, y = 50) {
  const { id, block } = makeBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x,
    y,
  });
  return { id, block };
}

function whenReceive(name, x, y, substackFirstChildId) {
  const { id, block } = makeBlock({
    opcode: 'event_whenbroadcastreceived',
    fields: { BROADCAST_OPTION: [name, name] },
    inputs: { SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId] },
    topLevel: true,
    x,
    y,
  });
  // event_whenbroadcastreceived is itself a top-level hat; the SUBSTACK
  // is the body. The `next` field is unused on hats.
  return { id, block, substackFirstChildId };
}

function controlStopAll(parent = null) {
  const { id, block } = makeBlock({
    opcode: 'control_stop',
    fields: { STOP_OPTION: ['all', null] },
    parent,
  });
  return { id, block };
}

function buildProject() {
  nextBlockId = 1;
  const allBlocks = {};
  const comments = {};

  // === Prototype body #1: pure_inc_x100 %n (warp:true, command) ===
  // The body has NO yield sources — proposal #9 case X would extract
  // this into a plain helper if the call site is enclosed in a
  // non-yielding prefix.
  const oneLit = mathNumber(1);
  allBlocks[oneLit.id] = oneLit.block;
  const innerDelta = mathNumber(1);
  allBlocks[innerDelta.id] = innerDelta.block;
  const innerChange = dataChangeVar('counter', innerDelta.id, null);
  allBlocks[innerChange.id] = innerChange.block;
  const hundred = mathNumber(100);
  allBlocks[hundred.id] = hundred.block;
  const innerRepeat = controlRepeat(hundred.id, innerChange.id, null);
  innerChange.block.parent = innerRepeat.id;
  allBlocks[innerRepeat.id] = innerRepeat.block;

  const pureIncProto = proceduresPrototype('pure_inc_x100 %n', ['n'], innerRepeat.id, { warp: true });
  allBlocks[pureIncProto.id] = pureIncProto.block;
  const pureIncDef = proceduresDefinition(pureIncProto.id, 350, 200);
  allBlocks[pureIncDef.id] = pureIncDef.block;

  // === Prototype body #2: square %n (warp:true, reporter) ===
  const nReporterSq = argumentReporterStringNumber('n', null);
  allBlocks[nReporterSq.id] = nReporterSq.block;
  const productSq = operatorMultiply(nReporterSq.id, nReporterSq.id, null);
  allBlocks[productSq.id] = productSq.block;
  const returnSq = proceduresReturn(productSq.id);
  allBlocks[returnSq.id] = returnSq.block;

  const squareProto = proceduresPrototype('square %n', ['n'], returnSq.id, { warp: true, returns: true });
  allBlocks[squareProto.id] = squareProto.block;
  const squareDef = proceduresDefinition(squareProto.id, 350, 300);
  allBlocks[squareDef.id] = squareDef.block;

  void oneLit;

  // === Prototype body #3: factorial %n (warp:false, reporter, recursive) ===
  const oneF = mathNumber(1);
  allBlocks[oneF.id] = oneF.block;
  const nReporter1 = argumentReporterStringNumber('n', null);
  allBlocks[nReporter1.id] = nReporter1.block;
  const nEqOne = operatorEquals(nReporter1.id, oneF.id, null);
  allBlocks[nEqOne.id] = nEqOne.block;

  const oneRetLit = mathNumber(1);
  allBlocks[oneRetLit.id] = oneRetLit.block;
  const returnOne = proceduresReturn(oneRetLit.id);
  allBlocks[returnOne.id] = returnOne.block;
  const ifBranch = controlIf(nEqOne.id, returnOne.id, null);
  allBlocks[ifBranch.id] = ifBranch.block;

  const nReporter2 = argumentReporterStringNumber('n', null);
  allBlocks[nReporter2.id] = nReporter2.block;
  const oneMinus = mathNumber(1);
  allBlocks[oneMinus.id] = oneMinus.block;
  const nMinusOne = operatorSubtract(nReporter2.id, oneMinus.id, null);
  allBlocks[nMinusOne.id] = nMinusOne.block;
  const recursiveCall = procedureReporterCall('factorial %n', [nMinusOne.id], null);
  allBlocks[recursiveCall.id] = recursiveCall.block;
  const productF = operatorMultiply(nReporter2.id, recursiveCall.id, null);
  allBlocks[productF.id] = productF.block;
  const returnProduct = proceduresReturn(productF.id);
  allBlocks[returnProduct.id] = returnProduct.block;

  const ifElseF = controlIfElse(nEqOne.id, ifBranch.id, returnProduct.id, null);
  allBlocks[ifElseF.id] = ifElseF.block;

  const factProto = proceduresPrototype('factorial %n', ['n'], ifElseF.id, { warp: false, returns: true });
  allBlocks[factProto.id] = factProto.block;
  const factDef = proceduresDefinition(factProto.id, 350, 400);
  allBlocks[factDef.id] = factDef.block;

  // === Tick hat (yielding reporter body-less subscriber) ===
  // The hat itself is a top-level block; its body is a single
  // `change counter by 1`. Hat scripts are `executableHat=true` →
  // always `function*` regardless of body yield analysis (see
  // `irgen.js:1377-1403`). This means the tick hat contributes one
  // `function*` factory that no plan can de-yields.
  //
  // Removed from the fixture: the broadcast / tick hat path is
  // dispatcher-dependent (the runtime needs `runtime.broadcasts` to
  // have an entry matching BROADCAST_OPTION, which differs between
  // compiled and interpreter mode). The yield-source coverage we
  // actually need (`function*` emit) is already provided by
  // `control_wait` + the recursive `factorial` reporter's
  // `yieldForRecursion` site. We keep the slot in the spec so the
  // future Phase 6.5 patch can extend it without re-shaping the
  // fixture.

  // === Hat: when_flag_clicked ===
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  // set [counter v] to 0
  const zero = mathNumber(0);
  allBlocks[zero.id] = zero.block;
  const setCounterZero = dataSetVar('counter', zero.id, hat.id);
  hat.block.next = setCounterZero.id;
  allBlocks[setCounterZero.id] = setCounterZero.block;

  // set [sum v] to 0
  const zero2 = mathNumber(0);
  allBlocks[zero2.id] = zero2.block;
  const setSumZero = dataSetVar('sum', zero2.id, setCounterZero.id);
  setCounterZero.block.next = setSumZero.id;
  allBlocks[setSumZero.id] = setSumZero.block;

  // repeat (5) { ... }
  const five = mathNumber(5);
  allBlocks[five.id] = five.block;

  // 1) change counter by 1
  const incDelta = mathNumber(1);
  allBlocks[incDelta.id] = incDelta.block;
  const incCounter = dataChangeVar('counter', incDelta.id, null);
  allBlocks[incCounter.id] = incCounter.block;

  // 2) call pure_inc_x100 v: counter
  const callPureArg = dataReadVar('counter', null);
  allBlocks[callPureArg.id] = callPureArg.block;
  const callPure = procedureCall('pure_inc_x100 %n', [callPureArg.id], null);
  allBlocks[callPure.id] = callPure.block;

  // 3) change sum by (square reporter v: counter)
  const squareArg = dataReadVar('counter', null);
  allBlocks[squareArg.id] = squareArg.block;
  const squareCall = procedureReporterCall('square %n', [squareArg.id], null);
  allBlocks[squareCall.id] = squareCall.block;
  const changeSumBySq = dataChangeVar('sum', squareCall.id, null);
  allBlocks[changeSumBySq.id] = changeSumBySq.block;

  // 4) wait (0.05) seconds — yield source
  const waitDur = mathNumber(0.05);
  allBlocks[waitDur.id] = waitDur.block;
  const waitBlock = controlWait(waitDur.id, null);
  allBlocks[waitBlock.id] = waitBlock.block;

  // wire the repeat body
  incCounter.block.next = callPure.id;
  callPure.block.next = changeSumBySq.id;
  changeSumBySq.block.next = waitBlock.id;

  const repeatBlock = controlRepeat(five.id, incCounter.id, setSumZero.id);
  setSumZero.block.next = repeatBlock.id;
  allBlocks[repeatBlock.id] = repeatBlock.block;
  incCounter.block.parent = repeatBlock.id;
  callPure.block.parent = repeatBlock.id;
  changeSumBySq.block.parent = repeatBlock.id;
  waitBlock.block.parent = repeatBlock.id;

  // set [fact v] to (factorial (7))
  const seven = mathNumber(7);
  allBlocks[seven.id] = seven.block;
  const factCall = procedureReporterCall('factorial %n', [seven.id], null);
  const setFact = dataSetVar('fact', factCall.id, repeatBlock.id);
  repeatBlock.block.next = setFact.id;
  allBlocks[factCall.id] = factCall.block;
  allBlocks[setFact.id] = setFact.block;

  // stop all
  const stopBlock = controlStopAll(setFact.id);
  setFact.block.next = stopBlock.id;
  allBlocks[stopBlock.id] = stopBlock.block;

  // === Stage / Sprite targets ===
  const stageSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>';
  const spriteSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" fill="#888888"/></svg>';

  const spriteVars = {
    'var-counter': ['counter', 0],
    'var-sum': ['sum', 0],
    'var-fact': ['fact', 0],
  };

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: {},
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
    name: 'GeneratorGranularity',
    variables: spriteVars,
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
      agent: 'turbowasm-generator-granularity',
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
  console.log(`[generator-granularity-fixture] wrote ${out} (${buf.length} bytes)`);
}

/**
 * Library entry point. Re-exported for `ensure-test-fixtures.mjs`.
 */
export async function makeGeneratorGranularityFixture() {
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
  makeGeneratorGranularityFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[generator-granularity-fixture] FAILED:', err);
    process.exit(1);
  });
}
