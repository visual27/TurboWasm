/**
 * Generate `test/.test-fixtures/compare-equal-fixture.sb3`.
 *
 * Phase 1-A target: compareEqual short-circuit (NaN/Infinity/-0/型混在).
 *
 * The fixture is a single sprite whose `when flag clicked` script
 * runs a chain of `operator_equals` calls — one per test case in the
 * VALUES matrix below — and stores each boolean result in a list
 * named `results`. Each result feeds a follow-up
 * `data_addtolist(ITEM=result, LIST=results)` so the runtime
 * exercises `compareEqual` on every entry.
 *
 * Block shape uses the schema-correct primitive IDs
 * (`MATH_NUM_PRIMITIVE`, `LIST_PRIMITIVE`, `INPUT_SAME_BLOCK_SHADOW`)
 * so `ensure-test-fixtures` accepts the fixture without the schema
 * gate falling over.
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
 * Twelve carefully-chosen `operator_equals` cases that cover every
 * branch of the new short-circuit implementation. The full upstream
 * `VALUES` matrix (32 entries → 1024 pairs) is impractical in a
 * scratch script, but these twelve exercise:
 *  - identical finite numbers      (fast path: v1 === v2)
 *  - different finite numbers      (fast path: typeof both number)
 *  - identical Infinity pairs      (fast path: v1 === v2)
 *  - Infinity vs finite            (fast path: typeof both number)
 *  - mixed type operands           (slow path: compareEqualSlow)
 *  - identical strings             (fast path: v1 === v2)
 *  - case-different strings        (slow path: case-insensitive)
 *  - string vs number              (slow path: scratch coercion)
 *  - boolean pairs                 (slow path: '5' == 5, etc.)
 */
const VALUES = [
  [1, 1], // true (fast: v1 === v2)
  [1, 2], // false (fast: typeof both number)
  [0, -0], // true (fast: v1 === v2)
  [Infinity, Infinity], // true (fast: v1 === v2)
  [-Infinity, -Infinity], // true
  [Infinity, 1], // false (fast: typeof both number)
  [-Infinity, 1], // false
  ['hello', 'hello'], // true (fast: v1 === v2)
  ['hello', 'HELLO'], // true (slow: case-insensitive)
  ['5', 5], // true (slow: scratch coercion)
  ['', 0], // true (slow: scratch coercion)
  [42, 42], // true (fast: v1 === v2)
];

/**
 * Encode a literal value for an `operator_equals` input slot.
 * Numbers become `MATH_NUM_PRIMITIVE` shadow blocks; strings become
 * `TEXT_PRIMITIVE` shadow blocks (sb3.js primitive ID 10). Booleans
 * are encoded as `MATH_NUM_PRIMITIVE` shadows of `'1'` / `'0'`
 * because the sb3 schema does not expose a boolean primitive and
 * scratch treats `'1' === true` via the legacy `compareEqualSlow`
 * coercion path — which is exactly what we want to exercise.
 */
function literal(value) {
  if (typeof value === 'boolean') {
    return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, value ? '1' : '0']];
  }
  if (typeof value === 'number') {
    return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
  }
  return [INPUT_SAME_BLOCK_SHADOW, [TEXT_PRIMITIVE, value]];
}

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-compare-equal' });

  const stage = project.targets[0];
  const sprite = project.targets[1];

  // The runtime list that collects the per-pair results.
  const listId = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0';
  const listName = 'results';
  sprite.lists = {
    [listId]: [listName, []],
  };

  // Threading the equals result into the add-to-list block through a
  // scratch variable breaks the input-position / chain-link cycle that
  // would otherwise recurse `Blocks.blockToXML` to death. The chain
  // becomes:
  //
  //   setVar<eq> to (operator_equals(...))  -- chain link
  //     └─ operator_equals                  -- shadow input, next:null
  //   add (eq) to <list>                    -- chain link
  //     └─ VAR_PRIMITIVE shadow of <eq>
  //
  const varId = 'aabbccddeeffaabbccddeeffaabb0001';
  sprite.variables = {
    [varId]: ['eq', 0],
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

  // sb3.js primitive ID for `data_variable`. Direct inline here so
  // this fixture does not need to expand `_fixture-base.mjs`'s
  // export list beyond the four ids we already imported.
  const VAR_PRIMITIVE = 12;

  let prevId = flagClickId;
  for (const pair of VALUES) {
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
      fields: { VARIABLE: [varId, 'eq'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'eq', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [LIST_PRIMITIVE, listName, listId]],
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

  sprite.blocks = blocks;
  void stage;

  return project;
}

export async function makeCompareEqualFixture() {
  return writeSb3Fixture('compare-equal-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeCompareEqualFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-compare-equal-fixture] wrote', p);
  });
}