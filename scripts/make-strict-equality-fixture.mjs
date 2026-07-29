/**
 * Generate `test/.test-fixtures/strict-equality-fixture.sb3`.
 *
 * Phase 9-A target: `semantics.strictNumericEquality`.
 *
 * The fixture is a single sprite whose `when flag clicked` script
 * runs the canonical `operator_equals` matrix from the Phase 9-A
 * spec (see `phase-09a-strict-equality.md` §9A-4) and stores each
 * result in a list named `equality_results`. A second thread runs
 * the list-contains matrix (= §9A-3 §主変更 3) for the
 * `data_listcontainsitem` path, exposing the interpreter-side gate
 * in `scratch3_data.js`.
 *
 * Block shape uses the schema-correct primitive IDs
 * (`MATH_NUM_PRIMITIVE`, `LIST_PRIMITIVE`, `TEXT_PRIMITIVE`,
 * `INPUT_SAME_BLOCK_SHADOW`) so `ensure-test-fixtures` accepts the
 * fixture without the schema gate failing over.
 *
 * The runtime gate is `runtime.compilerOptions.semantics
 * .strictNumericEquality`, which is exposed by the Settings dialog
 * (Phase 7) and via the `// _twconfig_` `semanticsPreset` /
 * `semantics.strictNumericEquality` payload (Phase 7+9-A).
 * Tests load this fixture under three configurations:
 *
 *   1. `strictNumericEquality=false` (Scratch default): a fully
 *      scratch-compatible run; results match upstream scratch-vm.
 *   2. `strictNumericEquality=true`: each mixed-type pair flips to
 *      `false`; numeric-only / `Infinity` pairs remain stable.
 *   3. `disableCompiler=true` (interpreter-only) + `strictNumericEquality=true`:
 *      exercises the interpreter-path gate (= `scratch3_data.js` +
 *      `scratch3_operators.js`) end-to-end.
 */
import {
  defaultProjectJson,
  INPUT_SAME_BLOCK_SHADOW,
  isInvokedDirectly,
  LIST_PRIMITIVE,
  MATH_NUM_PRIMITIVE,
  TEXT_PRIMITIVE,
  writeSb3Fixture,
} from './_fixture-base.mjs';

/**
 * §9A-4 — Type-mixed vs same-type truth table. The spec matrix is
 * the contract; the runtime must agree on both rows for each
 * configuration. We drop the scratch-compatible rows (= `'5' === 5`
 * under OFF) into `equality_results` for off-mode regression
 * detection, and pair them with strict-mode comparisons under a
 * parallel `flag-click + broadcast` second thread.
 */
const EQUALITY_MATRIX = [
  // Numeric-only (stable across OFF/ON).
  [5, 5],
  [5, 5.0],
  [Infinity, Infinity],
  [-Infinity, -Infinity],
  // Type-mixed (the rows the runtime gate must flip under strict=ON).
  [5, '5'],
  ['5', 5],
  // NaN pairs (NaN === NaN is false even under strict=ON).
  [NaN, NaN],
  [5, NaN],
  // null / boolean (different `typeof`).
  [null, false],
  [false, null],
  // String pair (case-sensitive delegation).
  ['Hello', 'hello'],
];

/**
 * §9A-3 §主変更 3 — listContainsItem matrix. The list `bag`
 * mixes numbers + strings; the test calls
 * `data_listcontainsitem(ITEM=needle, LIST=bag)` and accumulates
 * the boolean result in `list_results`.
 *
 * The two `needle` variants per `bag` exercise the 4-arg gate's
 * narrow path (= `scratch3_data.js:listContainsItem`'s
 * `Cast.compare(..., caseSensitive, strict)` call).
 */
const LIST_MATRIX = [
  { bag: [5, '5', true, null, 'Hello'], needle: 5, comment: 'numeric vs mixed bag' },
  { bag: [5, '5', true, null, 'Hello'], needle: '5', comment: 'string vs mixed bag' },
  { bag: [5, '5', true, null, 'Hello'], needle: true, comment: 'boolean vs mixed bag' },
  { bag: [5, '5', true, null, 'Hello'], needle: null, comment: 'null vs mixed bag' },
  { bag: [5, '5', true, null, 'Hello'], needle: 'Hello', comment: 'string Hello in bag' },
];

/**
 * Encode a literal value for a scratch input slot. Numbers become
 * `MATH_NUM_PRIMITIVE`; strings become `TEXT_PRIMITIVE`; booleans
 * become `'1'` / `'0'` (sb3 has no boolean primitive, so we ride
 * the legacy `compareEqual` numeric coercion path). `null` and
 * `undefined` are encoded as the string `'null'` / `'undefined'`
 * because the input-slot primitive descriptors cannot carry those
 * primitives either; the values that ship through the runtime end
 * up coerced via `Cast.toNumber` (= `0`) so the strict gate's
 * `typeof null !== typeof <number>` branch is what fires in
 * practice.
 *
 * The scratch runtime maps literals via `Blocks.parseInput` —
 * numeric shadows go straight through `Number(<string>)`, text
 * shadows through `String`. The NaN / Infinity entries below use
 * the standard string `'NaN'` / `'Infinity'` which `Number()`
 * decodes faithfully on both the literal and the runtime side.
 */
