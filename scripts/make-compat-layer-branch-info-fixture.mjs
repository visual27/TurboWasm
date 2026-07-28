/**
 * Generate `test/.test-fixtures/compat-layer-branch-info-fixture.sb3`.
 *
 * Phase 4A — branchInfo pool A/B benchmark fixture.
 *
 * Layout (Stage + Sprite1):
 *
 *   Sprite1:
 *     when_flag_clicked (hat)
 *       procedure_call heat_branches v: branch_count=10, depth=8, stack_seed=stack_seed
 *
 *     procedures_definition heat_branches %s %s %s
 *       begin:
 *         repeat (1000)                                ← outer LOOP, drives branchInfo churn
 *           repeat (branch_count)                      ← inner LOOP, TIMES via argument reporter
 *             if <stack_seed = 0> then                 ← CONDITIONAL #1
 *               if <stack_seed = 0> then               ← CONDITIONAL #2
 *                 if <stack_seed = 0> then             ← CONDITIONAL #3
 *                   change [counter v] by 1            ← leaf body
 *                 end
 *               else
 *                 change [counter v] by 1
 *               end
 *             else
 *               change [counter v] by 1
 *             end
 *             change [stack_seed v] by 1
 *             if <(stack_seed mod 3) = 0> then
 *               change [counter v] by 1
 *             end
 *           end
 *         end
 *       end
 *
 *     procedures_definition nested_branch_loop %s
 *       begin:
 *         repeat (depth)
 *           if <(depth) = 1> then
 *             change [recurse_depth v] by 1
 *           else
 *             call nested_branch_loop v: ((depth) - (1))
 *           end
 *         end
 *       end
 *
 *   variables: counter, stack_seed (=1 initial), recurse_depth
 *
 * Why this shape: the script hot path goes through `createBranchInfo` for every
 * CONDITIONAL and LOOP. A 1000-iteration outer LOOP × ~3 nested CONDITIONALs +
 * 1 inner LOOP + the extra conditional gives ~6000-12000 branchInfo acquires
 * per VM frame, depending on `branch_count` and `depth` defaults. That makes
 * the A/B deltas visible in a 600-frame wall window without needing a 10M-frame
 * project.
 *
 * Notes on block tracking: every `mathNumber(N)` and `dataVariable(name)` call
 * creates a block that MUST land in `sprite.blocks`, otherwise the loader's
 * input-VALUE lookup fails with "could not find input VALUE with ID <id>" and
 * the procedure runs against a body with missing operands (= the IR warnings
 * we saw before this fix). The generator accumulates every block it creates in
 * `generated` and flushes them to `sprite.blocks` at the end.
 */

import {
  defaultProjectJson,
  defaultSprite,
  INPUT_BLOCK_NO_SHADOW,
  INPUT_SAME_BLOCK_SHADOW,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

let nextBlockId = 1;
const nextId = () => `b${nextBlockId++}`;

const generated = [];

function track(thing) {
  generated.push(thing);
  return thing;
}

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
    block: { id, opcode, inputs, fields, next, parent, topLevel, shadow, x, y, mutation },
  };
}

function hatFlag() {
  return track(makeBlock({
    opcode: 'event_whenflagclicked', topLevel: true, x: 100, y: 100,
  }));
}

function callCustomBlock(procCode, argShadowIds, parent = null) {
  // Each procedure argument is a 2-slot input: the shadow (= default value,
  // e.g. `math_number 0`) is the visible block the user attached the
  // number to, and the no-shadow slot is the actual value slot. The loader
  // expects `[INPUT_SAME_BLOCK_SHADOW, shadowBlockId, null, ...]` and walks
  // the shadow for the value. Passing `[INPUT_BLOCK_NO_SHADOW, ...]` with a
  // math_number as the value makes the loader look for an input named
  // `arg-<proccode>-<i>` (= "could not find input VALUE with ID <arg>").
  const inputs = {};
  for (let i = 0; i < argShadowIds.length; i += 1) {
    inputs[`arg-${procCode}-${i}`] = [INPUT_SAME_BLOCK_SHADOW, argShadowIds[i], null];
  }
  return track(makeBlock({
    opcode: 'procedures_call', inputs,
    mutation: { tagName: 'mutation', children: [], proccode: procCode }, parent,
  }));
}

function dataSetVar(name, valueBlockId, parent = null) {
  return track(makeBlock({
    opcode: 'data_setvariableto',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
    fields: { VARIABLE: [name, `var-${name}`] }, parent,
  }));
}

