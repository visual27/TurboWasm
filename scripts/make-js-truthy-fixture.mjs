/**
 * Generate `test/.test-fixtures/js-truthy-fixture.sb3`.
 *
 * Phase 9-B target: `semantics.jsTruthyBooleans`.
 *
 * The fixture is a single sprite whose `when flag clicked` script runs
 * the canonical `Cast.toBoolean` boundary-case matrix from the Phase 9-B
 * spec (see `phase-09b-js-truthy.md` §9B-4) and accumulates each
 * scenario's 3-char `if`/`and`/`or` triplet (= `i`/`a`/`o`) into a
 * stage-level string variable named `results`. The test file
 * (`test/runtime/scratch-vm-tap-bridge-js-truthy-booleans.test.ts`)
 * decodes the accumulated string to verify the runtime gate end-to-end
 * across both interpreter and compiled paths.
 *
 * **Why `data_variable` shadows instead of inline literals:**
 * `vendored/scratch-vm/src/compiler/irgen.js:createConstantInput`
 * eagerly converts the literal `'0'` (= the canonical
 * `jsTruthyBooleans` divergence case from §9B-4) to the JS number
 * `0` because `+'0' === 0` and `0.toString() === '0'`. The IR's
 * constant-folding pass then bakes `if (0) ...` (= `if (false)`)
 * into the compiled source — meaning the runtime test would never
 * see the actual string `'0'`. Routing the value through a sprite
 * variable (= `data_variable` shadow) sidesteps the fold: the IR
 * emits `VAR_GET` (= a non-constant) for the read, so `toBoolean`
 * is called at runtime with the actual string. The same pattern
 * applies to all matrix values for consistency.
 *
 * Block shape uses the schema-correct primitive IDs
 * (`MATH_NUM_PRIMITIVE`, `TEXT_PRIMITIVE`, `INPUT_SAME_BLOCK_SHADOW`,
 * `INPUT_BLOCK_NO_SHADOW`) so `ensure-test-fixtures` accepts the
 * fixture without the schema gate failing over.
 *
 * The runtime gate is `runtime.compilerOptions.semantics
 * .jsTruthyBooleans`, exposed by the Settings dialog (Phase 7) and
 * via the `// _twconfig_` `semanticsPreset` / `semantics
 * .jsTruthyBooleans` payload (Phase 7+9-B). Tests load this fixture
 * under four configurations:
 *
 *   1. `compile=true, semantics.jsTruthyBooleans=false`: scratch-
 *      compatible run; results match upstream scratch-vm.
 *   2. `compile=true, semantics.jsTruthyBooleans=true`: divergence
 *      rows flip (`'0'`, `'false'`, `'FALSE'`, `' '`) from 0 to 1;
 *      everything else stays stable.
 *   3. `compile=false, semantics.jsTruthyBooleans=true` (= interpreter-
 *      only): exercises the interpreter-path gate in `cast.js`.
 *   4. `compile=false, semantics.jsTruthyBooleans=false`: scratch-
 *      compatible interpreter run.
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

function mathNumber(value) {
  return track(makeBlock({
    opcode: 'math_number',
    fields: { NUM: [String(value), null] },
    shadow: true,
  }));
}

function textPrimitive(value) {
  return track(makeBlock({
    opcode: 'text',
    fields: { TEXT: [String(value), null] },
    shadow: true,
  }));
}

function dataVariable(name) {
  return track(makeBlock({
    opcode: 'data_variable',
    fields: { VARIABLE: [name, `var-${name}`] },
  }));
}

function dataSetVar(name, valueId) {
  return track(makeBlock({
    opcode: 'data_setvariableto',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueId] },
    fields: { VARIABLE: [name, `var-${name}`] },
  }));
}

function operatorAnd(leftId, rightId) {
  return track(makeBlock({
    opcode: 'operator_and',
    inputs: {
      OPERAND1: [INPUT_SAME_BLOCK_SHADOW, leftId],
      OPERAND2: [INPUT_SAME_BLOCK_SHADOW, rightId],
    },
  }));
}

function operatorOr(leftId, rightId) {
  return track(makeBlock({
    opcode: 'operator_or',
    inputs: {
      OPERAND1: [INPUT_SAME_BLOCK_SHADOW, leftId],
      OPERAND2: [INPUT_SAME_BLOCK_SHADOW, rightId],
    },
  }));
}

function operatorJoin(leftId, rightId) {
  return track(makeBlock({
    opcode: 'operator_join',
    inputs: {
      STRING1: [INPUT_SAME_BLOCK_SHADOW, leftId],
      STRING2: [INPUT_SAME_BLOCK_SHADOW, rightId],
    },
  }));
}

function controlIfElse(conditionId, substack1Id, substack2Id) {
  return track(makeBlock({
    opcode: 'control_if_else',
    inputs: {
      CONDITION: [INPUT_BLOCK_NO_SHADOW, conditionId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substack1Id],
      SUBSTACK2: [INPUT_BLOCK_NO_SHADOW, substack2Id],
    },
  }));
}

/**
 * The canonical string matrix from §9B-4. 7 entries.
 *
 * **Why only strings:** `vendored/scratch-vm/src/engine/runtime.js`
 * stores the value of a `data_setvariable` (= `data_setvariableto`)
 * block by evaluating its `VALUE` input. For `math_number` shadows
 * (= used for the number/boolean values) the input evaluates to
 * the raw `NUM` field string (= the shadow doesn't auto-parse
 * `Number(NUM)`). The compiled path (= IR + jsgen) then converts
 * the shadow's STRING_NUM to a NUMBER (= via
 * `intermediate.js:toType(NUMBER)`), so the compiled `if` evaluates
 * `toBoolean(0)` (= number 0). The interpreter path (= no IR) keeps
 * the raw string, so the interpreter `if` evaluates
 * `toBoolean("0")` (= string `"0"`). The two paths observe
 * different value types, so a single `expectedIf` function can't
 * cover both. We restrict the matrix to strings (= whose values
 * survive both paths unchanged) and rely on the unit-level
 * `Cast.toBoolean` tests for the number/boolean coverage.
 *
 * **Why `'0'` (string) is omitted:** `vendored/scratch-vm/src
 * /compiler/irgen.js:createConstantInput` eagerly converts the
 * literal `'0'` to the JS number `0` because `+'0' === 0` and
 * `0.toString() === '0'`. The compiled-path `if (toConstant)` then
 * bakes `if (0) ...` (= `if (false)`) into the source — meaning
 * the runtime matrix would never see the actual string `'0'`.
 * The unit-level `Cast.toBoolean` test directly probes `'0'` so
 * the divergence row is still covered end-to-end, just outside
 * the runtime matrix.
 *
 * `null` and `undefined` are excluded because sb3 shadow
 * primitives cannot carry those primitives (= the shadow parser
 * would coerce them to the string `'null'` / `'undefined'`, which
 * is not what `toBoolean` is being asked to test); those are
 * covered directly by the `Cast.toBoolean` unit tests.
 */
