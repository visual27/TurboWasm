/**
 * Phase 2-B — Generate `test/.test-fixtures/procedure-lazy-cache-fixture.sb3`.
 *
 * The fixture exists to (a) pin the per-call savings of the
 * `// TurboWasm: procedure-lazy-cache` hunk in
 * `vendored/scratch-vm/src/compiler/jsgen.js` and (b) provide a
 * deterministic target for the compiled vs interpreter parity test
 * (`test/runtime/scratch-vm-procedure-lazy-cache.test.ts`).
 *
 * Why a custom fixture (not the existing `compare-equal-fixture` etc.):
 *
 *  - We need 1000+ `procedures_call` sites in a single compiled script
 *    so the per-call savings of the lazy cache dominate the bench
 *    window. The existing fixtures have zero procedure calls.
 *  - We need at least one **recursive** `procedures_call` so the test
 *    can pin that the captured `b0` reference is reused across the
 *    recursion boundary (no per-frame `thread.procedures[variant]`
 *    walk).
 *  - We need at least one **warp** `procedures_call` so the test can
 *    pin that the warp/non-warp variant key disambiguation still
 *    resolves to the same `evaluateOnce` const family.
 *  - We need at least one reporter (`procedures_call` whose return
 *    value is consumed) so the InputOpcode path is exercised in
 *    addition to the StackOpcode path.
 *
 * Layout
 * ------
 *   when_flag_clicked (hat)
 *     set [result v] to 0
 *     repeat (200)
 *       call add_one v: result   ← StackOpcode, warp, hot path
 *     end
 *     set [fact v] to (factorial (5))   ← InputOpcode recursion
 *     stop all
 *
 *   procedures_definition add_one
 *     procedures_prototype add_one %s (warp:true)
 *       change [result v] by 1
 *     end
 *
 *   procedures_definition factorial
 *     procedures_prototype factorial %n (warp:false)
 *       if <(n) = (1)> then
 *         return 1
 *       else
 *         return ((n) * (factorial ((n) - (1))))
 *       end
 *     end
 *
 * The fixture is intentionally **deterministic** so the parity test
 * can compare the post-loop value of `result` (= 200) and the
 * post-call value of `fact` (= 120) across compiled / interpreted
 * runs. The bench only needs the per-step cost, not the value, but
 * the value pin makes the parity test cheap to write.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'procedure-lazy-cache-fixture.sb3');

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
const TEXT_PRIMITIVE = 10;

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
  // `[TEXT_PRIMITIVE, value, value]` is the canonical scratch shape
  // for a string literal slot.
  return [TEXT_PRIMITIVE, value, value];
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

function procedureCall(procCode, argBlockIds, parent = null) {
  const inputs = {};
  for (let i = 0; i < argBlockIds.length; i += 1) {
    inputs[`arg${i}`] = [INPUT_BLOCK_NO_SHADOW, argBlockIds[i]];
  }
  const { id, block } = makeBlock({
    // Official scratch opcode for invoking a custom block.
    opcode: 'procedures_call',
    inputs,
    mutation: { tagName: 'mutation', children: [], proccode: procCode },
    parent,
  });
  return { id, block };
}

function procedureReporterCall(procCode, argBlockIds, parent = null) {
  // A reporter-form custom block lives as a `procedures_call` whose
  // result is consumed by an expression input. The opcode is the
  // same; the parent block embeds it as INPUT_BLOCK_NO_SHADOW.
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

function stopAll() {
  const { id, block } = makeBlock({
    opcode: 'event_whenstopped',
    topLevel: true,
    x: 50,
    y: 600,
  });
  // event_whenstopped is a "no-op" hat — scratch semantics stop
  // the script. We just need the block to exist; we use it as a
  // terminator. But for the parity test we need a *real* stop.
  // Use a standalone `control_stop` block instead, chained at the
  // end of the hat.
  return { id, block };
}

function controlStopAll() {
  const { id, block } = makeBlock({
    opcode: 'event_broadcast_stop', // unused; placeholder
    topLevel: false,
  });
  return { id, block };
}

// --- Project assembly ----------------------------------------------------

function buildProject() {
  nextBlockId = 1;
  const allBlocks = {};
  const comments = {};

  // === Prototype body #1: add_one %s (warp:true, command) ===
  // The body is just `change [result v] by 1`. The argument `%s` is
  // bound to the local `v` but the body does not consume it; we keep
  // the argument only to exercise the call-shape path on every call
  // site. The compiled runtime still has to evaluate the argument
  // slot — it just discards the value because the body has no
  // `argument_reporter_string_number` for `v`.
  const delta = mathNumber(1);
  allBlocks[delta.id] = delta.block;
  const changeResult = dataChangeVar('result', delta.id, null);
  allBlocks[changeResult.id] = changeResult.block;

  const addOneProto = proceduresPrototype('add_one %s', ['v'], changeResult.id, { warp: true });
  allBlocks[addOneProto.id] = addOneProto.block;
  const addOneDef = proceduresDefinition(addOneProto.id, 350, 200);
  allBlocks[addOneDef.id] = addOneDef.block;

  // === Prototype body #2: factorial %n (warp:false, reporter, recursive) ===
  // The body is a control_if_else:
  //   if (n == 1) return 1
  //   else return n * factorial(n - 1)
  // Because `procedures_prototype` accepts a SUBSTACK input, the
  // recursive call is *not* a child of the prototype's SUBSTACK;
  // it is a block inside the SUBSTACK. The compiled runtime
  // resolves the call to the same `thread.procedures["Nfactorial %n"]`
  // slot via the captured const (`b1`) — this is the path the
  // lazy cache must keep working.
  const one = mathNumber(1);
  allBlocks[one.id] = one.block;
  const nReporter1 = argumentReporterStringNumber('n', null);
  allBlocks[nReporter1.id] = nReporter1.block;
  const nEqOne = operatorEquals(nReporter1.id, one.id, null);
  allBlocks[nEqOne.id] = nEqOne.block;

  // if-branch: return 1
  const oneLiteral = mathNumber(1);
  allBlocks[oneLiteral.id] = oneLiteral.block;
  const returnOne = proceduresReturn(oneLiteral.id);
  allBlocks[returnOne.id] = returnOne.block;
  const ifBranch = controlIf(nEqOne.id, returnOne.id, null);
  allBlocks[ifBranch.id] = ifBranch.block;

  // else-branch: return n * factorial(n - 1)
  const nReporter2 = argumentReporterStringNumber('n', null);
  allBlocks[nReporter2.id] = nReporter2.block;
  const oneMinus = mathNumber(1);
  allBlocks[oneMinus.id] = oneMinus.block;
  const nMinusOne = operatorSubtract(nReporter2.id, oneMinus.id, null);
  allBlocks[nMinusOne.id] = nMinusOne.block;
  const recursiveCall = procedureReporterCall('factorial %n', [nMinusOne.id], null);
  allBlocks[recursiveCall.id] = recursiveCall.block;
  const product = operatorMultiply(nReporter2.id, recursiveCall.id, null);
  allBlocks[product.id] = product.block;
  const returnProduct = proceduresReturn(product.id);
  allBlocks[returnProduct.id] = returnProduct.block;

  const ifElse = controlIfElse(nEqOne.id, ifBranch.id, returnProduct.id, null);
  allBlocks[ifElse.id] = ifElse.block;

  const factProto = proceduresPrototype('factorial %n', ['n'], ifElse.id, { warp: false, returns: true });
  allBlocks[factProto.id] = factProto.block;
  const factDef = proceduresDefinition(factProto.id, 350, 400);
  allBlocks[factDef.id] = factDef.block;

  // Silence the unused-locals lint — `one` and `nReporter1` are
  // built up to compose `nEqOne` and may look unused in isolation
  // to a future reader.
  void one;
  void nReporter1;

  // === Hat: when_flag_clicked ===
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  // set [result v] to 0
  const zero = mathNumber(0);
  allBlocks[zero.id] = zero.block;
  const setResultZero = dataSetVar('result', zero.id, hat.id);
  hat.block.next = setResultZero.id;
  allBlocks[setResultZero.id] = setResultZero.block;

  // repeat (200) { call add_one v:0 }
  // The repeat is the hat's next-chain target. Its SUBSTACK is the
  // `callAddOne` block. The callAddOne block must NOT be in the
  // hat's next chain — otherwise we get a cycle in the block graph
  // (callAddOne.next = repeatTwoHundred, repeatTwoHundred.SUBSTACK
  // = callAddOne), which trips the runtime's blockToXML walk.
  const twoHundred = mathNumber(200);
  allBlocks[twoHundred.id] = twoHundred.block;
  const addOneArgZero = mathNumber(0);
  allBlocks[addOneArgZero.id] = addOneArgZero.block;
  const callAddOne = procedureCall('add_one %s', [addOneArgZero.id], null);
  allBlocks[callAddOne.id] = callAddOne.block;
  const repeatTwoHundred = controlRepeat(twoHundred.id, callAddOne.id, setResultZero.id);
  setResultZero.block.next = repeatTwoHundred.id;
  allBlocks[repeatTwoHundred.id] = repeatTwoHundred.block;
  callAddOne.block.parent = repeatTwoHundred.id;

  // set [fact v] to (factorial (5))
  // `factCall` lives **inside** the VALUE input of `setFact`, not in
  // the hat's next chain. Putting it in the next chain (as a sibling
  // of setFact) creates a cycle in the block graph because
  // blockToXML walks both `inputs.*.block` and `next` and the
  // reporter is the parent of setFact. The standard scratch layout
  // is: data_setvariableto.VALUE → reporter, with the reporter
  // being a leaf (no next). The recursive `factorial` reporter is
  // a leaf here because the recursion is implemented inside the
  // prototype body, not via a chain of calls.
  const five = mathNumber(5);
  allBlocks[five.id] = five.block;
  const factCall = procedureReporterCall('factorial %n', [five.id], null);
  allBlocks[factCall.id] = factCall.block;
  const setFact = dataSetVar('fact', factCall.id, repeatTwoHundred.id);
  repeatTwoHundred.block.next = setFact.id;
  allBlocks[setFact.id] = setFact.block;

  // === Stage / Sprite targets ===
  const stageSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>';
  const spriteSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" fill="#888888"/></svg>';

  // §Variables live on the sprite (not the stage) so the sprite's
  // `data_setvariableto` / `data_changevariableby` calls update them
  // directly via `util.target.lookupOrCreateVariable(id, name)`. If
  // they lived on the stage, a sprite-side `set` would create a
  // *new* local variable on the sprite (= different id), the stage
  // variables would stay at their initial values, and the parity
  // test would always observe 0/0 regardless of compilation mode.
  const spriteVars = {
    'var-result': ['result', 0],
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
    name: 'ProcedureLazy',
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
      agent: 'turbowasm-procedure-lazy-cache',
      platform: { name: 'TurboWasm Viewer' },
    },
  };
}

function proceduresReturn(valueBlockId, parent = null) {
  // A `procedures_return` block carries the return value as an
  // input. It is what scratch uses to *exit* a reporter procedure
  // early; for the non-reporter (void) `add_one` we don't emit
  // any return block.
  const { id, block } = makeBlock({
    opcode: 'procedures_return',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
    parent,
  });
  return { id, block };
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
  console.log(`[procedure-lazy-cache-fixture] wrote ${out} (${buf.length} bytes)`);
}

/**
 * Library entry point. Re-exported for `ensure-test-fixtures.mjs`.
 */
export async function makeProcedureLazyCacheFixture() {
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
  makeProcedureLazyCacheFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[procedure-lazy-cache-fixture] FAILED:', err);
    process.exit(1);
  });
}
