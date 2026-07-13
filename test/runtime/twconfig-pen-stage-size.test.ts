import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression: 2nd project load (with twconfig) after a manual stage-size
 * change would leave the pen layer drawn at the top-left of the OLD
 * stage range. Root cause: when the PenSkin's `_size` is updated via
 * `_setCanvasSize`, the drawable's `_calculateTransform` is not always
 * triggered to recompute `_skinScale` from the NEW `_nativeSize`. The
 * drawable then caches the OLD `_skinScale`, producing a model matrix
 * that maps the pen framebuffer to the OLD aspect ratio's top-left.
 *
 * The fix is a vendored patch in
 * `patches/scratch-render+0.1.0.patch` that, at the end of
 * `PenSkin._setCanvasSize`, iterates over the renderer's drawList and
 * calls `_skinWasAltered()` on every drawable backed by this PenSkin.
 * That sets `_skinScaleDirty = true` and `_transformDirty = true` on
 * the drawable, so the next render's `updateCPURenderAttributes` →
 * `updateMatrix` → `_calculateTransform` recomputes the model matrix
 * from the new skin size.
 *
 * These tests pin the structural contract that the fix establishes.
 * A full integration test would require a real WebGL context (which
 * jsdom cannot host), so we verify the patch is present in the source
 * tree and applied to the vendored scratch-render.
 *
 * The visual end-to-end check lives in the real-browser smoke test
 * (the user manually reproduced the pen offset against the
 * 1st-load / 2nd-load sequence and confirmed the fix removed the
 * offset).
 */

const VENDORED_PENSKIN = resolve(
  __dirname,
  '../../vendored/scaffolding/node_modules/scratch-render/src/PenSkin.js',
);
const PATCH_FILE = resolve(
  __dirname,
  '../../patches/scratch-render+0.1.0.patch',
);

function makeProjectJson(twconfigText: string | null): string {
  const stageComments: Record<string, { text: string }> = {};
  if (twconfigText !== null) {
    stageComments.twconfig = {
      text: twconfigText,
    };
  }
  return JSON.stringify({
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: stageComments,
        currentCostume: 0,
        costumes: [
          {
            name: 'blank',
            dataFormat: 'svg',
            assetId: 'blank',
            md5ext: 'blank.svg',
            rotationCenterX: 240,
            rotationCenterY: 135,
          },
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0,
      },
    ],
    monitors: [],
    extensions: [],
    extensionURLs: {},
    meta: { semver: '3.0.0', vm: '0.2.0', agent: '' },
  });
}

async function buildProjectSb3(twconfigText: string | null): Promise<ArrayBuffer> {
  const project = makeProjectJson(twconfigText);
  const zip = new JSZip();
  zip.file('blank.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  zip.file('project.json', project);
  return await zip.generateAsync({ type: 'arraybuffer' });
}

void buildProjectSb3;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PenSkin: emitWasAltered + drawable._skinWasAltered on _setCanvasSize', () => {
  it('PenSkin._setCanvasSize source contains the drawable-loop hint at the end', () => {
    // The fix calls emitWasAltered() AND iterates over the drawable
    // list to call _skinWasAltered() on every drawable backed by this
    // PenSkin. We assert by source inspection: a future refactor that
    // drops the loop must be caught.
    const src = readFileSync(VENDORED_PENSKIN, 'utf8');
    // Anchor on the unique comment marker introduced by the patch.
    expect(src).toMatch(/TurboWasm:\s*force every drawable backed by this PenSkin/);
    // The loop must end with a call to drawable._skinWasAltered().
    const loopStart = src.indexOf('for (let i = 0; i < this._renderer._drawList.length; i++)');
    expect(loopStart, 'drawable loop anchor not found').toBeGreaterThan(-1);
    const after = src.slice(loopStart);
    expect(after).toMatch(/drawable\._skinWasAltered\(\)/);
    // The fix must also call emitWasAltered() (idempotent with the
    // onNativeSizeChanged caller). We accept either order; the
    // important contract is that both signals fire after _size and
    // _rotationCenter are set.
    expect(after).toMatch(/this\.emitWasAltered\(\)/);
  });

  it('PenSkin._setCanvasSize source: hint runs AFTER _size and _rotationCenter are updated', () => {
    // The hint must come after `this._size = canvasSize;` and
    // `this._rotationCenter[1] = this._nativeSize[1] / 2;` so that
    // the drawable's recalculation reads the new values. Putting the
    // hint before those assignments would re-introduce the bug
    // (drawable caches the OLD _nativeSize via _skinScale).
    const src = readFileSync(VENDORED_PENSKIN, 'utf8');
    const sizeAssignIdx = src.indexOf('this._size = canvasSize');
    const rotationCenterIdx = src.indexOf('this._rotationCenter[1] = this._nativeSize[1] / 2');
    const hintIdx = src.indexOf('TurboWasm: force every drawable');
    expect(sizeAssignIdx, '_size assignment anchor not found').toBeGreaterThan(-1);
    expect(rotationCenterIdx, '_rotationCenter assignment anchor not found').toBeGreaterThan(-1);
    expect(hintIdx, 'drawable hint anchor not found').toBeGreaterThan(-1);
    expect(hintIdx, 'hint must run after _size and _rotationCenter are set').toBeGreaterThan(
      Math.max(sizeAssignIdx, rotationCenterIdx),
    );
  });

  it('patches/scratch-render+0.1.0.patch contains the PenSkin hint hunk', () => {
    // The vendored source has the patch applied directly (the user
    // edited it before the setup re-applied it). The patch file must
    // remain in sync so a fresh `npm run setup` from a clean tree
    // produces the same code. We assert the patch contains a hunk
    // matching the hint comment + the drawable-loop body.
    const patch = readFileSync(PATCH_FILE, 'utf8');
    expect(patch).toMatch(/force every drawable backed by this PenSkin/);
    expect(patch).toMatch(/drawable\._skinWasAltered\(\)/);
  });
});

describe('PenSkin size getter: returns _nativeSize, not _size', () => {
  // The drawable's _calculateTransform reads `this.skin.size` to
  // compute _skinScale. For PenSkin, the `size` getter MUST return
  // `_nativeSize` (the stage's logical size), NOT `_size` (which is
  // `_nativeSize * renderQuality` for HQ pen). If it returned `_size`,
  // the drawable would map the pen framebuffer to the upscaled
  // dimensions, which is what TurboWarp's `size` getter comment
  // explicitly warns about.
  //
  // We pin the getter source so a future refactor cannot accidentally
  // change the return to `_size`.
  it('PenSkin source: `get size ()` returns `this._nativeSize`', () => {
    const src = readFileSync(VENDORED_PENSKIN, 'utf8');
    // Anchor on the getter declaration. The `get size ()` accessor is
    // unique to PenSkin; a refactor that removes it would change
    // the drawable's positioning math and re-introduce the bug.
    const getterMatch = src.match(/get size \(\) \{[\s\S]*?return this\._nativeSize;[\s\S]*?}/);
    expect(
      getterMatch,
      'PenSkin.size getter is expected to return `this._nativeSize`',
    ).not.toBeNull();
  });
});
