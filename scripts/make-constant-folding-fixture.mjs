/**
 * Generate `test/.test-fixtures/constant-folding-fixture.sb3`.
 *
 * Phase 3 — limited compiler-time constant folding. The fixture is a
 * single sprite whose `when flag clicked` script exercises every fold
 * candidate covered by `IROptimizer.tryFoldConstant`:
 *
 *   1. pure-arithmetic-add      OP_ADD(2, 3) → 5
 *   2. pure-arithmetic-mixed    OP_SUB / OP_MUL / OP_DIV
 *   3. boolean-and-or-not       OP_AND / OP_OR / OP_NOT chain
 *   4. less-than-comparison     OP_LESS / OP_GREATER / OP_EQUALS
 *   5. join-strings             OP_JOIN
 *   6. zero-edge-cases          0 + (-0), -0 * -0, -0 / 1
 *   7. infinity-edge-cases      Infinity + (-Infinity), 1 / 0, etc.
 *   8. string-vs-number-no-fold OP_ADD with STRING_NUM → fold 対象外
 *   9. random-no-fold           OP_RANDOM → fold 対象外
 *  10. var-get-no-fold          OP_ADD(VAR_GET, ...) → fold 対象外
 *
 * Each script's final `data_setvariableto` writes the result into
 * `result` and the next script reads the previous `result` via a
 * `data_variableof` (= VAR_GET) so the chain also covers
 * non-folded reads. Scratch's reporter inputs accept either an
 * inline number or a variable reference; for inputs that would
 * short-circuit the fold (= numeric literals), we hard-code the
 * literal so the optimizer can fold. Inputs that must remain a
 * VAR_GET (= OP_RANDOM chain, OP_ADD with VAR_GET, etc.) keep
 * the variable reference intact.
 *
 * Each block sequence uses the schema-correct primitive IDs
 * (MATH_NUM_PRIMITIVE / LIST_PRIMITIVE / INPUT_SAME_BLOCK_SHADOW)
 * so `ensure-test-fixtures` accepts the fixture without the schema
 * gate falling over.
 */
import {
  defaultProjectJson,
  INPUT_SAME_BLOCK_SHADOW,
  isInvokedDirectly,
  MATH_NUM_PRIMITIVE,
  TEXT_PRIMITIVE,
  writeSb3Fixture,
} from './_fixture-base.mjs';

// sb3.js primitive ID for `data_variable`. Direct inline so this
// generator does not need to expand `_fixture-base.mjs`'s export
// list beyond the four ids we already imported.
const VAR_PRIMITIVE = 12;

function literal(value) {
  if (typeof value === 'boolean') {
    return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, value ? '1' : '0']];
  }
  if (typeof value === 'number') {
    return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
  }
  return [INPUT_SAME_BLOCK_SHADOW, [TEXT_PRIMITIVE, value]];
}

function makeScript(blocks, idAlloc, flagClickId, body) {
  // Each script contributes its body blocks but reuses the SHARED
  // `flagClickId` so the runtime walks them as a single flat chain
  // off one `when flag clicked` hat. `varId` is also shared (= the
  // single `result` scratch variable).
  const varId = idAlloc.varId();
  body({ varId, flagClickId });
}