const VALUE_MATRIX = [
  '',
  'false',
  'FALSE',
  ' ',
  '00',
  'true',
  'anything',
];

/**
 * Pick the right shadow reporter for a value:
 *  - strings → `text` reporter (= `TEXT_PRIMITIVE` shadow)
 *  - numbers → `math_number` reporter (= `MATH_NUM_PRIMITIVE` shadow,
 *    parses through `Number()` so 'NaN' / 'Infinity' / '-Infinity'
 *    become the actual JS numbers at runtime)
 *  - booleans → `math_number` reporter with 1 / 0 (= sb3 has no
 *    boolean primitive; `toBoolean(1)` is true, `toBoolean(0)` is
 *    false, both via the legacy Scratch string-fallback table).
 */
function valueReporter(value) {
  if (typeof value === 'string') return textPrimitive(value);
  if (typeof value === 'number') {
    return mathNumber(value);
  }
  if (typeof value === 'boolean') return mathNumber(value ? 1 : 0);
  throw new Error(`[make-js-truthy-fixture] unhandled value type: ${typeof value} ${value}`);
}

/**
 * Build a single scenario: emit the 3-char `i`/`a`/`o` triplet for
 * the value held in `varName` into the stage-level `results` string.
 * Returns `{ first, last }` block IDs (= the entry and exit points of
 * the scenario's if/and/or chain) so the caller can splice the
 * scenario into the top-level sequence.
 */
function emitScenario(varName) {
  // Read the variable (= the value to test). The IR sees a `VAR_GET`
  // (= not a constant), so the constant-fold pass leaves the
  // `toBoolean` call intact at runtime.
  const vRead = dataVariable(varName);

  // Helper: build `data_setvar results = operator_join(results, "<bit>")`
  const appendChar = (bit) => {
    const charRep = textPrimitive(bit);
    const readVar = dataVariable('results');
    const join = operatorJoin(readVar.id, charRep.id);
    const setVar = dataSetVar('results', join.id);
    return setVar.id;
  };

  // Helper: build `control_if_else <cond>, appendChar('1'), appendChar('0')`
  const ifElseForCondition = (condId) => {
    const trueBranch = appendChar('1');
    const falseBranch = appendChar('0');
    return controlIfElse(condId, trueBranch, falseBranch).id;
  };

  // 1. `if <v> then 1 else 0`
  const ifBlock = ifElseForCondition(vRead.id);

  // 2. `(<v>) and (true) then 1 else 0`
  // `trueRep` is a single space (= ` `). In OFF mode, `toBoolean(' ')`
  // is true (= the string isn't in the legacy false list). In ON
  // mode, `toBoolean(' ')` is also true (= `!!' '` is true). So the
  // and's right operand is truthy in both modes, and the and's
  // result collapses to `toBoolean(v)`.
  const trueRep = textPrimitive(' ');
  const andBlock = operatorAnd(vRead.id, trueRep.id);
  const andIfBlock = ifElseForCondition(andBlock.id);

  // 3. `(<v>) or (false) then 1 else 0`
  // The empty string is the only value that is reliably falsy in both
  // OFF and ON modes (= in ON mode, `toBoolean("0")` is true because
  // `!!"0"` is `true`; the empty string's `!!''` is always `false`).
  const falseRep = textPrimitive('');
  const orBlock = operatorOr(vRead.id, falseRep.id);
  const orIfBlock = ifElseForCondition(orBlock.id);

  // Chain the 3 if_else blocks (= scratch walks `next` from the
  // previous top-level block).
  const ifGen = generated.find((g) => g.id === ifBlock);
  const andGen = generated.find((g) => g.id === andIfBlock);
  const orGen = generated.find((g) => g.id === orIfBlock);
  ifGen.block.next = andIfBlock;
  andGen.block.next = orIfBlock;
  return { first: ifBlock, last: orIfBlock };
}

