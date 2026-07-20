/**
 * Generate `gpu-kernel-diagnostics-fixture.sb3`.
 *
 * §Phase 5 §15.9 / §15.14 + §Phase 3 — the diagnostics fixture is
 * intentionally the FIRST GPU-kernel fixture whose primary purpose is to
 * surface diagnostics in `ErrorLogPanel`. Triggers in a single sprite:
 *
 *   1. Two `control_repeat` blocks both carrying `@compute` comments
 *      on distinct entry blocks. Under Phase 3 both regions are
 *      adopted — no `MULTIPLE_COMPUTE_REGIONS`. The fixture now relies
 *      on triggers 2 + 3 to produce diagnostics.
 *
 *   2. The surviving region declares `@bind let(0) ro f32` AND
 *      `@bind foo(0) ro f32`. The `let` collides with a WGSL reserved
 *      keyword so the emitter renames it and emits
 *      `gpu.identifier_collision` (severity `warn`). The two
 *      `@bind` directives also collide on slot 0 within the same
 *      region, surfacing `gpu.bind_slot_collision` (severity `error`,
 *      D1 demote via `PARSER_ERROR_CODES`).
 *
 *   3. The shared `forwardGpuDiagnostics` helper routes the warn
 *      into `useErrorLogStore` (panel filters it out — the existing
 *      `severity === 'error'` UI policy is preserved) while the
 *      error drives the panel's "1 error" UI.
 *
 * The fixture is intentionally minimal: a single sprite, one Stage
 * target with the three scratch lists required by the `@bind`
 * declarations, and the two `control_repeat`s sharing the same parent
 * (`event_whenflagclicked`) so the second `@compute` comment's
 * candidate does not nest the first.
 */
import JSZip from 'jszip';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/.test-fixtures');
const outPath = resolve(outDir, 'gpu-kernel-diagnostics-fixture.sb3');

const INPUT_BLOCK_NO_SHADOW = 2;
const MATH_NUM_PRIMITIVE = 4;

let nextBlockId = 1;
const nextId = () => `b${nextBlockId++}`;
function resetCounter() {
  nextBlockId = 1;
}

function listShadow(listName) {
  return [INPUT_BLOCK_NO_SHADOW, listName];
}

function makeBlock({ opcode, inputs = {}, fields = {}, next = null, parent = null, topLevel = false, shadow = false, x = 0, y = 0 }) {
  const id = nextId();
  return {
    id,
    block: { id, opcode, inputs, fields, next, parent, topLevel, shadow, x, y },
  };
}

function whenFlagClicked() {
  return makeBlock({ opcode: 'event_whenflagclicked', topLevel: true, x: 200, y: 50 });
}

function mathNumber(value, parent = null) {
  return makeBlock({
    opcode: 'math_number',
    fields: { NUM: [value, null] },
    parent,
    shadow: true,
  });
}

function dataSetVarTo(varName, valueBlockId, parent = null) {
  const { id, block } = makeBlock({
    opcode: 'data_setvariableto',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
    fields: { VARIABLE: [varName, null] },
    parent,
  });
  return { id, block };
}

function dataVariable(varName, parent = null) {
  return makeBlock({
    opcode: 'data_variable',
    fields: { VARIABLE: [varName, null] },
    parent,
  });
}

function dataReplaceItemOfList(listName, indexBlockId, valueBlockId, parent = null) {
  return makeBlock({
    opcode: 'data_replaceitemoflist',
    inputs: {
      LIST: listShadow(listName),
      INDEX: [INPUT_BLOCK_NO_SHADOW, indexBlockId],
      ITEM: [INPUT_BLOCK_NO_SHADOW, valueBlockId],
    },
    parent,
  });
}

function dataLengthOfList(listName, parent = null) {
  return makeBlock({
    opcode: 'data_lengthoflist',
    inputs: { LIST: listShadow(listName) },
    parent,
  });
}

function repeatBlock(timesBlockId, substackFirstChildId, parent = null) {
  return makeBlock({
    opcode: 'control_repeat',
    inputs: {
      TIMES: [INPUT_BLOCK_NO_SHADOW, timesBlockId],
      SUBSTACK: [INPUT_BLOCK_NO_SHADOW, substackFirstChildId],
    },
    parent,
  });
}

// Inline math_number (as an `inlineNum`-shaped shadow reporter input
// — `[MATH_NUM_PRIMITIVE, String(value)]`).
function inlineNumberInput(value) {
  return [INPUT_BLOCK_NO_SHADOW, [MATH_NUM_PRIMITIVE, String(value)]];
}