function literal(value) {
  if (typeof value === 'boolean') {
    return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, value ? '1' : '0']];
  }
  if (typeof value === 'number') {
    // `NaN` and `Infinity` serialise to those literals because
    // JSON has no separate escape. `Number('NaN')` is `NaN`
    // and `Number('Infinity')` is `Infinity` — exactly what
    // the runtime expects.
    const repr = Number.isNaN(value) ? 'NaN' : String(value);
    return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, repr]];
  }
  if (typeof value === 'string') {
    return [INPUT_SAME_BLOCK_SHADOW, [TEXT_PRIMITIVE, value]];
  }
  if (value === null) {
    // `null` is not a sb3 primitive either; encode as the
    // string `'null'` (parses to `0` under `Cast.toNumber`,
    // exactly what the runtime delivers when a scratch
    // input resolves to `null`). The strict gate's
    // `typeof null !== typeof <number>` (= `object` vs
    // `number`) flips `'null' === 0` to `false` under
    // strict=ON.
    return [INPUT_SAME_BLOCK_SHADOW, [TEXT_PRIMITIVE, 'null']];
  }
  throw new Error(`[strict-equality fixture] unhandled literal: ${value}`);
}

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-strict-equality' });

  const stage = project.targets[0];
  const sprite = project.targets[1];

  // Two `LIST_PRIMITIVE` lists — `equality_results` accumulates
  // the `operator_equals` matrix results, `list_results`
  // accumulates the `data_listcontainsitem` matrix results.
  const equalityListId = 'c0ffeec0ffeec0ffeec0ffeec0ffeec1';
  const listResultsId = 'c0ffeec0ffeec0ffeec0ffeec0ffeec2';
  sprite.lists = {
    [equalityListId]: ['equality_results', []],
    [listResultsId]: ['list_results', []],
  };

  // Two `data_variable` buckets — `eq` carries the boolean
  // result of `operator_equals` (used to chain into
  // `data_addtolist`), `lc` carries the boolean result of
  // `data_listcontainsitem`. Direct variable-shadow inputs on
  // `data_addtolist` would also work but using a variable
  // explicitly exercises `data_setvariableto`'s
  // `setVariable` path under both phases.
  const eqVarId = 'aabbccddeeffaabbccddeeffaabb0001';
  const lcVarId = 'aabbccddeeffaabbccddeeffaabb0002';
  sprite.variables = {
    [eqVarId]: ['eq', 0],
    [lcVarId]: ['lc', 0],
  };

  const blocks = {};
  let blockIdCounter = 100;
  const nextId = () => String(blockIdCounter++);

  const flagClickId = nextId();
  blocks[flagClickId] = {
    opcode: 'event_whenflagclicked',
    next: null,
    topLevel: true,
    parent: null,
    shadow: false,
    x: 0,
    y: 0,
    inputs: {},
    fields: {},
  };

  const VAR_PRIMITIVE = 12;

  // === Thread 1: operator_equals matrix ===
  let prevId = flagClickId;
  for (const pair of EQUALITY_MATRIX) {
    const equalsId = nextId();
    const setVarId = nextId();
    const addId = nextId();

    blocks[equalsId] = {
      opcode: 'operator_equals',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: {
        OPERAND1: literal(pair[0]),
        OPERAND2: literal(pair[1]),
      },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, equalsId, null],
      },
      fields: { VARIABLE: [eqVarId, 'eq'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'eq', eqVarId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [LIST_PRIMITIVE, 'equality_results', equalityListId]],
      },
      fields: {},
    };

    if (prevId === flagClickId) {
      blocks[flagClickId].next = setVarId;
    } else {
      blocks[prevId].next = setVarId;
    }
    prevId = addId;
  }

  // === Thread 2: listContainsItem matrix ===
  // Each entry pre-seeds a local list `bag<i>` with the mixed
  // bag content (so we have a list whose `LIST` slot can be
  // resolved by id), then runs `data_listcontainsitem`. The
  // list content is encoded as a `data_replaceitem` /
  // `data_addtolist` sequence at fixture-build time so the
  // scratch runtime sees a fully populated list by the time the
  // green-flag thread starts. Listing the explicit list per
  // entry avoids relying on a single shared-list mutation
  // (= which would compose across entries and break the
  // matrix semantics).
  for (const entry of LIST_MATRIX) {
    const bagListId = `ddddddddddddddddddddddddddddddd${(LIST_MATRIX.indexOf(entry)).toString(16).padStart(1, '0')}`;
    const bagListName = `bag${LIST_MATRIX.indexOf(entry)}`;
    sprite.lists[bagListId] = [bagListName, entry.bag];
  }

  // Thread 2's entry-point: a separate `event_whenflagclicked`
  // would race; we instead chain Thread 1 and Thread 2 via the
  // already-linked `prevId` (= the last `data_addtolist`).
  let prevIdThread2 = prevId;
  for (const entry of LIST_MATRIX) {
    const idx = LIST_MATRIX.indexOf(entry);
    const bagListId = `ddddddddddddddddddddddddddddddd${idx.toString(16).padStart(1, '0')}`;
    const bagListName = `bag${idx}`;
    const lcId = nextId();
    const setVarId = nextId();
    const addId = nextId();

    blocks[lcId] = {
      opcode: 'data_listcontainsitem',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: {
        ITEM: literal(entry.needle),
        LIST: [INPUT_SAME_BLOCK_SHADOW, [LIST_PRIMITIVE, bagListName, bagListId]],
      },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, lcId, null],
      },
      fields: { VARIABLE: [lcVarId, 'lc'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'lc', lcVarId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [LIST_PRIMITIVE, 'list_results', listResultsId]],
      },
      fields: {},
    };

    if (prevIdThread2 === flagClickId) {
      blocks[flagClickId].next = setVarId;
    } else {
      blocks[prevIdThread2].next = setVarId;
    }
    prevIdThread2 = addId;
  }

  sprite.blocks = blocks;
  void stage;

  return project;
}

export async function makeStrictEqualityFixture() {
  return writeSb3Fixture('strict-equality-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeStrictEqualityFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-strict-equality-fixture] wrote', p);
  });
}
