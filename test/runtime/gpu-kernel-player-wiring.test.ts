import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

// `vi.mock` is hoisted above all imports, but the factory closure can
// only reference top-level `const`s declared via `vi.hoisted`, which is
// the documented way to share state between a hoisted mock and the
// test body.
const { relayoutSpy } = vi.hoisted(() => ({
  relayoutSpy: vi.fn(),
}));

vi.mock('@/lib/scaffolding', async () => {
  const actual = await vi.importActual<typeof import('@/lib/scaffolding')>(
    '@/lib/scaffolding',
  );
  return {
    ...actual,
    relayoutScaffolding: relayoutSpy,
  };
});

import {
  __bindEventsForTesting,
  __exposeForBrowserVerify,
  __getGpuRegistryForTesting,
  __resetPlayerReadyForTesting,
  __resetTurboWasmForTesting,
  // The function below are used only as imported symbols to assert the
  // public surface of the player module exists.
} from '@/runtime/player';
import { __getGpuKernelForBrowserVerify } from '@/runtime/gpu-kernel/apply-gpu-kernels';
import {
  collectRegionVerdictsFromArrayBuffer,
} from '@/runtime/gpu-kernel/region-verdict-pipeline';
import { initializeGpuKernels } from '@/runtime/gpu-kernel/initialize-gpu-kernels';
import { KernelRegistry } from '@/runtime/gpu-kernel/kernel-registry';
import { ListBufferPool } from '@/runtime/gpu-kernel/list-buffer-binding';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

/**
 * M6 → M7 wiring test for the GPU compute kernel pipeline.
 *
 * Scope:
 *   - Source-inspection: pin down the structural wiring of
 *     `bootstrapGpuKernels` in `loadProjectFromArrayBuffer`, plus the
 *     two short-circuits (`enableWebgpu === false`,
 *     `enableWasm === false`). These are source-level guarantees that
 *     future refactors cannot silently regress.
 *   - Behavioural: drive the M3 → M5 pipeline end-to-end on a tiny
 *     jszip-built SB3 buffer that carries an `@compute` region. We
 *     verify the region is detected (verdict count > 0) and the
 *     registry snapshot reflects the bootstrap state.
 *   - Browser-verify surface: confirm `__exposeForBrowserVerify`
 *     publishes `kernelRegistry` under `window.__turbowasm.kernelRegistry`
 *     with the shape the Playwright harness inspects.
 *
 * What this test does NOT cover: a real WebGPU device path. jsdom does
 * not implement WebGPU, so `initializeGpuKernels` always returns
 * `device: null` here. The GPU-vs-legacy pixel comparison lives in
 * `scripts/verify-gpu-kernel.mjs` + `test/e2e/gpu-kernel.test.ts`.
 */

function makeAdvanced(overrides: Partial<typeof DEFAULT_ADVANCED_SETTINGS> = {}) {
  return { ...DEFAULT_ADVANCED_SETTINGS, ...overrides };
}

function makeScaffoldingStub(vm: unknown): Parameters<typeof __bindEventsForTesting>[0] {
  const listeners = new Map<string, EventListener>();
  return {
    vm,
    addEventListener(type: string, listener: EventListener): void {
      listeners.set(type, listener);
    },
    removeEventListener(): void {
      /* noop */
    },
  } as unknown as Parameters<typeof __bindEventsForTesting>[0];
}

const COMPUTE_COMMENT_TEXT = [
  '@compute',
  '@bind tmp0(0) ro f32',
  '@bind buff_r(1) rw f32',
  '@bind aabb_w(2) ro f32',
  '@workgroup_size(64)',
  // §Phase 2 (15.3): inline `, max=<uint>` removed alongside @max.
  '@repeat R0:global_x = aabb_w',
  '@map R0 <- 0',
].join('\n');

/**
 * Build a minimal in-memory sb3 buffer that contains a control_repeat
 * whose first substack block carries the @compute comment. Mirrors the
 * shape `scripts/make-expo-fixture.mjs` writes on disk.
 *
 * NOTE on input shape: the M6 pre-parse pipeline reads `inputs.SUBSTACK`
 * via `region-extractor.ts:readSubstackId`, which expects either a
 * plain block-id string or an object with `id` (`{ id, name }`). The
 * raw scratch-vm on-disk format is `[INPUT_BLOCK_NO_SHADOW, blockId]`
 * (an array), which is normalized by scratch-vm's deserializer AFTER
 * `bootstrapGpuKernels` runs. The vendored scratch-vm reads the array
 * form during `loadProject` and converts it to the object form; this
 * helper pre-applies that normalization so the in-memory test can
 * drive the M3 → M5 pipeline without booting the Scaffolding.
 */