// §Phase 3 — the diagnostics fixture's first region now triggers a
// D1 demote via the parser-error path (`@max length=N` is removed in
// v9 and emits `gpu.dsl_syntax_error` at severity `error`). The
// emitter then skips this region, so we cannot use `let` here for the
// identifier_collision warn — the second (sibling) region carries the
// `let` so its emitter runs and surfaces the warn.
//
// The error route: first region's `@max` directive → parser emits
// `gpu.dsl_syntax_error` (severity `error`) → `PARSER_ERROR_CODES`
// filter in `block-subset.ts` demotes the region to D1 →
// `ErrorLogPanel` shows "1 error".
//
// The warn route: second region's `@bind let(0) ro f32` → cascade /
// emitter renames the reserved keyword → `gpu.identifier_collision`
// (severity `warn`) → store records it → panel filters it out (existing
// `severity === 'error'` UI policy).
const DIAGNOSTICS_COMMENT_TEXT = [
  '@compute',
  // §Phase 3 (15.3) — `@max length=N` was removed in v9. The parser
  // emits `gpu.dsl_syntax_error` (severity `error`) which is in
  // `PARSER_ERROR_CODES` and forces a D1 demote. This is what the
  // ErrorLogPanel surfaces as the "1 error".
  '@max length=1000',
  '@bind let(0) ro f32',
  '@bind buff_r(1) rw f32',
  '@bind aabb_w(2) ro f32',
  '@workgroup_size(64)',
  '@repeat R0:global_x = len(aabb_w)',
  '@map R0 <- 0',
].join('\n');

// §Phase 3 — second region. Declares `@bind let(0) ro f32` on its own
// (= no slot collision with anything else). The emitter runs because
// no error fires, and renames `let` → `__tw_let`, surfacing
// `gpu.identifier_collision` (severity `warn`).
const DIAGNOSTICS_SECOND_COMMENT_TEXT = [
  '@compute',
  '@bind let(0) ro f32',
  '@bind foo(1) rw f32',
  '@workgroup_size(32)',
  '@repeat S:global_x = 4',
  '@map S <- 0',
].join('\n');

