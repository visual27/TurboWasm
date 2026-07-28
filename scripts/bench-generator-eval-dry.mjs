/**
 * §Phase 6 (generator research) — JSGenerator telemetry probe.
 *
 * Reads the `JSGenerator.testingApparatus` reports after compiling
 * each script under both interpreter and compiled modes and
 * reports the generator/plain classification counts plus the
 * per-script yield-density (= `function*` / total factory ratio).
 *
 * This script is the read-only counterpart of
 * `scripts/bench-generator-eval.mjs`: it never mutates the vendored
 * scratch-vm. Its job is to establish the baseline that the variant
 * benchmarks compare against.
 *
 * Usage:
 *   node scripts/bench-generator-eval-dry.mjs
 *   node scripts/bench-generator-eval-dry.mjs generator-granularity-fixture
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const FIXTURE_DIR = resolve(REPO_ROOT, 'test/.test-fixtures');
const LOG_DIR = resolve(REPO_ROOT, 'logs');

const DEFAULT_FIXTURES = [
  'generator-granularity-fixture.sb3',
  'procedure-lazy-cache-fixture.sb3',
  'compare-equal-fixture.sb3',
  'expo-fixture.sb3',
];

async function loadVendoredVm() {
  const vmDir = resolve(
    REPO_ROOT,
    'vendored/scaffolding/node_modules/scratch-vm',
  );
  if (!existsSync(vmDir)) {
    throw new Error(
      `vendored scratch-vm missing at ${vmDir}; run \`npm run setup\`.`,
    );
  }
  const cjsRequire = createRequire(import.meta.url);
  const VirtualMachine = cjsRequire(resolve(vmDir, 'src/index.js'));
  return { VirtualMachine, vmDir };
}

async function loadFixtureBuffer(fixturePath) {
  if (!existsSync(fixturePath)) {
    throw new Error(`fixture not found: ${fixturePath}`);
  }
  return readFileSync(fixturePath);
}

function attachTelemetry(vmDir) {
  const JSGenerator = createRequire(import.meta.url)(
    resolve(vmDir, 'src/compiler/jsgen.js'),
  );
  if (JSGenerator.testingApparatus) {
    return {
      detach() {},
      stats: JSGenerator.testingApparatus.__turboStats || {
        generator: 0,
        plain: 0,
        scripts: 0,
      },
    };
  }
  const stats = { generator: 0, plain: 0, scripts: 0 };
  JSGenerator.testingApparatus = {
    __turboStats: stats,
    report(jsgenInstance, factory) {
      stats.scripts += 1;
      if (/return function\* /.test(factory)) {
        stats.generator += 1;
      } else if (/return function /.test(factory)) {
        stats.plain += 1;
      }
    },
  };
  return {
    detach() {
      JSGenerator.testingApparatus = null;
    },
    stats,
  };
}

async function probeFixture(VirtualMachine, vmDir, fixtureName) {
  const fixturePath = resolve(FIXTURE_DIR, fixtureName);
  const projectBuffer = await loadFixtureBuffer(fixturePath);
  const vm = new VirtualMachine();
  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  vm.setCompilerOptions({ enabled: true });

  const ab = new ArrayBuffer(projectBuffer.byteLength);
  new Uint8Array(ab).set(projectBuffer);

  const telemetry = attachTelemetry(vmDir);

  try {
    await vm.loadProject(ab);
    vm.runtime.greenFlag();
    // One step is enough to force compilation of every reachable hat.
    vm.runtime._step();
  } finally {
    telemetry.detach();
    vm.runtime.stopAll();
  }

  return telemetry.stats;
}

async function main() {
  const args = process.argv.slice(2);
  const targetFixtures = args.length > 0 ? args : DEFAULT_FIXTURES;
  const { VirtualMachine, vmDir } = await loadVendoredVm();
  mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString();
  const report = {
    timestamp: stamp,
    fixtures: {},
    totals: { generator: 0, plain: 0, scripts: 0 },
  };
  // eslint-disable-next-line no-console
  console.log(`[bench-generator-eval-dry] fixture=${targetFixtures.join(',')}`);
  for (const fixtureName of targetFixtures) {
    // eslint-disable-next-line no-console
    console.log(`  probing ${fixtureName} ...`);
    const stats = await probeFixture(VirtualMachine, vmDir, fixtureName);
    report.fixtures[fixtureName] = stats;
    report.totals.generator += stats.generator;
    report.totals.plain += stats.plain;
    report.totals.scripts += stats.scripts;
    // eslint-disable-next-line no-console
    console.log(
      `    generator=${stats.generator}  plain=${stats.plain}  scripts=${stats.scripts}`,
    );
  }
  const jsonPath = resolve(LOG_DIR, 'bench-generator-eval-dry.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `[bench-generator-eval-dry] totals: generator=${report.totals.generator} plain=${report.totals.plain} scripts=${report.totals.scripts}`,
  );
  // eslint-disable-next-line no-console
  console.log(`[bench-generator-eval-dry] wrote ${jsonPath}`);
}

await main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench-generator-eval-dry] FAILED:', err);
  process.exit(1);
});