async function buildExpoSb3(): Promise<ArrayBuffer> {
  let blockId = 1;
  const id = (): string => `b${blockId++}`;
  const substackFirstId = id();
  const r0VarId = id();
  const buffReadId = id();
  const tmp0VarId = id();
  const productId = id();
  const aabb_wLengthId = id();
  const repeatId = id();
  const hatId = id();

  const allBlocks = {
    [hatId]: {
      id: hatId,
      opcode: 'event_whenflagclicked',
      inputs: {},
      fields: {},
      next: repeatId,
      parent: null,
      topLevel: true,
      shadow: false,
      x: 200,
      y: 50,
    },
    [aabb_wLengthId]: {
      id: aabb_wLengthId,
      opcode: 'data_lengthoflist',
      inputs: { LIST: { id: 'aabb_w', name: 'LIST' } },
      fields: {},
      next: null,
      parent: hatId,
      topLevel: false,
      shadow: false,
      x: 0,
      y: 0,
    },
    [substackFirstId]: {
      id: substackFirstId,
      opcode: 'data_setvariableto',
      inputs: { VALUE: { id: productId, name: 'VALUE' } },
      fields: { VARIABLE: ['result', null] },
      next: null,
      parent: hatId,
      topLevel: false,
      shadow: false,
      x: 0,
      y: 0,
    },
    [r0VarId]: {
      id: r0VarId,
      opcode: 'data_variable',
      inputs: {},
      fields: { VARIABLE: ['R0', null] },
      next: null,
      parent: substackFirstId,
      topLevel: false,
      shadow: false,
      x: 0,
      y: 0,
    },
    [buffReadId]: {
      id: buffReadId,
      opcode: 'data_itemoflist',
      inputs: {
        LIST: { id: 'buff_r', name: 'LIST' },
        INDEX: { id: r0VarId, name: 'INDEX' },
      },
      fields: {},
      next: null,
      parent: substackFirstId,
      topLevel: false,
      shadow: false,
      x: 0,
      y: 0,
    },
    [tmp0VarId]: {
      id: tmp0VarId,
      opcode: 'data_variable',
      inputs: {},
      fields: { VARIABLE: ['tmp0', null] },
      next: null,
      parent: substackFirstId,
      topLevel: false,
      shadow: false,
      x: 0,
      y: 0,
    },
    [productId]: {
      id: productId,
      opcode: 'operator_multiply',
      inputs: {
        NUM1: { id: buffReadId, name: 'NUM1' },
        NUM2: { id: tmp0VarId, name: 'NUM2' },
      },
      fields: {},
      next: null,
      parent: substackFirstId,
      topLevel: false,
      shadow: false,
      x: 0,
      y: 0,
    },
    [repeatId]: {
      id: repeatId,
      opcode: 'control_repeat',
      inputs: {
        TIMES: { id: aabb_wLengthId, name: 'TIMES' },
        SUBSTACK: { id: substackFirstId, name: 'SUBSTACK' },
      },
      fields: {},
      next: null,
      parent: hatId,
      topLevel: false,
      shadow: false,
      x: 0,
      y: 0,
    },
  };

  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {
          tmp0: ['tmp0', 0, 0, 0],
          result: ['result', 0, 0, 0],
          list_aabb_w: {
            name: 'aabb_w',
            type: 'list',
            value: [100],
            isPersistent: true,
          },
          list_aabb_height: {
            name: 'aabb_height',
            type: 'list',
            value: [200],
            isPersistent: true,
          },
          list_buff_r: {
            name: 'buff_r',
            type: 'list',
            value: [50],
            isPersistent: true,
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
          },
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0,
      },
      {
        isStage: false,
        name: 'Expo',
        variables: { R0: ['R0', 0, 0, 0] },
        lists: {},
        broadcasts: {},
        blocks: allBlocks,
        comments: {
          cmt_compute: {
            blockId: substackFirstId,
            x: 200,
            y: 300,
            width: 280,
            height: 160,
            minimized: false,
            text: COMPUTE_COMMENT_TEXT,
          },
        },
        currentCostume: 0,
        costumes: [
          {
            name: 'dot',
            dataFormat: 'svg',
            assetId: 'dot',
            md5ext: 'dot.svg',
            rotationCenterX: 8,
            rotationCenterY: 8,
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
      },
    ],
    monitors: [],
    extensions: [],
    extensionURLs: {},
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'gpu-kernel-wiring-test' },
  };

  const zip = new JSZip();
  zip.file('blank.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  zip.file('dot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>');
  zip.file('project.json', JSON.stringify(project));
  return await zip.generateAsync({ type: 'arraybuffer' });
}

