#!/usr/bin/env node
/**
 * §Phase 6 (generator research) — variant benchmark harness.
 *
 * Compares three generator strategies on the generator-granularity
 * fixture (and three cross-validation fixtures):
 *
 *   - `baseline` — current vendored scratch-vm. Top-level scripts
 *     that contain any yielding opcode (`wait`, `say`,
 *     `broadcast and wait`, etc.) are emitted as `function*`.
 *     Pure procedures and warp-only procedures may still be emitted
 *     as `function`. This is the measurement control.
 *
 *   - `eval-X` — §Phase 6 prototype of the pure-interval
 *     extraction proposal. After `JSGenerator.compile()` finishes
 *     emitting the source, the variant scans the source string
 *     for the `yield` keyword. If zero yields are found but
 *     `script.yields === true`, the variant flips `script.yields`
 *     to `false` and emits the script as `function` instead of
 *     `function*`. This catches IR analyses that over-classified
 *     a script as yielding (e.g., a hat with an always-true
 *     predicate condition or a procedure body that the IRGen
 *     conservatively marks as yielding). The runtime semantics
 *     are preserved because a generator with no `yield`
 *     statements behaves identically to a plain function.
 *
 *   - `eval-Y` — §Phase 6 prototype of the two-tier emit
 *     proposal. After `IRGenerator.generate()` produces the
 *     `procedures` map, the variant removes entries whose
 *     procedureCode is never referenced from the call sites.
 *     This is the IR-level half of the proposal: a procedure
 *     whose only call site is inside a warp loop can drop the
 *     non-warp variant, and vice versa, when one variant has
 *     zero references. The variant does not introduce new
 *     variants — it only removes unused ones — so it cannot
 *     change call-site semantics. The reduction in factory
 *     work should show up as a small compile-time delta but
 *     not as a runtime win (the runtime gate is unchanged).
 *
 * Variants are installed via runtime monkey-patching (= vendored
 * scratch-vm `JSGenerator.prototype.compile` / `IRGenerator.
 * prototype.generate`). The reference patches
 * (`patches/vendored/scratch-vm-eval-generator-{X,Y}.patch`) are
 * NOT auto-applied; the monkey-patches mirror their intent so we
 * can A/B compare without rebuilding the UMD.
 *
 * Usage
 * -----
 *   node scripts/bench-generator-eval.mjs                  # all fixtures × all variants, N=10
 *   node scripts/bench-generator-eval.mjs --dry            # print config + exit
 *   node scripts/bench-generator-eval.mjs generator-granularity-fixture
 *   BENCH_N=30 node scripts/bench-generator-eval.mjs
 *
 * Output
 * ------
 *   ./logs/bench-generator-eval.out                 (regression history, append)
 *   ./logs/bench-generator-eval-{fixture}-{variant}.json  (per-variant snapshot)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const FIXTURE_DIR = resolve(REPO_ROOT, 'test/.test-fixtures');
const LOG_DIR = resolve(REPO_ROOT, 'logs');

const DEFAULT_WARMUP_RUNS = 3;
const DEFAULT_MEASURE_FRAMES = 200;
const DEFAULT_N = 15;

const VARIANTS = ['baseline', 'eval-X', 'eval-Y'];
const FIXTURES = [
  'generator-granularity-fixture.sb3',
  'procedure-lazy-cache-fixture.sb3',
  'compare-equal-fixture.sb3',
  'expo-fixture.sb3',
];

/**
 * @typedef {'baseline' | 'eval-X' | 'eval-Y'} Variant
 */

function quantile(sortedAsc, q) {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx];
}

function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/**
 * Patch the vendored scratch-vm `JSGenerator.prototype.compile` to
 * catch IRGen over-classification: if the emitted source contains
 * zero `yield` statements but `script.yields === true`, force
 * `script.yields = false` so `createScriptFactory` emits a plain
 * `function` instead of a `function*`. Returns a teardown that
 * restores the original prototype methods.
 */