function dataChangeVar(name, deltaBlockId, parent = null) {
  return track(makeBlock({
    opcode: 'data_changevariableby',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, deltaBlockId] },
    fields: { VARIABLE: [name, `var-${name}`] }, parent,
  }));
}

function controlRepeat(timesBlockId, substackFirstChildId, parent = null) {
  return track(makeBlock({
    opcode: 'control_repeat',
    inputs: {
      TIMES: [INPUT_BLOCK_NO_SHADOW, timesBlockId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId],
    }, parent,
  }));
}

function controlIf(conditionBlockId, substackFirstChildId, parent = null) {
  return track(makeBlock({
    opcode: 'control_if',
    inputs: {
      CONDITION: [INPUT_BLOCK_NO_SHADOW, conditionBlockId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId],
    }, parent,
  }));
}

function controlIfElse(conditionBlockId, substackFirstChildId, substack2FirstChildId, parent = null) {
  return track(makeBlock({
    opcode: 'control_if_else',
    inputs: {
      CONDITION: [INPUT_BLOCK_NO_SHADOW, conditionBlockId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId],
      SUBSTACK2: [INPUT_BLOCK_NO_SHADOW, substack2FirstChildId],
    }, parent,
  }));
}

function operatorEquals(aBlockId, bBlockId, parent = null) {
  return track(makeBlock({
    opcode: 'operator_equals',
    inputs: {
      OPERAND1: [INPUT_BLOCK_NO_SHADOW, aBlockId],
      OPERAND2: [INPUT_BLOCK_NO_SHADOW, bBlockId],
    }, parent,
  }));
}

function operatorMod(aBlockId, bBlockId, parent = null) {
  return track(makeBlock({
    opcode: 'operator_mod',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, aBlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, bBlockId],
    }, parent,
  }));
}

function operatorSubtract(aBlockId, bBlockId, parent = null) {
  return track(makeBlock({
    opcode: 'operator_subtract',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, aBlockId],
      NUM2: [INPUT_BLOCK_NO_SHADOW, bBlockId],
    }, parent,
  }));
}

function argumentReporter(name, parent = null) {
  return track(makeBlock({
    opcode: 'argument_reporter_string_number',
    fields: { VALUE: [name, null] }, parent,
  }));
}

function mathNumber(value, parent = null) {
  return track(makeBlock({
    opcode: 'math_number',
    fields: { NUM: [String(value), null] }, parent, shadow: true,
  }));
}

function dataVariable(name, parent = null) {
  return track(makeBlock({
    opcode: 'data_variable',
    fields: { VARIABLE: [name, `var-${name}`] }, parent,
  }));
}

function procedurePrototype(procCode, argumentNames, substackHeadId, { warp = false } = {}) {
  const argDescriptors = argumentNames.map((name) => ({
    tagName: 'arg', children: [], name,
  }));
  const mutation = {
    tagName: 'mutation',
    children: argDescriptors,
    proccode: procCode,
    argumentnames: JSON.stringify(argumentNames),
    argumentids: JSON.stringify(argumentNames.map((_, i) => `arg-${procCode}-${i}`)),
    argumentdefaults: JSON.stringify(argumentNames.map(() => '0')),
    warp: warp ? 'true' : 'false',
  };
  return track(makeBlock({
    opcode: 'procedures_prototype',
    inputs: { SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackHeadId] },
    mutation, topLevel: true, shadow: true, x: 100, y: 250,
  }));
}

function procedureDefinition(prototypeId, x = 400, y = 250) {
  return track(makeBlock({
    opcode: 'procedures_definition',
    inputs: { custom_block: [INPUT_SAME_BLOCK_SHADOW, prototypeId] },
    topLevel: true, x, y,
  }));
}

