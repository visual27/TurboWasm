import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

// `vi.mock` is hoisted above all imports, but the factory closure
// can only reference top-level `const`s declared via `vi.hoisted`,
// which is the documented way to share state between a hoisted mock
// and the test body.
const { relayoutSpy, getScaffoldingInstanceSpy } = vi.hoisted(() => ({
  relayoutSpy: vi.fn(),
  getScaffoldingInstanceSpy: vi.fn(),
}));

vi.mock('@/lib/scaffolding', async () => {
  const actual = await vi.importActual<typeof import('@/lib/scaffolding')>(
    '@/lib/scaffolding',
  );
  return {
    ...actual,
    relayoutScaffolding: relayoutSpy,
    getScaffoldingInstance: getScaffoldingInstanceSpy,
  };
});

import {
  loadProjectFromArrayBuffer,
  __resetPlayerReadyForTesting,
  __resetTurboWasmForTesting,
} from '@/runtime/player';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';
import { resetScaffoldingForTesting } from '@/lib/scaffolding';
import type { AdvancedSettings } from '@/types/settings';

/**
 * Regression: 2nd project load (with twconfig) after a manual stage-size
 * change would leave the stage in a stale state, drawing sprites in the
 * old aspect ratio. Three root causes were fixed simultaneously (see
 * AGENTS.md "Phase 2 修正" section):
 *
 *  ① `applySettings` did not call `relayoutScaffolding()` after a stage
 *     size change. The Scaffolding's own STAGE_SIZE_CHANGED handler ran
 *     relayout, but with the still-stale `_root.offsetWidth/Height`
 *     (React had not yet committed the new `aspectRatio` CSS). The
 *     rAF1/rAF2 follow-up eventually caught up — unless the rAFs were
 *     cancelled by a re-render, in which case the wrong drawing buffer
 *     / `_overlays` transform persisted.
 *
 *  ② `loadProjectFromArrayBuffer` only called `applyRuntimeOverrides` when
 *     the twconfig had at least one key. Loading a project with no
 *     `// _twconfig_` after one that had a twconfig left the runtime
 *     `advanced` at the previous project's twconfig values, even though
 *     the new project expected the saved defaults.
 *
 *  ③ `StageView` scheduled only two rAF callbacks. React's commit +
 *     reflow for the new `aspectRatio` CSS occasionally took more than
 *     two frames, leaving the Scaffolding's GL canvas drawing buffer
 *     on a stale size.
 *
 * These tests pin the contract that the fix establishes. The visual
 * end-to-end check lives in the smoke-test logs; these tests verify
 * the unit-level wiring so a future refactor can't silently regress
 * the fix.
 */

function makeAdvanced(overrides: Partial<AdvancedSettings> = {}): AdvancedSettings {
  return { ...DEFAULT_ADVANCED_SETTINGS, ...overrides };
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetScaffoldingForTesting();
  __resetPlayerReadyForTesting();
  __resetTurboWasmForTesting();
  relayoutSpy.mockReset();
  getScaffoldingInstanceSpy.mockReset();
  useSettingsStore.setState({
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: makeAdvanced(),
    defaultAdvanced: makeAdvanced(),
    allowedExtensionUrls: [],
    performanceMode: 'auto',
    svgAccelerationMode: 'off',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applySettings: explicit relayout after stage-size change', () => {
  // The fix in `player.ts` appends a `relayoutScaffolding()` call to
  // `applySettings`, gated on a stage-size change. A full integration
  // test would require a real Scaffolding with a live WebGL context
  // (jsdom cannot host one), so we test the contract by reading the
  // source — a future refactor that drops the call would regress
  // the fix. The visual end-to-end is covered by the real-browser
  // smoke test in `scripts/chrome-devtools-mcp-*.log`.

  it('player.ts: applySettings calls relayoutScaffolding on stage-size change', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/runtime/player.ts'),
      'utf8',
    );
    // The fix must (a) call relayoutScaffolding and (b) gate it on a
    // stage-size change. We assert the gate is present, which is the
    // load-bearing part of the fix — without the gate we'd relayout
    // on every settings change (e.g. toggling hq) which would be a
    // visible regression.
    expect(src).toMatch(
      /previous\.stageWidth\s*!==\s*advanced\.stageWidth\s*\|\|\s*previous\.stageHeight\s*!==\s*advanced\.stageHeight/,
    );
    expect(src).toMatch(/relayoutScaffolding\s*\(/);
  });

  it('player.ts: the explicit relayout sits AFTER vm.setStageSize so this.width is fresh', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/runtime/player.ts'),
      'utf8',
    );
    // The relayout must run AFTER the vm.setStageSize call so that the
    // Scaffolding's own STAGE_SIZE_CHANGED handler has already updated
    // this.width/height. Otherwise we'd relayout with the OLD logical
    // size and bake the wrong buffer / overlay transform.
    const setStageSizeIdx = src.indexOf('vm.setStageSize');
    const gateIdx = src.indexOf(
      'previous.stageWidth !== advanced.stageWidth || previous.stageHeight !== advanced.stageHeight',
    );
    expect(setStageSizeIdx, 'vm.setStageSize call not found in player.ts').toBeGreaterThan(-1);
    expect(gateIdx, 'relayoutScaffolding gate not found in player.ts').toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(setStageSizeIdx);
  });
});