function buildProject() {
  resetCounter();

  const stageSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>';
  const spriteSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" fill="#888888"/></svg>';

  const allBlocks = {};

  // Hat → first control_repeat (the surviving @compute region) →
  // second control_repeat (a second @compute marker on a separate
  // control_repeat — adopted under Phase 3 with no diagnostic).
  const hat = whenFlagClicked();
  allBlocks[hat.id] = hat.block;

  // ===== First @compute region =====
  // repeat (aabb_w) → result = buff_r[R0] * 0   (zero literal = 0.0; trivial but valid)
  const aabb_wLength = dataLengthOfList('aabb_w', hat.id);
  allBlocks[aabb_wLength.id] = aabb_wLength.block;

  // Body entry carries the @compute comment. result = (buff_r[R0]) * 0
  // is a no-op scratch-side but exercises the `data_itemoflist` and
  // `operator_multiply` paths through the WGSL emitter so a warn
  // (`gpu.identifier_collision` from the `let` @bind) is actually
  // produced alongside the parser success.
  const r0Var = dataVariable('R0', null /* parent wired below */);
  allBlocks[r0Var.id] = r0Var.block;
  const buffRead = makeBlock({
    opcode: 'data_itemoflist',
    inputs: {
      LIST: listShadow('buff_r'),
      INDEX: [INPUT_BLOCK_NO_SHADOW, r0Var.id],
    },
    parent: null,
  });
  allBlocks[buffRead.id] = buffRead.block;
  const product = makeBlock({
    opcode: 'operator_multiply',
    inputs: {
      NUM1: [INPUT_BLOCK_NO_SHADOW, buffRead.id],
      // Inline literal 0 — avoids having to allocate an extra block id.
      NUM2: inlineNumberInput(0),
    },
    parent: null,
  });
  allBlocks[product.id] = product.block;
  const substackFirst = dataSetVarTo('result', product.id);
  // Fix parent / next pointers so the chain is `r0Var → buffRead → product → substackFirst.next`
  // and the body entry is `substackFirst`.
  substackFirst.block.parent = hat.id;
  r0Var.block.parent = substackFirst.id;
  buffRead.block.parent = substackFirst.id;
  product.block.parent = substackFirst.id;
  allBlocks[substackFirst.id] = substackFirst.block;

  const repeat = repeatBlock(aabb_wLength.id, substackFirst.id, hat.id);
  hat.block.next = repeat.id;
  allBlocks[repeat.id] = repeat.block;

  // ===== Second @compute region (sibling, adopted under Phase 3) =====
  // repeat (aabb_w) → result = 0   (the comment on its substack head
  // also starts with `@compute`; Phase 3 adopts it without error).
  const dupTimes = dataLengthOfList('aabb_w', hat.id);
  allBlocks[dupTimes.id] = dupTimes.block;
  const dupZero = mathNumber(0, null);
  allBlocks[dupZero.id] = dupZero.block;
  const dupBody = dataSetVarTo('result', dupZero.id);
  dupBody.block.parent = hat.id;
  dupZero.block.parent = dupBody.id;
  allBlocks[dupBody.id] = dupBody.block;

  const dupRepeat = repeatBlock(dupTimes.id, dupBody.id, hat.id);
  // Chain the duplicate repeat after the first one (the parent
  // pointer is shared but `repeat.next` ensures region-extractor's
  // substack walk doesn't bleed across regions — only the first
  // substack block of each repeat matters).
  repeat.block.next = dupRepeat.id;
  allBlocks[dupRepeat.id] = dupRepeat.block;

  // ===== Comments =====
  // Both comments are @compute markers. They live on the FIRST substack
  // block of each repeat (per spec §3.1). Under Phase 3 both regions
  // are adopted — the diagnostic that drives the panel's "1 error"
  // assertion is now `gpu.bind_slot_collision` from the first region
  // (the duplicate `@bind` at slot 0 inside the same region).
  const comments = {
    cmt_compute_a: {
      blockId: substackFirst.id,
      x: 200,
      y: 300,
      width: 280,
      height: 200,
      minimized: false,
      text: DIAGNOSTICS_COMMENT_TEXT,
    },
    cmt_compute_b: {
      blockId: dupBody.id,
      x: 200,
      y: 520,
      width: 280,
      height: 200,
      minimized: false,
      // §Phase 3 — second region survives D1 (no `@max`, no slot
      // collision) and emits `gpu.identifier_collision` (warn) when
      // it renames the `let` reserved-keyword binding.
      text: DIAGNOSTICS_SECOND_COMMENT_TEXT,
    },
  };

  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: {
      result: ['result', 0, 0, 0],
      list_aabb_w: {
        name: 'aabb_w',
        isPersistent: true,
        type: 'list',
        value: [128],
        x: 0,
        y: 0,
      },
      list_buff_r: {
        name: 'buff_r',
        isPersistent: true,
        type: 'list',
        value: [50],
        x: 0,
        y: 0,
      },
    },
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [
      {
        name: 'blank',
        dataFormat: 'svg',
        assetId: 'blank',
        md5ext: 'blank.svg',
        rotationCenterX: 240,
        rotationCenterY: 180,
        svg: stageSvg,
      },
    ],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null,
  };

  const spriteTarget = {
    isStage: false,
    name: 'Diagnostics',
    variables: {
      R0: ['R0', 0, 0, 0],
    },
    lists: {},
    broadcasts: {},
    blocks: allBlocks,
    comments,
    currentCostume: 0,
    costumes: [
      {
        name: 'dot',
        dataFormat: 'svg',
        assetId: 'dot',
        md5ext: 'dot.svg',
        rotationCenterX: 8,
        rotationCenterY: 8,
        svg: spriteSvg,
      },
    ],
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
      agent: 'turbowasm-gpu-kernel-diagnostics-demo',
      platform: { name: 'TurboWasm Viewer' },
    },
  };
}

async function writeProject(projectJson, out) {
  const zip = new JSZip();
  const svgAssets = {};
  for (const target of projectJson.targets) {
    if (!target.costumes) continue;
    for (const c of target.costumes) {
      if (c.dataFormat === 'svg' && c.svg) {
        svgAssets[c.md5ext] = c.svg;
        delete c.svg;
      }
    }
  }
  zip.file('project.json', JSON.stringify(projectJson));
  for (const [name, content] of Object.entries(svgAssets)) {
    zip.file(name, content);
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(out, buf);
  // eslint-disable-next-line no-console
  console.log(`[gpu-kernel-diagnostics-fixture] wrote ${out} (${buf.length} bytes)`);
}

/**
 * Library entry: write `gpu-kernel-diagnostics-fixture.sb3` into the
 * `.test-fixtures/` directory. Re-exported for
 * `scripts/ensure-test-fixtures.mjs`.
 */
export async function makeGpuKernelDiagnosticsFixture() {
  mkdirSync(outDir, { recursive: true });
  const project = buildProject();
  await writeProject(project, outPath);
  return outPath;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  makeGpuKernelDiagnosticsFixture().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[gpu-kernel-diagnostics-fixture] FAILED:', err);
    process.exit(1);
  });
}
