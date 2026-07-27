import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard — vendored scratch-vm's compiled mode must run a real
 * Scratch project's procedure body when the project uses the standard
 * `procedures_definition.next` shape (= the body is the next sprite-level
 * block after the hat, the convention every project exported from
 * scratch-gui / scratch-blocks / scratch3 follows).
 *
 * The companion regression is `procedure-lazy-cache-fixture.sb3`, which
 * uses an unusual `proto.inputs.SUBSTACK.block` shape (= the procedure
 * body is the SUBSTACK input of the procedures_prototype). Both shapes
 * must work in compiled mode so a project authored in the official
 * editor does not silently render as a still sprite with no pen trail.
 *
 * The `// TurboWasm: procedure-definition-entry-prototype-substack` hunk
 * in `patches/vendored/scratch-vm.patch` historically preferred the
 * SUBSTACK-only path (= `entryBlock = proto.inputs.SUBSTACK.block`),
 * which left `topBlock.next` (= the real Scratch shape) un-walked and
 * the compiled procedure body empty. This test pins both shapes at the
 * runtime projection level (= "did the sprite actually move?") so a
 * future regression that drops the `topBlock.next` fallback trips
 * CI without needing the unit-level patch marker probe.
 *
 * Fixture under test: `C:\files\devs\test\fps.sb3` (real Scratch
 * project, 224984 bytes, 2 targets, 21 sprite blocks, 1 custom block
 * named "block name" wrapping `motion_goto` + `pen_penDown`).
 */

const USER_PROJECT_PATH = resolve('C:/files/devs/test/fps.sb3');
const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

const STEP_FRAMES = 120;

interface RunResult {
  initialX: number;
  initialY: number;
  initialDirection: number;
  x: number;
  y: number;
  direction: number;
  penSkinId: number | null;
  penLayerHasContent: boolean;
}

async function runProjectOnce(
  compile: boolean,
  VirtualMachine: unknown,
  projectBuffer: ArrayBuffer,
): Promise<RunResult> {
  // The vendored scratch-vm is CommonJS; from a Vitest ESM file we use
  // createRequire so `new VirtualMachine()` works.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const VM = VirtualMachine as any;
  const vm = new VM();
  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  vm.setCompilerOptions({ enabled: compile });
  await vm.loadProject(projectBuffer);
  // Sprite target is `Sprite1` (= runtime.targets[1], Stage is targets[0]).
  const sprite = vm.runtime.targets[1];
  const initialX = sprite.x;
  const initialY = sprite.y;
  const initialDirection = sprite.direction;
  vm.runtime.greenFlag();
  for (let i = 0; i < STEP_FRAMES; i += 1) {
    try {
      vm.runtime._step();
    } catch {
      // Swallow recursive-call self-recursion throw (only fires in the
      // compiled factorial-fixture recursion case; fps.sb3 has no
      // recursion so this is purely defensive).
      break;
    }
  }
  // PenSkin id is the drawable id of the sprite whose skin is
  // PenSkin-typed. fps.sb3 has no custom penSprite but the project's
  // "block name" calls `motion_goto` (sprite should move) — we treat
  // motion as the primary signal and pen-state as secondary.
  const renderer = vm.runtime.renderer as
    | {
        _penSkinId?: number | null;
        _allDrawables?: Array<{ _skin?: { _canvas?: HTMLCanvasElement | undefined } }>;
      }
    | undefined;
  const penSkinId = renderer && renderer._penSkinId != null ? renderer._penSkinId : null;
  let penLayerHasContent = false;
  if (penSkinId != null && renderer && renderer._allDrawables) {
    const skin = renderer._allDrawables[penSkinId]?._skin as
      | { _canvas?: HTMLCanvasElement | undefined }
      | undefined;
    const canvas = skin?._canvas;
    if (canvas && typeof canvas.width === 'number' && canvas.width > 0) {
      penLayerHasContent = true;
    }
  }
  return {
    initialX,
    initialY,
    initialDirection,
    x: sprite.x,
    y: sprite.y,
    direction: sprite.direction,
    penSkinId,
    penLayerHasContent,
  };
}