function installVariantX(vmDir) {
  const JSGenerator = createRequire(import.meta.url)(
    resolve(vmDir, 'src/compiler/jsgen.js'),
  );
  const original = JSGenerator.prototype.compile;
  let pureFlips = 0;
  let totalCompiled = 0;
  JSGenerator.prototype.compile = function evalXCompile() {
    totalCompiled += 1;
    const result = original.apply(this, arguments);
    if (this.script && this.script.yields === true) {
      const hasYield = /\byield\b/.test(this.source);
      if (!hasYield) {
        this.script.yields = false;
        pureFlips += 1;
        // Re-run the factory + scopedEval with the corrected flag
        // so the returned compiled function is a `function` instead
        // of a `function*`. We mirror `createScriptFactory` +
        // `jsexecute.scopedEval` exactly because the vendored code
        // does the same in `compile()`.
        const jsexecute = createRequire(import.meta.url)(
          resolve(vmDir, 'src/compiler/jsexecute.js'),
        );
        const factory = this.createScriptFactory();
        return jsexecute.scopedEval(factory);
      }
    }
    return result;
  };
  return {
    telemetry: () => ({ pureFlips, totalCompiled }),
    detach() {
      JSGenerator.prototype.compile = original;
    },
  };
}

/**
 * Patch the vendored scratch-vm `IRGenerator.prototype.generate`
 * to remove procedure variants whose `procedureCode` is never
 * referenced from any call site (= dead-code elimination at the
 * procedure variant level). Returns a teardown that restores the
 * original prototype method.
 */
function installVariantY(vmDir) {
  const irgenModule = createRequire(import.meta.url)(
    resolve(vmDir, 'src/compiler/irgen.js'),
  );
  const { IRGenerator } = irgenModule;
  const original = IRGenerator.prototype.generate;
  let generatedTotal = 0;
  let prunedVariants = 0;
  IRGenerator.prototype.generate = function evalYGenerate(...args) {
    generatedTotal += 1;
    const result = original.apply(this, args);
    // Walk the entry + procedures to collect referenced procedureCodes.
    // The procedure call lives at `node.inputs.code` for the
    // reporter-style `procedures.call` opcode and at
    // `block.inputs.code` for the stack-style `procedures_call`
    // opcode. The walker must descend into the input tree to
    // catch reporter-style calls embedded in var.set / if / etc.
    const referencedCodes = new Set();
    const walkInputNode = (node) => {
      if (!node || typeof node !== 'object') return;
      if (
        (node.opcode === 'procedures.call' || node.opcode === 'procedures_call') &&
        node.inputs &&
        typeof node.inputs.code === 'string'
      ) {
        referencedCodes.add(node.inputs.code);
      }
      if (node.inputs && typeof node.inputs === 'object') {
        for (const k of Object.keys(node.inputs)) {
          walkInputNode(node.inputs[k]);
        }
      }
      if (node.arguments && typeof node.arguments === 'object') {
        for (const k of Object.keys(node.arguments)) {
          walkInputNode(node.arguments[k]);
        }
      }
    };
    const walkStack = (stack) => {
      if (!stack || !stack.blocks) return;
      for (const block of stack.blocks) {
        if (
          block.opcode === 'procedures_call' &&
          block.inputs &&
          typeof block.inputs.code === 'string'
        ) {
          referencedCodes.add(block.inputs.code);
        }
        if (block.inputs) {
          for (const k of Object.keys(block.inputs)) {
            walkInputNode(block.inputs[k]);
          }
        }
        if (block.substacks) {
          for (const k of Object.keys(block.substacks)) {
            walkStack(block.substacks[k]);
          }
        }
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = result.entry;
    walkStack(entry?.stack);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const proc of Object.values(result.procedures || {})) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      walkStack(proc?.stack);
    }
    // procedure map: remove entries whose procedureCode (extracted
    // from the variant key, which is `W/Z` + proccode) is not
    // referenced.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const procedureMap = result.procedures || {};
    for (const variantKey of Object.keys(procedureMap)) {
      // The vendored `parseProcedureCode` strips the W/Z prefix.
      const procedureCode = variantKey.substring(1);
      if (!referencedCodes.has(procedureCode)) {
        delete procedureMap[variantKey];
        prunedVariants += 1;
      }
    }
    return result;
  };
  return {
    telemetry: () => ({ generatedTotal, prunedVariants }),
    detach() {
      IRGenerator.prototype.generate = original;
    },
  };
}

/**
 * @param {{ VirtualMachine: any, vmDir: string, projectBuffer: Buffer, frames: number, variant: Variant }} params
 */
