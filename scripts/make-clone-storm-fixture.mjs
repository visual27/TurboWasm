/**
 * Generate `test/.test-fixtures/clone-storm-fixture.sb3`.
 *
 * §Phase 5 (scheduler research) — high-frequency thread churn fixture.
 * Drives the Sequencer.stepThreads in-place compaction loop (= the
 * `stoppedThread` branch at `sequencer.js:165-179`) and the
 * Runtime._step pre-step `isKilled` compaction (= the patched
 * `runtime.js:2582-2607`) at every step.
 *
 * Layout
 * ------
 * - Stage: `when flag clicked` → `forever` → `repeat (10)` →
 *   `broadcast tick`. Ten broadcasts per frame keeps the broadcast
 *   hot path saturated without blowing up the per-step broadcast
 *   queue.
 * - One Sprite ("Clone") with three scripts:
 *     1. `when flag clicked` → `repeat (50)` → `create clone of
 *        myself`. Saturates the clone count to 50 (= one clone per
 *        repeat iteration, all dispatched in the first ~10 frames
 *        because the body has no `wait` block).
 *     2. `when I start as a clone` → `repeat (5)` → `delete this
 *        clone`. Each clone runs its body in the same step it was
 *        created (= no `wait` block) and is killed before the
 *        next step's pre-step compaction runs.
 *     3. `when I receive tick` → `repeat (3)` → `change x by 1`.
 *        Each tick broadcast spawns one thread per existing
 *        sprite (= Stage + Clone + any clones at that moment); each
 *        thread runs in a single step and terminates.
 *
 * Why no `wait` blocks?
 * ---------------------
 * scratch-vm's `control_wait` block initialises a per-stack-frame
 * timer; for `DURATION = 0` the timer is "finished" on the very
 * next pass, so a `wait 0 sec` body actually executes inline
 * (= no real frame yield). Using waits to spread the work across
 * frames therefore doesn't help and adds noise; we let each
 * `repeat` body run as a single step's worth of work, which
 * produces a clean steady-state of "spawn N threads per frame,
 * terminate them all before the next frame's pre-step compaction".
 *
 * Steady state
 * ------------
 * Once the 50 clones have been created (= ~10 frames in), each
 * step sees:
 *   - 10 × (1 stage + 1 sprite + 50 clones) ≈ 520 tick threads
 *     started in one frame.
 *   - All 520 terminate in the same step (= `repeat (3) → change
 *     x by 1` body has no yields and the clone's lifetime loop
 *     is infinite so no clones are killed mid-frame).
 *   - Meanwhile the Stage's forever loop keeps broadcasting, so
 *     the 520-thread churn is sustained frame after frame.
 *
 * That is ~520 thread ends/step, which exercises the sequencer
 * `doneThreads.push` / `threadMap.delete` path inside the inner
 * `stoppedThread` compaction loop ~520 times per step. The
 * pre-step `isKilled` compaction at `runtime.js:2582-2607` is
 * exercised only at project-load boundary (= no thread ever
 * sets `isKilled` mid-run), so eval-A vs eval-B differs primarily
 * on the sequencer-side compaction cost.
 *
 * Verdict signal
 * --------------
 * - baseline vs eval-A: at steady state the only meaningful
 *   difference is which function owns the compaction loop. Wall
 *   time at 600 steps is dominated by the compaction itself
 *   (= 500 in-place removals × 600 steps = 300k iterations of the
 *   inner filter loop), so the spread is large enough to surface
 *   a real winner if one exists.
 * - eval-B: removes the Runtime._step pre-step compaction and
 *   extends Sequencer compaction to `isKilled`. Same observable
 *   threads, fewer total compaction passes per step.
 */
import {
  defaultProjectJson,
  INPUT_SAME_BLOCK_SHADOW,
  MATH_NUM_PRIMITIVE,
  isInvokedDirectly,
  writeSb3Fixture,
} from './_fixture-base.mjs';

const CLONE_OPTION_MENU = 'control_create_clone_of_menu';
const BROADCAST_RECEIVE_MENU = 'event_broadcastreceived_menu';

const TICK_BROADCAST_ID = 'cc11cc11cc11cc11cc11cc11cc11cc11';
const TICK_BROADCAST_NAME = 'tick';

const NUM_CLONES = 50;
const TICK_BROADCASTS_PER_FRAME = 10;
const TICK_THREAD_LENGTH_ITERATIONS = 3;