beforeEach(() => {
  document.body.innerHTML = '';
  __resetPlayerReadyForTesting();
  __resetTurboWasmForTesting();
  relayoutSpy.mockReset();
  useSettingsStore.setState({
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: makeAdvanced(),
    defaultAdvanced: makeAdvanced(),
    allowedExtensionUrls: [],
    enableWasm: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('player.ts: bootstrapGpuKernels wiring (source-inspection)', () => {
  /**
   * Pin the structural wiring so a future refactor cannot silently
   * regress the M6 path. jsdom cannot host the real Scaffolding, so
   * these are the load-bearing guarantees a unit test can stand on.
   */

  function readPlayerSource(): string {
    // Lazy require so the `vi.mock('@/lib/scaffolding')` factory has
    // been applied before we hit the file system (the player module
    // itself imports @/lib/scaffolding via its top-level imports).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    return fs.readFileSync(
      path.resolve(__dirname, '../../src/runtime/player.ts'),
      'utf8',
    );
  }

  it('loadProjectFromArrayBuffer awaits bootstrapGpuKernels(loadBuf)', () => {
    const src = readPlayerSource();
    // The wiring contract: the M6 bootstrap must run inside the
    // loadProjectFromArrayBuffer function, BEFORE `attachedScaffolding.loadProject(loadBuf)`.
    const bootstrapIdx = src.indexOf('await bootstrapGpuKernels(loadBuf)');
    const loadProjectIdx = src.indexOf('await attachedScaffolding.loadProject(loadBuf)');
    expect(bootstrapIdx, 'bootstrapGpuKernels call not found').toBeGreaterThan(-1);
    expect(loadProjectIdx, 'attachedScaffolding.loadProject call not found').toBeGreaterThan(-1);
    expect(bootstrapIdx, 'bootstrap must run before loadProject').toBeLessThan(loadProjectIdx);
  });

  it('enableWebgpu=false short-circuits the bootstrap (logged skip)', () => {
    const src = readPlayerSource();
    // The branch reads currentAdvanced?.enableWebgpu and logs the
    // skip. We assert the literal console message the harness greps for.
    expect(src).toMatch(/enableWebgpu\s*=\s*false\s*;\s*skipping\s+@compute/);
  });

  it('enableWasm=false short-circuits the bootstrap (logged skip)', () => {
    const src = readPlayerSource();
    expect(src).toMatch(/enableWasm\s*=\s*false\s*;\s*skipping\s+@compute/);
  });

  it('nestedParallelizationEnabled=false filters nested regions (Phase 4 gate)', () => {
    // Phase 4 (nested-parallelization-05-phase4 §3.7): the gate must
    //   1. read `currentAdvanced?.nestedParallelizationEnabled` from the
    //      runtime advanced settings
    //   2. drop every verdict whose `nestedRepeatContainerBlockIds`
    //      array is non-empty (= kernel container promoted to an
    //      ancestor control_repeat)
    //   3. log a skip line carrying the dropped count when ALL regions
    //      were filtered out
    const src = readPlayerSource();
    expect(src).toMatch(/currentAdvanced\?\.nestedParallelizationEnabled/);
    expect(src).toMatch(/nestedRepeatContainerBlockIds\.length\s*===\s*0/);
    // The skip log line is matched by the verify-gpu-kernel harness —
    // it must mention the gate name and the dropped count.
    expect(src).toMatch(/nestedParallelizationEnabled\s*=\s*false\s*;\s*skipping/);
  });

  it("__exposeForBrowserVerify publishes `kernelRegistry` (size/jsOnly/canonicalKeys) under window.__turbowasm", () => {
    const src = readPlayerSource();
    // The harness reads `window.__turbowasm.kernelRegistry.size` (and
    // the jsOnly / canonicalKeys fields). The M6 expose helper must
    // wire all three keys via __getGpuKernelForBrowserVerify.
    expect(src).toMatch(/__turbowasm\s*=\s*{[\s\S]*kernelRegistry/);
    expect(src).toMatch(/__getGpuKernelForBrowserVerify\(\s*activeGpuRegistry\s*\)/);
  });

  it('bootstrap installs __turboWasmGpuKernelDispatch when enabled and WASM are both on', () => {
    const src = readPlayerSource();
    // The vendored scratch-vm hook reads this global; the player must
    // install it before the first `control_repeat` runs.
    expect(src).toMatch(/applyGpuKernels\([\s\S]*?pipelines:\s*activeGpuPipelines/);
    expect(src).toMatch(/applyGpuKernels\([\s\S]*?runtime:\s*activeRuntimeAdapter/);
  });

  it('tearDownActiveGpuState clears pool + pipelines + dispatcher on project reload', () => {
    const src = readPlayerSource();
    // The teardown helper must run before any new bootstrap to prevent
    // leaks (per spec §7.1 "no spam" + §6.3 "device-lost" semantics).
    expect(src).toMatch(/function\s+tearDownActiveGpuState\s*\(/);
    expect(src).toMatch(/activeGpuPool\.clear\(\)/);
    expect(src).toMatch(/activeGpuPipelines\?\.clear\(\)/);
    expect(src).toMatch(/__setGpuKernelDispatcher\(null\)/);
  });
});

describe('gpu-kernel pipeline: end-to-end on a @compute fixture', () => {
  /**
   * Behavioural: drive M3 → M5 on a jszip-built SB3 buffer. We do NOT
   * call `loadProjectFromArrayBuffer` (that would require a real
   * Scaffolding); instead we drive the public pipeline functions the
   * same way `bootstrapGpuKernels` does, so a regression in the
   * pre-parse surface fails this test.
   */

  it('collectRegionVerdictsFromArrayBuffer detects the @compute region in our fixture', async () => {
    const buf = await buildExpoSb3();
    const projectJson = await readProjectJson(buf);
    const parsedProject = toParsedProjectFromJson(projectJson);
    const { verdicts, allDirectives } = collectRegionVerdictsFromArrayBuffer(parsedProject);
    expect(verdicts).toHaveLength(1);
    expect(allDirectives.length).toBeGreaterThan(0);
    // The directive surface matches what the demo fixture was built
    // with. We don't pin the exact count (some directives may produce
    // multiple axis entries) — just that the major shapes survived.
    const kinds = new Set(allDirectives.map((d) => d.kind));
    expect(kinds.has('compute' as never)).toBe(false); // @compute is a marker, not a directive
    expect(kinds.has('bind')).toBe(true);
    expect(kinds.has('repeat')).toBe(true);
    expect(kinds.has('map')).toBe(true);
    expect(kinds.has('workgroup_size')).toBe(true);
  });

  it('initializeGpuKernels returns device=null in jsdom and emits no kernels', async () => {
    const buf = await buildExpoSb3();
    const projectJson = await readProjectJson(buf);
    const parsedProject = toParsedProjectFromJson(projectJson);
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsedProject);
    expect(verdicts).toHaveLength(1);

    // Adapter requester returns null (jsdom has no WebGPU). This
    // mirrors the runtime contract: when device === null the registry
    // stays empty, so the bootstrap is observably a no-op until a
    // real GPU arrives.
    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject,
        runtimeState: { listLengths: { aabb_w: 1, buff_r: 1 } },
        enableWasm: true,
        enabled: true,
      },
      async () => null,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
    // The harness path still produces a valid KernelRegistry and pool
    // (the applyGpuKernels step expects these handles).
    expect(result.registry).toBeInstanceOf(KernelRegistry);
    expect(result.pool).toBeInstanceOf(ListBufferPool);
  });

  it('enabled=false (Settings dialog toggle) yields an empty registry + null device', async () => {
    const buf = await buildExpoSb3();
    const projectJson = await readProjectJson(buf);
    const parsedProject = toParsedProjectFromJson(projectJson);
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsedProject);

    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject,
        runtimeState: { listLengths: {} },
        enableWasm: true,
        enabled: false,
      },
      async () => null,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
  });

  it('enableWasm=false yields an empty registry + null device (DoD parity)', async () => {
    const buf = await buildExpoSb3();
    const projectJson = await readProjectJson(buf);
    const parsedProject = toParsedProjectFromJson(projectJson);
    const { verdicts } = collectRegionVerdictsFromArrayBuffer(parsedProject);

    const result = await initializeGpuKernels(
      {
        regions: verdicts,
        parsedProject,
        runtimeState: { listLengths: {} },
        enableWasm: false,
        enabled: true,
      },
      async () => null,
    );
    expect(result.device).toBeNull();
    expect(result.registry.size()).toBe(0);
  });
});

describe('__exposeForBrowserVerify publishes the kernelRegistry snapshot', () => {
  /**
   * The Playwright harness reads `window.__turbowasm.kernelRegistry.size`
   * (and the jsOnly + canonicalKeys fields). We exercise the
   * publish-via-`__exposeForBrowserVerify` path against a fake
   * ScaffoldingInstance so the snapshot shape is observable in jsdom.
   */
  it('publishes kernelRegistry={size, jsOnly, canonicalKeys} on window.__turbowasm', () => {
    // Build a registry with a single fake kernel so the snapshot is
    // non-empty. We use KernelRegistry directly so we don't depend
    // on the rest of the gpu-kernel pipeline here.
    const registry = new KernelRegistry();
    registry.register(
      {
        regionId: 'region:fake:b1',
        blockId: 'b1',
        spriteId: 'fake',
        directives: [
          {
            kind: 'bind',
            name: 'a',
            slot: 0,
            readOnly: false,
            dtype: 'f32',
            line: 0,
            column: 0,
          },
        ],
        blockSubset: { valid: true, diagnostics: [] },
        axes: {},
        cascade: { valid: true, diagnostics: [], topoOrder: [] },
        diagnostics: [],
        parallelAxes: [],
        kernelContainerBlockId: 'b1',
        nestedRepeatContainerBlockIds: [],
        firstSubstackBlockId: '',
      },
      'wgsl-fake',
    );

    // The active registry accessor only returns non-null after
    // bootstrapGpuKernels runs. We exercise the snapshot directly via
    // __getGpuKernelForBrowserVerify to verify the shape contract the
    // harness relies on.
    const snapshot = __getGpuKernelForBrowserVerify(registry);
    expect(snapshot.size).toBe(1);
    expect(snapshot.jsOnly).toBe(0);
    expect(snapshot.canonicalKeys).toHaveLength(1);
    expect(snapshot.canonicalKeys[0]).toMatch(/^fnv1a-/);
  });

  it('__getGpuRegistryForTesting returns null before bootstrap (clean baseline)', () => {
    // The player module's module-level `activeGpuRegistry` resets to
    // null on every `__resetTurboWasmForTesting()` call. We assert
    // that to pin the clean-state contract — no leftover registry
    // from a previous test.
    expect(__getGpuRegistryForTesting()).toBeNull();
  });

  it('a fake ScaffoldingInstance + __exposeForBrowserVerify publishes the snapshot without throwing', () => {
    const vm = makeScaffoldingStub(undefined);
    // __bindEventsForTesting wires the asset-progress + stage-size
    // listeners; we don't need them here, but the helper is the
    // canonical way to mark the stub as "attached" for downstream
    // snapshot paths.
    expect(() => __bindEventsForTesting(vm)).not.toThrow();

    // __exposeForBrowserVerify is a no-op when no Scaffolding was
    // attached via initPlayer. Verify the no-throw contract without
    // requiring a real WebGL canvas.
    expect(() => __exposeForBrowserVerify()).not.toThrow();
  });
});

// --- helpers --------------------------------------------------------------

interface ProjectJson {
  targets: Array<{
    id?: string;
    name?: string;
    isStage?: boolean;
    blocks?: Record<string, { opcode: string; inputs?: unknown; fields?: unknown; next?: unknown; parent?: unknown; topLevel?: unknown; shadow?: unknown; x?: unknown; y?: unknown; mutation?: unknown }>;
    comments?: Record<string, { blockId: string; text: string }>;
    variables?: Record<string, unknown>;
  }>;
  comments?: Record<string, { blockId: string; text: string }>;
}

async function readProjectJson(buf: ArrayBuffer): Promise<ProjectJson> {
  // Local JSZip instance so we don't import from the test setup file
  // (which could be missing in non-jsdom vitest configs).
  const zip = new JSZip();
  await zip.loadAsync(buf);
  const text = await zip.file('project.json')?.async('string');
  if (!text) throw new Error('fixture: project.json missing');
  return JSON.parse(text) as ProjectJson;
}

function toParsedProjectFromJson(json: ProjectJson) {
  const targets = (json.targets ?? []).map((t, idx) => {
    const id = typeof t.id === 'string' && t.id.length > 0 ? t.id : `t${idx}`;
    const blocks: Record<string, { id: string; opcode: string; next: string | null; parent: string | null; inputs: Record<string, unknown>; fields: Record<string, unknown>; mutation?: unknown }> = {};
    for (const [bid, raw] of Object.entries(t.blocks ?? {})) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      blocks[bid] = {
        id: bid,
        opcode: typeof block.opcode === 'string' ? block.opcode : '',
        next: typeof block.next === 'string' ? block.next : null,
        parent: typeof block.parent === 'string' ? block.parent : null,
        inputs: isRecord(block.inputs) ? block.inputs : {},
        fields: isRecord(block.fields) ? block.fields : {},
        mutation: block.mutation,
      };
    }
    return { id, isStage: Boolean(t.isStage), blocks };
  });

  const comments: Record<string, { blockId: string; text: string }> = {};
  // Per-target comments take priority; fall back to top-level.
  for (const t of json.targets ?? []) {
    for (const [cid, c] of Object.entries(t.comments ?? {})) {
      if (!c || typeof c.blockId !== 'string' || typeof c.text !== 'string') continue;
      comments[cid] = { blockId: c.blockId, text: c.text };
    }
  }
  for (const [cid, c] of Object.entries(json.comments ?? {})) {
    if (!c || typeof c.blockId !== 'string' || typeof c.text !== 'string') continue;
    if (!comments[cid]) comments[cid] = { blockId: c.blockId, text: c.text };
  }

  return { targets, comments };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

describe('player.ts: §Phase 5 §15.9 / §15.14 diagnostics forwarding (source-inspection)', () => {
  function readPlayerSource(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    return fs.readFileSync(
      path.resolve(__dirname, '../../src/runtime/player.ts'),
      'utf8',
    );
  }

  it('routes extraction diagnostics through forwardGpuDiagnostics before the early-return guard', () => {
    const src = readPlayerSource();
    // The shared forwarder must be called with `extractionDiagnostics`
    // BEFORE the `if (verdicts.length === 0) return;` early return so
    // duplicate-`@compute` errors always reach the panel even when the
    // GPU pipeline drops every region.
    const forwardIdx = src.indexOf('forwardGpuDiagnostics(extractionDiagnostics)');
    const earlyReturnIdx = src.indexOf('if (verdicts.length === 0)');
    expect(forwardIdx, 'extraction forwarder call not found').toBeGreaterThan(-1);
    expect(earlyReturnIdx, 'verdicts.length guard not found').toBeGreaterThan(-1);
    expect(forwardIdx, 'extraction forwarder must run before the early-return').toBeLessThan(
      earlyReturnIdx,
    );
  });

  it('forwards verdict diagnostics through forwardGpuDiagnostics too', () => {
    const src = readPlayerSource();
    expect(src).toMatch(/forwardGpuDiagnostics\(verdicts\.flatMap\(\(v\)\s*=>\s*v\.diagnostics\)\)/);
  });

  it('forwards emitter diagnostics through forwardGpuDiagnostics after initializeGpuKernels', () => {
    const src = readPlayerSource();
    // The emitter diagnostics must be pushed into the store AFTER the
    // M5 boot so the warn cap is preserved per-source (M3 + extraction
    // vs M5).
    expect(src).toMatch(/forwardGpuDiagnostics\(result\.emitDiagnostics\s*\?\?\s*\[\]\)/);
  });
});