describe('vendored scratch-vm — real-Scratch-shape procedure body (fps.sb3)', () => {
  if (!existsSync(USER_PROJECT_PATH)) {
    // The user-authored project is intentionally outside the repo
    // (= lives at C:\files\devs\test\fps.sb3). Skip silently if a
    // different machine does not have it; the patch-shape unit tests
    // in `compiler-procedure-body.test.ts` still pin the legacy
    // fixture shape regression.
    it.skip(`user project missing at ${USER_PROJECT_PATH}; skipping live-runtime projection.`, () => {});
    return;
  }

  if (!existsSync(VENDORED_VM_DIR)) {
    it.skip('vendored scratch-vm source missing; run `npm run setup`.', () => {});
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cjsRequire = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const VirtualMachine = cjsRequire(resolve(VENDORED_VM_DIR, 'src/index.js'));
  const projectBuffer = readFileSync(USER_PROJECT_PATH);
  // Copy into a fresh ArrayBuffer so the scratch-vm loader doesn't
  // carry any extra bytes past the zip tail.
  const ab = new ArrayBuffer(projectBuffer.byteLength);
  new Uint8Array(ab).set(projectBuffer);

  describe('interpreted mode (baseline)', () => {
    it('sprite position changes after greenFlag + step', async () => {
      const r = await runProjectOnce(false, VirtualMachine, ab);
      // Interpreted mode has always worked for fps.sb3 — pin it so the
      // compiled-vs-interpreted comparison below has a stable baseline.
      const moved =
        r.x !== r.initialX ||
        r.y !== r.initialY ||
        r.direction !== r.initialDirection;
      expect(moved, 'interpreted mode: sprite should move after green flag').toBe(true);
    });
  });

  describe('compiled mode (the regression)', () => {
    it('sprite position changes after greenFlag + step (= the bug fix)', async () => {
      const r = await runProjectOnce(true, VirtualMachine, ab);
      const moved =
        r.x !== r.initialX ||
        r.y !== r.initialY ||
        r.direction !== r.initialDirection;
      expect(
        moved,
        `compiled mode: sprite never moved ` +
          `(initial=(${r.initialX},${r.initialY},${r.initialDirection}), ` +
          `after=${STEP_FRAMES} steps=(${r.x},${r.y},${r.direction})). ` +
          'This is the `procedures_definition.next` shape: the procedure ' +
          'body lives as the next sibling of `procedures_definition`, NOT ' +
          'as `proto.inputs.SUBSTACK.block`. See AGENTS.md ' +
          '症状 → 見るべき場所 table for the patch-shape history.',
      ).toBe(true);
    });

    it('procedures_call site resolved to the real body (no empty compiled procedure)', async () => {
      // Secondary signal: pin that the direction / x / y diverge from
      // the initial values by more than just sub-pixel rounding. The
      // fps.sb3 fixture's `block name` is a 2-block body
      // (motion_goto to mouse-pointer, pen_penDown). When the patch
      // is broken (= empty compiled body), the sprite stays at its
      // initial position and direction forever, so the after-step
      // delta is exactly 0. With the fix, motion_goto + pen_penDown
      // both fire and the sprite position changes.
      const r = await runProjectOnce(true, VirtualMachine, ab);
      const dx = Math.abs(r.x - r.initialX);
      const dy = Math.abs(r.y - r.initialY);
      const movedPx = dx + dy;
      expect(
        movedPx,
        `compiled mode: sprite moved < 1px (dx=${dx}, dy=${dy}); ` +
          'the `procedures_call` site resolved to an empty body.',
      ).toBeGreaterThan(1);
    });
  });

  describe('UMD marker pin', () => {
    if (!existsSync(UMD_PATH)) {
      it.skip('UMD missing; run `npm run setup` to enable this probe.', () => {});
      return;
    }
    const umd = readFileSync(UMD_PATH, 'utf8');

    it('UMD contains the // TurboWasm: procedure-definition-entry-prototype-substack marker', () => {
      // The marker survives even when the patch hunk is rewritten to
      // handle both shapes — the comment block on `topBlock.next`
      // resolution documents the new fallback.
      const matches = umd.match(
        /\/\/ TurboWasm: procedure-definition-entry-prototype-substack/g,
      ) ?? [];
      expect(matches.length, 'expected at least 1 marker occurrence').toBeGreaterThanOrEqual(1);
    });
  });
});