async function runOnce({ VirtualMachine, vmDir, projectBuffer, frames, variant }) {
  const vm = new VirtualMachine();
  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  vm.setCompilerOptions({ enabled: true });

  const ab = new ArrayBuffer(projectBuffer.byteLength);
  new Uint8Array(ab).set(projectBuffer);

  let teardown = () => undefined;
  let telemetry = () => ({});
  if (variant === 'eval-X') {
    const installed = installVariantX(vmDir);
    teardown = installed.detach;
    telemetry = installed.telemetry;
  } else if (variant === 'eval-Y') {
    const installed = installVariantY(vmDir);
    teardown = installed.detach;
    telemetry = installed.telemetry;
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = process.hrtime.bigint();
  let threw = null;
  let finalValues = null;
  try {
    await vm.loadProject(ab);
    vm.runtime.greenFlag();
    for (let i = 0; i < frames; i++) {
      vm.runtime._step();
    }
    // Snapshot the deterministic final state for the
    // semantic-regression guard. `stopAll()` is called inside
    // `finally` so the snapshot sees the post-execution values
    // (= the work has been done; only monitor / wait-thread
    // survivors might still be in `runtime.threads`).
    const snapshot = {};
    for (const t of vm.runtime.targets) {
      if (t.isStage) continue;
      for (const varId of Object.keys(t.variables || {})) {
        const v = t.variables[varId];
        if (v && typeof v.name === 'string') {
          snapshot[v.name] = v.value;
        }
      }
    }
    finalValues = snapshot;
  } catch (err) {
    threw = err;
  } finally {
    teardown();
    vm.runtime.stopAll();
  }
  const elapsedNs = process.hrtime.bigint() - startedAt;
  const elapsedMs = Number(elapsedNs) / 1_000_000;
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    elapsedMs,
    threw,
    finalValues,
    telemetry: telemetry(),
    heapDeltaMB: (heapAfter - heapBefore) / (1024 * 1024),
  };
}

/**
 * @param {{ VirtualMachine: any, vmDir: string, projectBuffer: Buffer, warmupRuns: number, measureFrames: number, n: number, variant: Variant }} params
 */
async function benchVariant(params) {
  for (let i = 0; i < params.warmupRuns; i++) {
    await runOnce(params);
  }
  const samples = [];
  const heapBefore = process.memoryUsage().heapUsed;
  let lastTelemetry = null;
  let lastFinalValues = null;
  let threwFirst = null;
  for (let i = 0; i < params.n; i++) {
    const r = await runOnce(params);
    if (r.threw && !threwFirst) threwFirst = r.threw.message;
    samples.push(r.elapsedMs);
    lastTelemetry = r.telemetry;
    lastFinalValues = r.finalValues;
  }
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    variant: params.variant,
    samples,
    stats: summarize(samples),
    heapDeltaMB: (heapAfter - heapBefore) / (1024 * 1024),
    telemetry: lastTelemetry,
    finalValues: lastFinalValues,
    threwFirst,
  };
}

function renderSummary(result) {
  const s = result.stats;
  const telem = result.telemetry
    ? Object.entries(result.telemetry)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
  return (
    `variant=${result.variant}  n=${s.n}  median=${s.median.toFixed(2)}ms  ` +
    `p95=${s.p95.toFixed(2)}ms  min=${s.min.toFixed(2)}ms  max=${s.max.toFixed(2)}ms  ` +
    `heapDelta=${result.heapDeltaMB.toFixed(2)}MB  ${telem}`
  );
}

function renderVerdict(baseline, evaled) {
  if (!baseline || !evaled) return '';
  const b = baseline.stats.median;
  const e = evaled.stats.median;
  const pct = ((b - e) / b) * 100;
  let label;
  if (pct >= 5) {
    label = `WIN (${evaled.variant} is ${pct.toFixed(1)}% faster than baseline)`;
  } else if (pct <= -5) {
    label = `LOSS (${evaled.variant} is ${Math.abs(pct).toFixed(1)}% slower than baseline)`;
  } else {
    label = `NEUTRAL (within ±5%)`;
  }
  return `verdict: ${label}\n  baseline median=${b.toFixed(2)}ms  evaled median=${e.toFixed(2)}ms`;
}