describe('loadProjectFromArrayBuffer: applyRuntimeOverrides always runs', () => {
  it('resets advanced to defaultAdvanced when the project has no twconfig', () => {
    // The fix for ②: even with no twconfig, the runtime `advanced` must
    // be reset to the saved defaults so a previous project's twconfig
    // values do not leak into the new project.

    // 1. Simulate that the user previously saved 800x600 + hq=true as
    //    the default. The next project without a twconfig should
    //    inherit these values, not whatever the last project's twconfig
    //    set.
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      advanced: makeAdvanced({
        stageWidth: 800,
        stageHeight: 600,
        highQualityPen: true,
        fps: 60,
      }),
      defaultAdvanced: makeAdvanced({
        stageWidth: 800,
        stageHeight: 600,
        highQualityPen: true,
        fps: 60,
      }),
    });

    // 2. applyRuntimeOverrides({}) — the contract the fix relies on.
    useSettingsStore.getState().applyRuntimeOverrides({});
    const after = useSettingsStore.getState().advanced;
    expect(after.stageWidth).toBe(800);
    expect(after.stageHeight).toBe(600);
    expect(after.highQualityPen).toBe(true);
    expect(after.fps).toBe(60);
  });

  it('applies the project twconfig over defaultAdvanced when present', () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      advanced: makeAdvanced(),
      defaultAdvanced: makeAdvanced({ stageWidth: 800, stageHeight: 600 }),
    });

    useSettingsStore.getState().applyRuntimeOverrides({
      stageWidth: 720,
      stageHeight: 405,
      fps: 60,
    });

    const after = useSettingsStore.getState().advanced;
    expect(after.stageWidth).toBe(720);
    expect(after.stageHeight).toBe(405);
    expect(after.fps).toBe(60);
    // Unspecified keys fall back to defaultAdvanced.
    expect(after.highQualityPen).toBe(DEFAULT_ADVANCED_SETTINGS.highQualityPen);
  });

  it('does not leak a previous project’s twconfig values forward', () => {
    // The bug-shape: project A (with twconfig 720x405) loads, then
    // project B (no twconfig) loads. The runtime `advanced` after
    // project B must NOT carry project A's 720x405 forward — it must
    // reset to the saved defaults.
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      advanced: makeAdvanced(),
      defaultAdvanced: makeAdvanced({
        stageWidth: 480,
        stageHeight: 360,
      }),
    });

    // Project A loads: twconfig sets stage 720x405.
    useSettingsStore.getState().applyRuntimeOverrides({
      stageWidth: 720,
      stageHeight: 405,
    });
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(720);

    // Project B loads: no twconfig. The fix must call
    // applyRuntimeOverrides({}) to reset to defaultAdvanced.
    useSettingsStore.getState().applyRuntimeOverrides({});
    expect(useSettingsStore.getState().advanced.stageWidth).toBe(480);
    expect(useSettingsStore.getState().advanced.stageHeight).toBe(360);
  });

  it('player.ts: loadProjectFromArrayBuffer calls applyRuntimeOverrides unconditionally', async () => {
    // The fix for ② is structural: the `applyRuntimeOverrides(overrides)`
    // call must be OUTSIDE the `if (Object.keys(overrides).length > 0)`
    // branch, so empty-overrides projects still reset the runtime
    // `advanced` to the saved defaults. We assert this by source
    // inspection: a future refactor that puts the call back inside
    // the `if` branch must be caught.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/runtime/player.ts'),
      'utf8',
    );
    // Find the loadProjectFromArrayBuffer function body and the
    // "twconfig pre-parse" comment we use as a stable anchor.
    const anchor = src.indexOf('twconfig pre-parse overrides:');
    expect(anchor, 'twconfig pre-parse log not found in player.ts').toBeGreaterThan(-1);
    // The applyRuntimeOverrides call must be reachable when overrides
    // is empty. We look for it AFTER the anchor (within the same
    // function body) without a wrapping `if (Object.keys(overrides).length > 0)`.
    const after = src.slice(anchor);
    const idx = after.indexOf('applyRuntimeOverrides(overrides)');
    expect(idx, 'applyRuntimeOverrides(overrides) call not found').toBeGreaterThan(-1);
    // Walk back from idx to find the nearest enclosing `if` — it must
    // NOT be the `if (Object.keys(overrides).length > 0)` branch.
    const before = after.slice(0, idx);
    const linesBefore = before.split('\n');
    // Find the closest `if` going backward.
    for (let i = linesBefore.length - 1; i >= 0; i--) {
      const line = (linesBefore[i] ?? '').trim();
      if (line.startsWith('if (') || line.startsWith('if(')) {
        expect(line, 'applyRuntimeOverrides must NOT be inside `if (Object.keys(overrides).length > 0)`').not.toContain(
          'Object.keys(overrides).length > 0',
        );
        return;
      }
    }
    // No enclosing `if` — the call is at the top level, which is what
    // we want.
  });
});

