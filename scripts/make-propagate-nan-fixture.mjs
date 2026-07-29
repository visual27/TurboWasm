/**
 * Generate `test/.test-fixtures/propagate-nan-fixture.sb3`.
 *
 * Phase 9-C target: `semantics.propagateNaN`.
 *
 * Each matrix row executes:
 *
 *   setvar v = <value>
 *   setvar combined = (data_variable(v) + 0)
 *   setvar results = operator_join(
 *       data_variable(results),
 *       operator_join(text(''), data_variable(combined))
 *   )
 *
 * Stages:
 *  - compiled path: each variable read (= VAR_GET) goes through
 *    `toNotNaN` (= the runtime gate). The left/right operands of the
 *    inner `+` are both `toNotNaN`-wrapped at compile time; the join
 *    just string-concatenates.
 *  - interpreter path: each variable read goes through `Cast.toNumber`
 *    (= `Cast._propagateNaNFlag`).
 *
 * The stage-level `results` variable accumulates `String(combined)`
 * for every row (= one row per matrix entry). OFF path converts
 * NaN-coercion results to `"0"` so rows like `"5.5abc" + 5` come
 * out as `"0"`. ON path preserves the NaN, so the same rows come
 * out as `"NaN"`. The runtime matrix tests decode this accumulation
 * to assert the gate end-to-end.
 *
 * **Why `data_variable` shadows:** `irgen.js:createConstantInput`
 * eagerly converts the literal `'5.5abc'` (= `Number('5.5abc')` is
 * NaN) to a constant `NaN`, which means a runtime test would never
 * observe the actual string `'5.5abc'`. Routing through a sprite
 * variable forces a `VAR_GET` (= non-constant) at runtime so
 * `toNotNaN` / `Cast.toNumber` actually run on the string.
 *
 * **Three-tuple input slots:** scratch sb3 input slots are
 * `[type, blockOrShadowId, cachedValue]`. The 3-tuple is the
 * schema-correct form per AGENTS.md §「SB3 形状規約」.
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
  blockId,
}) {
  return {
    id: blockId,
    block: { id: blockId, opcode, inputs, fields, next, parent, topLevel, shadow, x, y, mutation },
  };
}

const nextId = () => `b${nextBlockId++}`;

function hatFlag() {
  return track(makeBlock({
    opcode: 'event_whenflagclicked', topLevel: true, x: 100, y: 100, blockId: nextId(),
  }));
}

function mathNumberShadow() {
  return track(makeBlock({
    opcode: 'math_number',
    fields: { NUM: ['0', null] },
    shadow: true,
    blockId: nextId(),
  }));
}

function textShadow(value) {
  return track(makeBlock({
    opcode: 'text',
    fields: { TEXT: [String(value), null] },
    shadow: true,
    blockId: nextId(),
  }));
}

function dataVariable(name) {
  const id = nextId();
  return track(makeBlock({
    opcode: 'data_variable',
    fields: { VARIABLE: [name, `var-${name}`] },
    blockId: id,
  }));
}

function dataSetVar(name, valueBlockId) {
  const id = nextId();
  return track(makeBlock({
    opcode: 'data_setvariableto',
    inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, valueBlockId, null] },
    fields: { VARIABLE: [name, `var-${name}`] },
    blockId: id,
  }));
}

function operatorAdd(leftBlockId, rightBlockId) {
  const id = nextId();
  return track(makeBlock({
    opcode: 'operator_add',
    inputs: {
      NUM1: [INPUT_SAME_BLOCK_SHADOW, leftBlockId, null],
      NUM2: [INPUT_SAME_BLOCK_SHADOW, rightBlockId, null],
    },
    blockId: id,
  }));
}

function operatorJoin(leftBlockId, rightBlockId) {
  const id = nextId();
  return track(makeBlock({
    opcode: 'operator_join',
    inputs: {
      STRING1: [INPUT_SAME_BLOCK_SHADOW, leftBlockId, null],
      STRING2: [INPUT_SAME_BLOCK_SHADOW, rightBlockId, null],
    },
    blockId: id,
  }));
}

/**
 * String-coerce a variable: emit `operator_join("", data_variable(<name>))`.
 * Since scratch runtime coerces a number reporter into a string when
 * the slot expects a string, this is one extra wrap for clarity and
 * to keep the IR surface stable under `toType(STRING)`.
 */