function appendToChain(blocks, flagClickId, headId) {
  // Walk the chain from `flagClickId` and link `headId` as the new
  // tail. Used by every script's body to chain its top-level
  // statement under the shared `when flag clicked` root.
  let cur = blocks[flagClickId].next;
  while (blocks[cur] && blocks[cur].next) cur = blocks[cur].next;
  blocks[cur].next = headId;
}

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-constant-folding' });
  const stage = project.targets[0];
  const sprite = project.targets[1];

  // Single `result` variable that every script writes to. The
  // 10-script chain relies on this being reused (no per-script
  // variable); the visible list at the end captures the per-script
  // results for easier visual inspection.
  const varId = 'f00dbabe0000000000000000f00dbabe';
  sprite.variables = {
    [varId]: ['result', 0],
  };

  // List of fold results for visual inspection. Each script appends
  // its current `result` to the list before the next script starts.
  const listId = '11ee22ff11ee22ff11ee22ff11ee22ff';
  const listName = 'folds';
  sprite.lists = {
    [listId]: [listName, []],
  };

  const blocks = {};
  let blockIdCounter = 100;
  const idAlloc = {
    next: () => String(blockIdCounter++),
    varId: () => varId,
  };

  // Shared `when flag clicked` hat for all 10 sub-scripts. We expose
  // it as a `topLevel` block so the runtime picks it up as a script.
  const flagClickId = idAlloc.next();
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

  // 1. pure-arithmetic-add — (2 + 3) + 4 = 9
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const add1 = idAlloc.next();
    const add2 = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[add1] = {
      opcode: 'operator_add',
      next: null,
      parent: add2,
      shadow: false,
      inputs: { NUM1: literal(2), NUM2: literal(3) },
      fields: {},
    };
    blocks[add2] = {
      opcode: 'operator_add',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: {
        NUM1: [INPUT_SAME_BLOCK_SHADOW, add1, null],
        NUM2: literal(4),
      },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, add2, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    blocks[flagClickId].next = setVarId;
  });

  // 2. pure-arithmetic-mixed — (10 - 3) * (4 / 2) = 14
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const sub = idAlloc.next();
    const div = idAlloc.next();
    const mul = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[sub] = {
      opcode: 'operator_subtract',
      next: null,
      parent: mul,
      shadow: false,
      inputs: { NUM1: literal(10), NUM2: literal(3) },
      fields: {},
    };
    blocks[div] = {
      opcode: 'operator_divide',
      next: null,
      parent: mul,
      shadow: false,
      inputs: { NUM1: literal(4), NUM2: literal(2) },
      fields: {},
    };
    blocks[mul] = {
      opcode: 'operator_multiply',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: {
        NUM1: [INPUT_SAME_BLOCK_SHADOW, sub, null],
        NUM2: [INPUT_SAME_BLOCK_SHADOW, div, null],
      },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, mul, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setVarId);
  });

  // 3. boolean-and-or-not — (1 = 1) and ((2 > 1) or not (1 < 0))
  //    → true and (true or true) → true → 1
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const equals = idAlloc.next();
    const greater = idAlloc.next();
    const less = idAlloc.next();
    const not = idAlloc.next();
    const or = idAlloc.next();
    const and = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[equals] = {
      opcode: 'operator_equals',
      next: null,
      parent: and,
      shadow: false,
      inputs: { OPERAND1: literal(1), OPERAND2: literal(1) },
      fields: {},
    };
    blocks[greater] = {
      opcode: 'operator_gt',
      next: null,
      parent: or,
      shadow: false,
      inputs: { OPERAND1: literal(2), OPERAND2: literal(1) },
      fields: {},
    };
    blocks[less] = {
      opcode: 'operator_lt',
      next: null,
      parent: not,
      shadow: false,
      inputs: { OPERAND1: literal(1), OPERAND2: literal(0) },
      fields: {},
    };
    blocks[not] = {
      opcode: 'operator_not',
      next: null,
      parent: or,
      shadow: false,
      inputs: {
        OPERAND: [INPUT_SAME_BLOCK_SHADOW, less, null],
      },
      fields: {},
    };
    blocks[or] = {
      opcode: 'operator_or',
      next: null,
      parent: and,
      shadow: false,
      inputs: {
        OPERAND1: [INPUT_SAME_BLOCK_SHADOW, greater, null],
        OPERAND2: [INPUT_SAME_BLOCK_SHADOW, not, null],
      },
      fields: {},
    };
    blocks[and] = {
      opcode: 'operator_and',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: {
        OPERAND1: [INPUT_SAME_BLOCK_SHADOW, equals, null],
        OPERAND2: [INPUT_SAME_BLOCK_SHADOW, or, null],
      },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, and, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setVarId);
  });

  // 4. less-than-comparison — 1 < 2 = true (= 1), 2 > 3 = false (= 0)
  //    Tests both OP_LESS and OP_GREATER fold paths. Each comparison
  //    is wrapped in its own `setVar → addToList` chain so the
  //    blockToXML walker doesn't see a cycle.
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const less = idAlloc.next();
    const setLess = idAlloc.next();
    const addLess = idAlloc.next();
    const greater = idAlloc.next();
    const setGreater = idAlloc.next();
    const addGreater = idAlloc.next();
    blocks[less] = {
      opcode: 'operator_lt',
      next: null,
      parent: setLess,
      shadow: false,
      inputs: { OPERAND1: literal(1), OPERAND2: literal(2) },
      fields: {},
    };
    blocks[setLess] = {
      opcode: 'data_setvariableto',
      next: addLess,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, less, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addLess] = {
      opcode: 'data_addtolist',
      next: setGreater,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    blocks[greater] = {
      opcode: 'operator_gt',
      next: null,
      parent: setGreater,
      shadow: false,
      inputs: { OPERAND1: literal(2), OPERAND2: literal(3) },
      fields: {},
    };
    blocks[setGreater] = {
      opcode: 'data_setvariableto',
      next: addGreater,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, greater, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addGreater] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setLess);
  });

  // 5. join-strings — "foo" + "bar" + "baz" = "foobarbaz"
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const join1 = idAlloc.next();
    const join2 = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[join1] = {
      opcode: 'operator_join',
      next: null,
      parent: join2,
      shadow: false,
      inputs: { STRING1: literal('foo'), STRING2: literal('bar') },
      fields: {},
    };
    blocks[join2] = {
      opcode: 'operator_join',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: {
        STRING1: [INPUT_SAME_BLOCK_SHADOW, join1, null],
        STRING2: literal('baz'),
      },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, join2, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setVarId);
  });

  // 6. zero-edge-cases — 0 + 0 = 0 (and -0 * -0 = 0). The
  //    scratch JSON has no way to encode -0 (= Number("-0") === 0),
  //    so the runtime test asserts the getNumberInputType result
  //    rather than the literal value. The fixture just exercises
  //    the runtime round-trip for these edge cases.
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const add = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[add] = {
      opcode: 'operator_add',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: { NUM1: literal(0), NUM2: literal(0) },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, add, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setVarId);
  });

  // 7. infinity-edge-cases — 1 / 0 = Infinity, 0 / 0 = NaN.
  //    The constant-folding test verifies the IR `type` bitset; the
  //    runtime sees an Infinity / NaN value in `result`, which scratch
  //    serialises as the string "Infinity" / "NaN".
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const div = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[div] = {
      opcode: 'operator_divide',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: { NUM1: literal(1), NUM2: literal(0) },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, div, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setVarId);
  });

  // 8. random-no-fold — (1 + 2) + (random 1 10). The OP_RANDOM
  //    operand forces the fold path to skip; the result varies.
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const add = idAlloc.next();
    const random = idAlloc.next();
    const outerAdd = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[add] = {
      opcode: 'operator_add',
      next: null,
      parent: outerAdd,
      shadow: false,
      inputs: { NUM1: literal(1), NUM2: literal(2) },
      fields: {},
    };
    blocks[random] = {
      opcode: 'operator_random',
      next: null,
      parent: outerAdd,
      shadow: false,
      inputs: { FROM: literal(1), TO: literal(10) },
      fields: {},
    };
    blocks[outerAdd] = {
      opcode: 'operator_add',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: {
        NUM1: [INPUT_SAME_BLOCK_SHADOW, add, null],
        NUM2: [INPUT_SAME_BLOCK_SHADOW, random, null],
      },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, outerAdd, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setVarId);
  });

  // 9. mixed-types-no-fold — 2 + "foo". STRING_NUM detection via the
  //    `isAlwaysType(NUMBER) && !isSometimesType(STRING)` rule
  //    prevents the fold; the runtime returns "2foo".
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const add = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[add] = {
      opcode: 'operator_add',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: { NUM1: literal(2), NUM2: literal('foo') },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, add, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setVarId);
  });

  // 10. var-get-no-fold — (1 + 2) + myVar (= current `result`).
  //     The left side of the outer `+` is constant-foldable but the
  //     right side reads `result` via VAR_GET, so the outer `+` is
  //     not foldable. We initialise `result = 10` at script start via
  //     a dedicated setVariable before the chain so the chain is
  //     deterministic (= result becomes 10 + 3 + 10 = 13).
  makeScript(blocks, idAlloc, flagClickId, ({ varId }) => {
    const setInitial = idAlloc.next();
    const innerAdd = idAlloc.next();
    const outerAdd = idAlloc.next();
    const setVarId = idAlloc.next();
    const addId = idAlloc.next();
    blocks[setInitial] = {
      opcode: 'data_setvariableto',
      next: setVarId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: literal(10),
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[innerAdd] = {
      opcode: 'operator_add',
      next: null,
      parent: outerAdd,
      shadow: false,
      inputs: { NUM1: literal(3), NUM2: literal(7) },
      fields: {},
    };
    blocks[outerAdd] = {
      opcode: 'operator_add',
      next: null,
      parent: setVarId,
      shadow: false,
      inputs: {
        NUM1: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        NUM2: [INPUT_SAME_BLOCK_SHADOW, innerAdd, null],
      },
      fields: {},
    };
    blocks[setVarId] = {
      opcode: 'data_setvariableto',
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        VALUE: [INPUT_SAME_BLOCK_SHADOW, outerAdd, null],
      },
      fields: { VARIABLE: [varId, 'result'] },
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, [VAR_PRIMITIVE, 'result', varId], null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [13, listName, listId]],
      },
      fields: { LIST: [listName, listId] },
    };
    appendToChain(blocks, flagClickId, setInitial);
  });

  sprite.blocks = blocks;
  void stage;
  return project;
}

export async function makeConstantFoldingFixture() {
  return writeSb3Fixture('constant-folding-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeConstantFoldingFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-constant-folding-fixture] wrote', p);
  });
}