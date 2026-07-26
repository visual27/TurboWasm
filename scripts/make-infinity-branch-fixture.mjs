/**
 * Generate `test/.test-fixtures/infinity-branch-fixture.sb3`.
 *
 * Phase 1-C target: Infinity branch removal in Cast.compare.
 *
 * The fixture is a single sprite whose `when flag clicked` script
 * runs every Infinity combination through `operator_lt` /
 * `operator_gt` / `operator_equals` (= the three call-sites of
 * `Cast.compare`) and stores the result in a list. The runtime
 * therefore exercises the patched path with edge inputs that
 * specifically would have hit the legacy
 * `(n1 === Infinity && n2 === Infinity) || ...` special branch:
 *
 *  - Infinity === Infinity       (legacy special branch returns 0)
 *  - -Infinity === -Infinity     (legacy special branch returns 0)
 *  - Infinity  >  -Infinity      (subtraction path returns Infinity)
 *  - -Infinity <  Infinity       (subtraction path returns -Infinity)
 *  - Infinity  >  finite         (subtraction path returns Infinity)
 *  - finite  <  Infinity         (subtraction path returns -Infinity)
 *  - -Infinity <  finite         (subtraction path returns -Infinity)
 *  - finite  >  -Infinity        (subtraction path returns Infinity)
 */
import {
  defaultProjectJson,
  INPUT_SAME_BLOCK_SHADOW,
  isInvokedDirectly,
  LIST_PRIMITIVE,
  MATH_NUM_PRIMITIVE,
  writeSb3Fixture,
} from './_fixture-base.mjs';

/**
 * Eight entries that exhaustively cover the Infinity signed-arithmetic
 * surface that the legacy `Infinity === Infinity` branch protected.
 */
const COMPARISONS = [
  { op: 'operator_equals', lhs: Infinity, rhs: Infinity, expected: 0 },
  { op: 'operator_equals', lhs: -Infinity, rhs: -Infinity, expected: 0 },
  { op: 'operator_equals', lhs: Infinity, rhs: -Infinity, expected: 1 },
  { op: 'operator_equals', lhs: -Infinity, rhs: Infinity, expected: -1 },
  { op: 'operator_gt', lhs: Infinity, rhs: -Infinity, expected: 1 },
  { op: 'operator_gt', lhs: Infinity, rhs: 0, expected: 1 },
  { op: 'operator_gt', lhs: -Infinity, rhs: 0, expected: -1 },
  { op: 'operator_gt', lhs: 0, rhs: Infinity, expected: -1 },
];

function literal(value) {
  if (typeof value === 'number') {
    return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
  }
  return [INPUT_SAME_BLOCK_SHADOW, [TEXT_PRIMITIVE, value]];
}

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-infinity-branch' });

  const stage = project.targets[0];
  const sprite = project.targets[1];

  const listId = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0';
  const listName = 'results';
  sprite.lists = {
    [listId]: [listName, []],
  };

  const blocks = {};
  let counter = 100;
  const id = () => String(counter++);

  const flagClickId = id();
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

  let prevId = flagClickId;
  for (const c of COMPARISONS) {
    const compareId = id();
    const addId = id();
    blocks[compareId] = {
      opcode: c.op,
      next: addId,
      parent: null,
      shadow: false,
      inputs: {
        OPERAND1: literal(c.lhs),
        OPERAND2: literal(c.rhs),
      },
      fields: {},
    };
    blocks[addId] = {
      opcode: 'data_addtolist',
      next: null,
      parent: null,
      shadow: false,
      inputs: {
        ITEM: [INPUT_SAME_BLOCK_SHADOW, compareId, null],
        LIST: [INPUT_SAME_BLOCK_SHADOW, [LIST_PRIMITIVE, listName, listId]],
      },
      fields: {},
    };
    if (prevId === flagClickId) {
      blocks[flagClickId].next = compareId;
    } else {
      blocks[prevId].next = compareId;
    }
    prevId = addId;
  }

  sprite.blocks = blocks;
  void stage;

  return project;
}

export async function makeInfinityBranchFixture() {
  return writeSb3Fixture('infinity-branch-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeInfinityBranchFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-infinity-branch-fixture] wrote', p);
  });
}