let nextBlockNum = 1000;
const nextBlockId = () => `b${nextBlockNum++}`;

/**
 * Shadow-only input for `BROADCAST_INPUT` / `CLONE_OPTION`.
 *
 * scratch-vm's `execute.js:337-358` handles the `BROADCAST_INPUT`
 * slot specially: it only copies the shadow's `BROADCAST_OPTION`
 * field into `args.BROADCAST_OPTION` when
 * `broadcastInput.block === broadcastInput.shadow`. The
 * deserializer (`sb3.js:953`) sets `shadow = null` when the
 * input descriptor is `INPUT_BLOCK_NO_SHADOW`, which makes the
 * equality check fail and leaves `args.BROADCAST_OPTION = { id:
 * null, name: null }` (= the empty default). The fix is to use
 * `INPUT_SAME_BLOCK_SHADOW` (= 1) so both `block` and `shadow`
 * resolve to the same shadow block id at deserialize time.
 */
function shadowInput(blockId) {
  return [INPUT_SAME_BLOCK_SHADOW, blockId];
}

function inlineNum(value) {
  return [INPUT_SAME_BLOCK_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
}

function buildProjectJson() {
  const project = defaultProjectJson({
    agent: 'turbowasm-clone-storm',
    spriteName: 'Clone',
  });
  const stage = project.targets[0];
  const sprite = project.targets[1];

  // Broadcast registered on the Stage. The sb3 loader reads
  // `target.broadcasts` and converts each entry into a Variable
  // with `BROADCAST_MESSAGE_TYPE`, indexed in `target.variables[id]`.
  // The Stage carries the registration because that's where the
  // broadcaster lives; sprite-side `event_whenbroadcastreceived`
  // blocks still find it via
  // `runtime.getTargetForStage().lookupBroadcastByInputValue`.
  stage.broadcasts = {
    [TICK_BROADCAST_ID]: TICK_BROADCAST_NAME,
  };

  const stageBlocks = {};
  const spriteBlocks = {};
  const spriteXVar = 'd00dd00dd00dd00dd00dd00dd00d0001';
  sprite.variables = {
    [spriteXVar]: ['x', 0],
  };

  // --- Stage: when flag clicked → forever → repeat (10) → broadcast tick
  const stageFlagId = nextBlockId();
  const stageForeverId = nextBlockId();
  const stageRepeatId = nextBlockId();
  const stageBroadcastId = nextBlockId();
  const stageBroadcastShadowId = nextBlockId();

  stageBlocks[stageFlagId] = {
    opcode: 'event_whenflagclicked',
    next: stageForeverId,
    topLevel: true,
    parent: null,
    shadow: false,
    x: 0,
    y: 0,
    inputs: {},
    fields: {},
  };
  stageBlocks[stageForeverId] = {
    opcode: 'control_forever',
    next: null,
    parent: stageFlagId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: { SUBSTACK: shadowInput(stageRepeatId) },
    fields: {},
  };
  stageBlocks[stageRepeatId] = {
    opcode: 'control_repeat',
    next: null,
    parent: stageForeverId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: {
      TIMES: inlineNum(TICK_BROADCASTS_PER_FRAME),
      SUBSTACK: shadowInput(stageBroadcastId),
    },
    fields: {},
  };
  stageBlocks[stageBroadcastId] = {
    opcode: 'event_broadcast',
    next: null,
    parent: stageRepeatId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: { BROADCAST_INPUT: shadowInput(stageBroadcastShadowId) },
    fields: {},
  };
  stageBlocks[stageBroadcastShadowId] = {
    opcode: 'event_broadcast_menu',
    next: null,
    parent: stageBroadcastId,
    topLevel: false,
    shadow: true,
    x: 0,
    y: 0,
    inputs: {},
    fields: { BROADCAST_OPTION: [TICK_BROADCAST_NAME, TICK_BROADCAST_ID] },
  };

  // --- Sprite: when flag clicked → repeat (50) → create clone of (myself)
  const spriteFlagId = nextBlockId();
  const spriteCreateRepeatId = nextBlockId();
  const spriteCreateCloneId = nextBlockId();
  const spriteCreateCloneShadowId = nextBlockId();

  spriteBlocks[spriteFlagId] = {
    opcode: 'event_whenflagclicked',
    next: spriteCreateRepeatId,
    topLevel: true,
    parent: null,
    shadow: false,
    x: 0,
    y: 200,
    inputs: {},
    fields: {},
  };
  spriteBlocks[spriteCreateRepeatId] = {
    opcode: 'control_repeat',
    next: null,
    parent: spriteFlagId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: {
      TIMES: inlineNum(NUM_CLONES),
      SUBSTACK: shadowInput(spriteCreateCloneId),
    },
    fields: {},
  };
  spriteBlocks[spriteCreateCloneId] = {
    opcode: 'control_create_clone_of',
    next: null,
    parent: spriteCreateRepeatId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: { CLONE_OPTION: shadowInput(spriteCreateCloneShadowId) },
    fields: {},
  };
  spriteBlocks[spriteCreateCloneShadowId] = {
    opcode: CLONE_OPTION_MENU,
    next: null,
    parent: spriteCreateCloneId,
    topLevel: false,
    shadow: true,
    x: 0,
    y: 0,
    inputs: {},
    fields: { CLONE_OPTION: ['_myself_', null] },
  };

  // --- Sprite: when I start as a clone → forever → change x by 1
  // Clones are long-lived so 50 of them accumulate; compaction
  // churn is driven entirely by the `when I receive tick` thread
  // explosion below. The infinite loop has no body-level yield,
  // so it stays in `STATUS_RUNNING` and never enters the
  // compaction path on its own.
  const spriteStartCloneId = nextBlockId();
  const spriteLifetimeForeverId = nextBlockId();
  const spriteLifetimeChangeXId = nextBlockId();

  spriteBlocks[spriteStartCloneId] = {
    opcode: 'control_start_as_clone',
    next: spriteLifetimeForeverId,
    topLevel: true,
    parent: null,
    shadow: false,
    x: 0,
    y: 400,
    inputs: {},
    fields: {},
  };
  spriteBlocks[spriteLifetimeForeverId] = {
    opcode: 'control_forever',
    next: null,
    parent: spriteStartCloneId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: { SUBSTACK: shadowInput(spriteLifetimeChangeXId) },
    fields: {},
  };
  spriteBlocks[spriteLifetimeChangeXId] = {
    opcode: 'motion_changexby',
    next: null,
    parent: spriteLifetimeForeverId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: { DX: inlineNum(1) },
    fields: {},
  };

  // --- Sprite: when I receive tick → repeat (3) → change x by 1
  const spriteTickId = nextBlockId();
  const spriteTickShadowId = nextBlockId();
  const spriteTickRepeatId = nextBlockId();
  const spriteTickChangeXId = nextBlockId();

  spriteBlocks[spriteTickId] = {
    opcode: 'event_whenbroadcastreceived',
    next: spriteTickRepeatId,
    topLevel: true,
    parent: null,
    shadow: false,
    x: 0,
    y: 600,
    inputs: { BROADCAST_OPTION: shadowInput(spriteTickShadowId) },
    fields: {},
  };
  spriteBlocks[spriteTickShadowId] = {
    opcode: BROADCAST_RECEIVE_MENU,
    next: null,
    parent: spriteTickId,
    topLevel: false,
    shadow: true,
    x: 0,
    y: 0,
    inputs: {},
    fields: { BROADCAST_OPTION: [TICK_BROADCAST_NAME, TICK_BROADCAST_ID] },
  };
  spriteBlocks[spriteTickRepeatId] = {
    opcode: 'control_repeat',
    next: null,
    parent: spriteTickId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: {
      TIMES: inlineNum(TICK_THREAD_LENGTH_ITERATIONS),
      SUBSTACK: shadowInput(spriteTickChangeXId),
    },
    fields: {},
  };
  spriteBlocks[spriteTickChangeXId] = {
    opcode: 'motion_changexby',
    next: null,
    parent: spriteTickRepeatId,
    topLevel: false,
    shadow: false,
    x: 0,
    y: 0,
    inputs: { DX: inlineNum(1) },
    fields: {},
  };

  stage.blocks = stageBlocks;
  sprite.blocks = spriteBlocks;
  return project;
}

export async function makeCloneStormFixture() {
  return writeSb3Fixture('clone-storm-fixture.sb3', buildProjectJson());
}

if (isInvokedDirectly()) {
  makeCloneStormFixture().then((p) => {
    // eslint-disable-next-line no-console
    console.log('[make-clone-storm-fixture] wrote', p);
  });
}