function stringCoerceOfVariable(varName) {
  const emptyText = textShadow('');
  const dataVar = dataVariable(varName);
  return operatorJoin(emptyText.id, dataVar.id);
}

/**
 * One scenario = a 3-stage chain that appends `String(combined)`
 * (= `Number(<v>) + 0` run through the gate) to the stage-level
 * `results` string.
 *
 * Concretely:
 *   1. setvar v = <value>
 *   2. setvar combined = (data_variable(v) + 0)
 *   3. setvar results = operator_join(results, operator_join('', data_variable(combined)))
 *
 * Stage 3's outer `join` reads `data_variable("results")` (= the
 * current accumulator) and the inner `join` (= `String(combined)`)
 * and concatenates them — that's what makes the row append instead
 * of overwrite.
 *
 * Returns the IDs of the FIRST and LAST top-level blocks for chain
 * stitching.
 */
function emitScenario(value) {
  if (typeof value !== 'string') {
    throw new Error(`[make-propagate-nan-fixture] only string values supported: ${value}`);
  }
  // Stage 1: `setvar v = <value>`.
  const valueSource = textShadow(value);
  const setV = dataSetVar('v', valueSource.id);

  // Stage 2: `setvar combined = (data_variable(v) + 0)`.
  const zeroRep = mathNumberShadow();
  const vRead = dataVariable('v');
  const plus = operatorAdd(vRead.id, zeroRep.id);
  const setCombined = dataSetVar('combined', plus.id);

  // Stage 3: `setvar results = join(results, String(combined))`.
  // inner: `String(combined)` = `join('', data_variable(combined))`.
  const stringCombined = stringCoerceOfVariable('combined');
  // outer: `join(results, innerResult)`.
  const resultsRead = dataVariable('results');
  const join = operatorJoin(resultsRead.id, stringCombined.id);
  const setResults = dataSetVar('results', join.id);

  // Chain stages 1 → 2 → 3 via the stack `next` pointer.
  setV.block.next = setCombined.id;
  setCombined.block.next = setResults.id;
  return { first: setV.id, last: setResults.id };
}

function buildProjectJson() {
  nextBlockId = 1;
  generated.length = 0;

  const project = defaultProjectJson({ agent: 'turbowasm-propagate-nan' });
  const sprite = defaultSprite('Sprite1');
  project.targets[1] = sprite;

  // Stage-level `results` accumulator (string).
  const resultsVarId = 'aa11bb22cc33dd44ee55ff66aa11bb22';
  project.targets[0].variables = {
    [resultsVarId]: ['results', ''],
  };

  // Sprite-level working variables (= bypass IR constant-fold).
  const vVarId = 'ffeeddccbbaa99887766554433221100';
  const combinedVarId = '11ffeeddccbbaa9988776655443322';
  sprite.variables = {
    [vVarId]: ['v', ''],
    [combinedVarId]: ['combined', 0],
  };

  const blocks = {};
  const hat = hatFlag();
  // Init: `setvar results = ""`.
  const emptyTextForInit = textShadow('');
  const initSetVar = dataSetVar('results', emptyTextForInit.id);
  hat.block.next = initSetVar.id;

  const VALUE_MATRIX = ['abc', '', '5', '5.5', '5.5abc', 'NaN', 'Infinity'];
  let prevLastId = initSetVar.id;
  for (const value of VALUE_MATRIX) {
    const { first, last } = emitScenario(value);
    const prevBlock = generated.find((g) => g.id === prevLastId);
    if (prevBlock) prevBlock.block.next = first;
    prevLastId = last;
  }
  void vVarId;
  void combinedVarId;

  for (const entry of generated) {
    blocks[entry.id] = entry.block;
  }
  sprite.blocks = blocks;

  return project;
}

export async function makePropagateNanFixture() {
  return writeSb3Fixture('propagate-nan-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makePropagateNanFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-propagate-nan-fixture] wrote', p);
  });
}