function buildProjectJson() {
  // Reset state.
  nextBlockId = 1;
  generated.length = 0;
  const project = defaultProjectJson({ agent: 'turbowasm-phase4a-branch-info-pool' });
  const sprite = defaultSprite('Sprite1');
  project.targets[1] = sprite;

  sprite.variables = {
    counter: ['counter', 0],
    stack_seed: ['stack_seed', 1],
    recurse_depth: ['recurse_depth', 0],
  };

  // ===== when_flag_clicked hat =====
  const hat = hatFlag();
  const stackSeedRead = dataVariable('stack_seed');
  const branchCountNum = mathNumber(10);
  const depthNum = mathNumber(8);
  const callHeatBranches = callCustomBlock(
    'heat_branches %s %s %s',
    [branchCountNum.id, depthNum.id, stackSeedRead.id],
  );
  hat.block.next = callHeatBranches.id;

  // ===== procedures_definition heat_branches %s %s %s =====
  // Inner leaf: change [counter] by 1.
  const leafChangeCounter = dataChangeVar('counter', mathNumber(1).id);

  // CONDITIONAL #1 (outermost): if (stack_seed = 0) then [else branch]
  const equalsZeroOuter = operatorEquals(dataVariable('stack_seed').id, mathNumber(0).id);

  // CONDITIONAL #2 (middle): if (stack_seed = 0) then CONDITIONAL#3 else leaf
  const equalsZeroMiddle = operatorEquals(dataVariable('stack_seed').id, mathNumber(0).id);

  // CONDITIONAL #3 (innermost): if (stack_seed = 0) then leaf else leaf
  const equalsZeroInner = operatorEquals(dataVariable('stack_seed').id, mathNumber(0).id);
  const deepestIf = controlIf(equalsZeroInner.id, leafChangeCounter.id);

  const middleIf = controlIfElse(equalsZeroMiddle.id, deepestIf.id, leafChangeCounter.id);
  const outerIf = controlIfElse(equalsZeroOuter.id, middleIf.id, leafChangeCounter.id);

  // Post-CONDITIONAL stack: change stack_seed, then a mod-3 conditional that
  // bumps counter.
  const incStackSeed = dataChangeVar('stack_seed', mathNumber(1).id);
  const modThree = operatorMod(dataVariable('stack_seed').id, mathNumber(3).id);
  const modEqualsZero = operatorEquals(modThree.id, mathNumber(0).id);
  const modIf = controlIf(modEqualsZero.id, leafChangeCounter.id);

  // Inner repeat: parameter `branch_count` times.
  const branchCountReporter = argumentReporter('branch_count');
  const innerRepeat = controlRepeat(branchCountReporter.id, outerIf.id);

  // Post-repeat: tail of inner body.
  outerIf.block.next = incStackSeed.id;
  middleIf.block.next = incStackSeed.id;
  deepestIf.block.next = modIf.id;
  modIf.block.next = incStackSeed.id;
  incStackSeed.block.next = null;
  leafChangeCounter.block.next = null;

  // Outer repeat: 1000 times.
  const outerRepeatTimes = mathNumber(1000);
  const outerRepeat = controlRepeat(outerRepeatTimes.id, innerRepeat.id);

  // Prototype + definition.
  const heatBranchesPrototype = procedurePrototype(
    'heat_branches %s %s %s',
    ['branch_count', 'depth', 'stack_seed'],
    outerRepeat.id,
  );
  const heatBranchesDefinition = procedureDefinition(heatBranchesPrototype.id);

  // ===== procedures_definition nested_branch_loop %s =====
  const depthRead = dataVariable('depth');
  const depthReporter = argumentReporter('depth');
  const equalsOne = operatorEquals(depthRead.id, mathNumber(1).id);
  const incRecurseDepth = dataChangeVar('recurse_depth', mathNumber(1).id);
  const depthMinusOne = operatorSubtract(depthReporter.id, mathNumber(1).id);
  const recursiveCall = callCustomBlock('nested_branch_loop %s', [depthMinusOne.id]);
  const nestedIfElse = controlIfElse(equalsOne.id, incRecurseDepth.id, recursiveCall.id);
  const nestedRepeat = controlRepeat(depthReporter.id, nestedIfElse.id);
  incRecurseDepth.block.next = null;
  recursiveCall.block.next = null;
  const nestedPrototype = procedurePrototype(
    'nested_branch_loop %s',
    ['depth'],
    nestedRepeat.id,
  );
  const nestedDefinition = procedureDefinition(nestedPrototype.id, 400, 350);

  // Flush every generated block. Without this the loader's input-VALUE
  // lookup fails for `math_number` shadows / `data_variable` reporters /
  // inline numeric literals (= the IR warnings we saw before this fix).
  for (const b of generated) sprite.blocks[b.block.id] = b.block;

  return project;
}

export async function makeCompatLayerBranchInfoFixture() {
  return writeSb3Fixture('compat-layer-branch-info-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeCompatLayerBranchInfoFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-compat-layer-branch-info-fixture] wrote', p);
  });
}