/**
 * Generate `test/.test-fixtures/edge-hat-fixture.sb3`.
 *
 * Phase 1-B target: edge-activated hat sentinel elimination.
 *
 * The fixture builds three edge-activated hat blocks
 * (`event_whengreaterthan`, `event_whenbroadcastreceived`,
 * `event_whenkeypressed`) plus the matching predicate bodies.
 * Each hat predicate toggles a "fire count" variable on the sprite,
 * and the body increments the same counter — so after a single
 * green-flag the runtime hits the patched code path three times
 * with different argument shapes (number / broadcast name / key).
 *
 * Block shape follows the upstream `hat-threads-run-every-frame.js`
 * integration test (compiles under both compiled and interpreted
 * modes).
 */
import {
  defaultProjectJson,
  INPUT_SAME_BLOCK_SHADOW,
  isInvokedDirectly,
  MATH_NUM_PRIMITIVE,
  writeSb3Fixture,
} from './_fixture-base.mjs';

function buildProjectJson() {
  const project = defaultProjectJson({ agent: 'turbowasm-edge-hat' });

  const stage = project.targets[0];
  const sprite = project.targets[1];

  // A timer-shaped variable so the greater-than hat has a predicate
  // to evaluate.
  const timerVarId = 'aabbccddeeffaabbccddeeffaabbccdd';
  sprite.variables = {
    [timerVarId]: ['t', 0],
  };

  // Three broadcast messages so the broadcast hat fires.
  stage.broadcasts = {
    bcastMsg1: ['msg1', null],
  };

  const blocks = {};
  let counter = 100;
  const id = () => String(counter++);

  // Hat 1: when [timer] > 5. The condition is `sensing_timer > 5`
  // which is `event_whengreaterthan`. Body increments a counter.
  const hat1Id = id();
  const hat1BodyId = id();
  const hat1ChangeId = id();
  const hat1VarReadId = id();
  const hat1ChangeVarId = id();
  blocks[hat1Id] = {
    opcode: 'event_whengreaterthan',
    next: hat1BodyId,
    parent: null,
    shadow: false,
    fields: { WHENGREATERTHANMENU: ['TIMER', null] },
    inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, '5']] },
  };
  blocks[hat1BodyId] = {
    opcode: 'data_changevariableby',
    next: null,
    parent: null,
    shadow: false,
    inputs: {
      VALUE: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, '1']],
    },
    fields: { VARIABLE: [timerVarId, 't'] },
  };
  void hat1ChangeId;
  void hat1VarReadId;
  void hat1ChangeVarId;

  // Hat 2: when I receive [msg1]. No predicate — pure event-trigger.
  const hat2Id = id();
  const hat2BodyId = id();
  blocks[hat2Id] = {
    opcode: 'event_whenbroadcastreceived',
    next: hat2BodyId,
    parent: null,
    shadow: false,
    fields: { BROADCAST_OPTION: ['msg1', null] },
    inputs: {},
  };
  blocks[hat2BodyId] = {
    opcode: 'data_changevariableby',
    next: null,
    parent: null,
    shadow: false,
    inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, '1']] },
    fields: { VARIABLE: [timerVarId, 't'] },
  };

  // Hat 3: when [space] key pressed. No predicate.
  const hat3Id = id();
  const hat3BodyId = id();
  blocks[hat3Id] = {
    opcode: 'event_whenkeypressed',
    next: hat3BodyId,
    parent: null,
    shadow: false,
    fields: { KEY_OPTION: ['space', null] },
    inputs: {},
  };
  blocks[hat3BodyId] = {
    opcode: 'data_changevariableby',
    next: null,
    parent: null,
    shadow: false,
    inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, '1']] },
    fields: { VARIABLE: [timerVarId, 't'] },
  };

  sprite.blocks = blocks;
  void stage;

  return project;
}

export async function makeEdgeHatFixture() {
  return writeSb3Fixture('edge-hat-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeEdgeHatFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-edge-hat-fixture] wrote', p);
  });
}