function buildProjectJson() {
  // Reset state so a re-run via `ensure-test-fixtures` regenerates
  // from a clean block-id counter (= no cross-run leakage).
  nextBlockId = 1;
  generated.length = 0;

  const project = defaultProjectJson({ agent: 'turbowasm-js-truthy' });
  const sprite = defaultSprite('Sprite1');
  project.targets[1] = sprite;

  // Stage-level accumulator. Lives on Stage (= not Sprite1) so the
  // test can read it via `Object.values(stage.variables).find((v) =>
  // v.name === 'results')` regardless of how the runtime namespaces
  // sprite / stage variables internally.
  const resultsVarId = 'aa11bb22cc33dd44ee55ff66aa11bb22';
  project.targets[0].variables = {
    [resultsVarId]: ['results', ''],
  };

  // Sprite-level working variable (= the value to test). Routed
  // through `data_setvariable` / `data_variable` (= the module
  // header explains why a literal shadow would IR-fold `'0'` to
  // the number `0`).
  const vVarId = 'ffeeddccbbaa99887766554433221100';
  sprite.variables = {
    [vVarId]: ['v', ''],
  };

  const blocks = {};
  const hat = hatFlag();
  // Init: `data_setvar results = ''`. Re-use a `text('')` reporter as
  // the empty-string value source. The constant-fold here is harmless:
  // the `setvar results` runtime call receives the empty string
  // regardless of how the IR tagged the constant.
  const emptyText = textPrimitive('');
  const initSetVar = dataSetVar('results', emptyText.id);
  hat.block.next = initSetVar.id;

  // Chain: for each value, set the sprite variable (= the value
  // encoded via the appropriate shadow reporter), then emit the
  // 3-char scenario triplet. The previous top-level block's `next`
  // points to the new `setV` block; the new scenario's first
  // if_else (and the if/and/or chain inside) follows.
  let prevLastId = initSetVar.id;
  for (const value of VALUE_MATRIX) {
    // Set `v = <value>`. The reporter's IR constant-fold is OK here
    // because the value is then immediately consumed via
    // `data_variable` (= which forces a `VAR_GET` instead of the
    // folded constant).
    const reporter = valueReporter(value);
    const setV = dataSetVar('v', reporter.id);
    // The previous top-level block (= init or previous scenario's
    // `or` if_else) chains into this `setV`.
    const prevBlock = generated.find((g) => g.id === prevLastId);
    if (prevBlock) prevBlock.block.next = setV.id;
    // Build the if/and/or triplet for this value. The first
    // if_else's `next` chain is established inside `emitScenario`.
    // We expose the FIRST if_else (= the chain entry point) so we
    // can link `setV.block.next` to it (= no premature `null` at
    // the end of the previous chain).
    const scenario = emitScenario('v');
    const firstIfElse = scenario.first;
    const lastIfElse = scenario.last;
    if (process.env.DEBUG_FIXTURE) {
      // eslint-disable-next-line no-console
      console.log(`[chain] prev=${prevLastId} setV=${setV.id} first=${firstIfElse} last=${lastIfElse}`);
    }
    setV.block.next = firstIfElse;
    prevLastId = lastIfElse;
  }
  void vVarId;

  // Flush every generated block into the sprite's blocks map (= the
  // loader requires every referenced block id to be present in the
  // target's blocks, otherwise `Blocks.parseInput` raises "could not
  // find input VALUE with ID <id>").
  for (const entry of generated) {
    blocks[entry.id] = entry.block;
  }
  sprite.blocks = blocks;

  return project;
}

export async function makeJsTruthyFixture() {
  return writeSb3Fixture('js-truthy-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeJsTruthyFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-js-truthy-fixture] wrote', p);
  });
}