async function loadVendoredVm() {
  const vmDir = resolve(
    REPO_ROOT,
    'vendored/scaffolding/node_modules/scratch-vm',
  );
  if (!existsSync(vmDir)) {
    throw new Error(`vendored scratch-vm missing at ${vmDir}; run \`npm run setup\`.`);
  }
  const cjsRequire = createRequire(import.meta.url);
  const VirtualMachine = cjsRequire(resolve(vmDir, 'src/index.js'));
  return { VirtualMachine, vmDir };
}

async function loadFixtureBuffer(fixturePath) {
  if (!existsSync(fixturePath)) {
    throw new Error(`fixture not found: ${fixturePath}. Run \`npm run fixtures:setup\`.`);
  }
  return readFileSync(fixturePath);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      dry: { type: 'boolean', default: false },
      variant: { type: 'string', default: '' },
      warmup: { type: 'string', default: String(DEFAULT_WARMUP_RUNS) },
      frames: { type: 'string', default: String(DEFAULT_MEASURE_FRAMES) },
      n: { type: 'string', default: process.env.BENCH_N ?? String(DEFAULT_N) },
    },
    allowPositionals: true,
  });

  const warmupRuns = Number.parseInt(values.warmup, 10);
  const measureFrames = Number.parseInt(values.frames, 10);
  const n = Number.parseInt(values.n, 10);
  const onlyVariant = values.variant ? values.variant : null;
  const onlyFixture = positionals[0] ?? null;

  const fixtures = onlyFixture ? [onlyFixture] : [...FIXTURES];
  const variants = onlyVariant ? [onlyVariant] : [...VARIANTS];

  if (values.dry) {
    // eslint-disable-next-line no-console
    console.log('[bench-generator-eval --dry]');
    // eslint-disable-next-line no-console
    console.log(
      `  BENCH_N=${n}  WARMUP_RUNS=${warmupRuns}  MEASURE_FRAMES=${measureFrames}`,
    );
    // eslint-disable-next-line no-console
    console.log(`  fixtures=${fixtures.join(', ')}`);
    // eslint-disable-next-line no-console
    console.log(`  variants=${variants.join(', ')}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[bench-generator-eval] BENCH_N=${n} WARMUP_RUNS=${warmupRuns} MEASURE_FRAMES=${measureFrames}`,
  );

  const { VirtualMachine, vmDir } = await loadVendoredVm();
  mkdirSync(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const logPath = resolve(LOG_DIR, 'bench-generator-eval.out');

  for (const fixtureName of fixtures) {
    const baseName = fixtureName.endsWith('.sb3') ? fixtureName : `${fixtureName}.sb3`;
    const fixturePath = resolve(FIXTURE_DIR, baseName);
    const projectBuffer = await loadFixtureBuffer(fixturePath);
    const fixtureBase = fixtureName.replace(/\.sb3$/u, '');
    // eslint-disable-next-line no-console
    console.log(`\n=== fixture=${fixtureName} ===`);
    const results = {};
    for (const variant of variants) {
      const r = await benchVariant({
        VirtualMachine,
        vmDir,
        projectBuffer,
        warmupRuns,
        measureFrames,
        n,
        variant,
      });
      results[variant] = r;
      // eslint-disable-next-line no-console
      console.log('  ' + renderSummary(r));
      const snapshot = {
        fixture: fixtureName,
        variant,
        warmupRuns,
        measureFrames,
        n,
        stats: r.stats,
        heapDeltaMB: r.heapDeltaMB,
        telemetry: r.telemetry,
        finalValues: r.finalValues,
        threwFirst: r.threwFirst,
        timestamp: new Date().toISOString(),
      };
      const jsonPath = resolve(
        LOG_DIR,
        `bench-generator-eval-${fixtureBase}-${variant}-${timestamp}.json`,
      );
      writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));
    }
    if (results.baseline && results['eval-X']) {
      // eslint-disable-next-line no-console
      console.log('  ' + renderVerdict(results.baseline, results['eval-X']));
    }
    if (results.baseline && results['eval-Y']) {
      // eslint-disable-next-line no-console
      console.log('  ' + renderVerdict(results.baseline, results['eval-Y']));
    }
    const body =
      `\n=== ${timestamp} ===\nfixture=${fixtureName}\n` +
      variants.map((v) => '  ' + renderSummary(results[v])).join('\n') +
      '\n';
    writeFileSync(logPath, body, { flag: 'a' });
  }
}

await main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench-generator-eval] FAILED:', err);
  process.exit(1);
});