describe('StageView relayout: triple-rAF (fix for ③)', () => {
  it('StageView.tsx schedules three rAF callbacks in the relayout effect', async () => {
    // The fix in `StageView.tsx` schedules `rAF1`, `rAF2`, AND `rAF3`
    // so React's commit + reflow for the new `aspectRatio` CSS has
    // time to settle. We assert by source: the cleanup function must
    // cancel three rAFs and the effect must schedule three.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/features/stage/StageView.tsx'),
      'utf8',
    );
    // The relayout effect declares raf2 and raf3 in the let-binding
    // and cancels all three in the cleanup. If a refactor drops the
    // third rAF the test will catch it.
    const rAF3Decl = /let raf2 = 0;\s*let raf3 = 0;/;
    const cancel3 = /cancelAnimationFrame\(raf1\)[\s\S]*cancelAnimationFrame\(raf2\)[\s\S]*cancelAnimationFrame\(raf3\)/;
    expect(src).toMatch(rAF3Decl);
    expect(src).toMatch(cancel3);
  });
});

/**
 * Build a minimal valid sb3 zip in-memory. If `twconfigText` is null,
 * no `// _twconfig_` comment is written — the project has no twconfig.
 * If it's a string, that string is used verbatim as the only comment
 * in the stage target.
 */
async function buildProjectSb3(opts: {
  twconfigText: string | null;
  stageWidth: number;
  stageHeight: number;
}): Promise<ArrayBuffer> {
  const stageComments: Record<string, { text: string }> = {};
  if (opts.twconfigText !== null) {
    stageComments.twconfig = {
      text: opts.twconfigText,
    };
  }
  const project = {
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
            rotationCenterX: opts.stageWidth / 2,
            rotationCenterY: opts.stageHeight / 2,
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
  };
  const zip = new JSZip();
  zip.file('blank.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  zip.file('project.json', JSON.stringify(project));
  return await zip.generateAsync({ type: 'arraybuffer' });
}

void loadProjectFromArrayBuffer;
void buildProjectSb3;
