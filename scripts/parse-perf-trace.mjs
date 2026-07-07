#!/usr/bin/env node
/**
 * Chrome DevTools Performance Trace parser for TurboWasm Viewer.
 *
 * Input: a Trace Event Format JSON file (`--input <path>`). The path may
 * be a `.json` or `.json.gz` blob; gzipped input is decompressed on the
 * fly (the `zlib` module is built into Node).
 *
 * Output (stdout): a JSON summary containing per-trace recording
 * statistics plus per-frame timing breakdowns:
 *   - scriptingTime.total / main / workers (ms)
 *   - paintingTime.total (ms)
 *   - renderingTime.total (ms)
 *   - idleTime (ms)
 *   - frameCount
 *   - averageFrameMs / p50FrameMs / p95FrameMs
 *   - perFrame: [{ t, dt, scripting, rendering, painting }] (capped, see --max-frames)
 *
 * Flags:
 *   --input <path>     Path to trace.json or trace.json.gz (required)
 *   --label <name>     Optional label embedded in the summary under `label`
 *   --max-frames <n>   Cap perFrame to the first N entries (default 240)
 *   --output <path>    Write the summary to this file instead of stdout
 *   --compare <a> <b>  Diff mode; accepts two --input values and prints a
 *                      delta summary to stdout.
 *   --help             Show usage and exit.
 *
 * The parser only depends on Node's built-ins so it works in environments
 * where the rest of the project's toolchain is not installed.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} p
 * @returns {any}
 */
function readJsonMaybeGz(p) {
  const abs = resolve(p);
  if (!existsSync(abs)) {
    throw new Error(`Input not found: ${abs}`);
  }
  const raw = readFileSync(abs);
  const text = abs.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return JSON.parse(text);
}

/**
 * Trace Event Format top-level: { traceEvents: TraceEvent[] }.
 * Each event has at minimum { name, cat, ph, ts, pid, tid, args? }.
 * @param {any} trace
 */
function extractEvents(trace) {
  if (Array.isArray(trace?.traceEvents)) return trace.traceEvents;
  if (Array.isArray(trace)) return trace;
  throw new Error('input does not look like a Trace Event Format document');
}

/**
 * Compute summary metrics from a list of Trace Events.
 * @param {any[]} events
 * @param {{maxFrames?: number}} [opts]
 */
function summarize(events, opts = {}) {
  const maxFrames = opts.maxFrames ?? 240;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  /** @type {Map<string, {self: number, total: number}>} */
  const taskByName = new Map();
  /** @type {Map<number, {kind: 'X'|'B'|'E', ts: number, name?: string}>} */
  const openByTid = new Map();

  let mainThreadId = null;
  // Frame heuristics: walk `CompositorCommitter` and `DrawFrame` events.
  /** @type {Array<{t: number, dt: number, scripting: number, rendering: number, painting: number}>} */
  const frames = [];
  let lastDrawTs = null;

  // Walk once to discover the main thread (the one running `v8.callFunction`
  // / `Function call` events; fallback to the busiest script-running tid).
  const scriptTidCount = new Map();
  for (const ev of events) {
    if (ev.ph !== 'X' && ev.ph !== 'B' && ev.ph !== 'E') continue;
    if (typeof ev.ts !== 'number') continue;
    minTs = Math.min(minTs, ev.ts);
    maxTs = Math.max(maxTs, ev.ts);
    if (ev.ph === 'X' && (ev.name === 'Function call' || ev.name === 'v8.callFunction')) {
      const k = `${ev.pid}:${ev.tid}`;
      scriptTidCount.set(k, (scriptTidCount.get(k) ?? 0) + 1);
    }
  }

  let busiestKey = null;
  let busiestCount = -1;
  for (const [k, n] of scriptTidCount) {
    if (n > busiestCount) {
      busiestKey = k;
      busiestCount = n;
    }
  }
  if (busiestKey) {
    mainThreadId = busiestKey;
  }

  let mainScripting = 0;
  let workerScripting = 0;
  let painting = 0;
  let rendering = 0;
  let idle = 0;

  // Frame time tracking (rough approximation).
  const FRAME_BUDGET_MS = 16.67;

  function getCurThread() {
    return mainThreadId ? mainThreadId.split(':')[1] : null;
  }

  function bucketTask(name, durMs) {
    if (!name) return;
    const cur = taskByName.get(name) ?? { self: 0, total: 0 };
    cur.total += durMs;
    taskByName.set(name, cur);
  }

  // First pass: complete events (ph === 'X').
  for (const ev of events) {
    if (ev.ph !== 'X') continue;
    if (typeof ev.ts !== 'number' || typeof ev.dur !== 'number') continue;
    const durMs = ev.dur;
    bucketTask(ev.name, durMs);

    const threadKey = `${ev.pid}:${ev.tid}`;
    const isMain = threadKey === mainThreadId;
    if (isMain) {
      if (
        ev.name === 'Function call' ||
        ev.name === 'v8.callFunction' ||
        ev.name === 'V8.Execute' ||
        ev.name === 'EvaluateScript' ||
        ev.name === 'EventDispatch'
      ) {
        mainScripting += durMs;
      } else if (ev.name && /^(CompositorCommitter|DrawFrame|Rasterize|UpdateLayout|Paint|PaintSetup|CompositeLayers|Layout|UpdateLayerTree|PreCommit|Commit)/.test(ev.name)) {
        rendering += durMs;
        if (ev.name.startsWith('Paint') || ev.name === 'CompositeLayers') {
          painting += durMs;
        }
      }
    } else {
      // Worker / other threads
      if (
        ev.name === 'Function call' ||
        ev.name === 'v8.callFunction' ||
        ev.name === 'V8.Execute'
      ) {
        workerScripting += durMs;
      }
    }

    if (ev.name === 'DrawFrame') {
      const t = ev.ts;
      const dt = lastDrawTs === null ? 0 : t - lastDrawTs;
      lastDrawTs = t;
      if (frames.length < maxFrames) {
        frames.push({ t, dt, scripting: 0, rendering: 0, painting: 0 });
      }
    }
  }

  // Synthesize per-frame scripting allocations by walking timing buckets in
  // order (this is a coarse approximation: total main scripting spread over
  // observed frames in proportion to the frame budget).
  if (frames.length > 0) {
    const totalBudget = frames.length * FRAME_BUDGET_MS;
    const scale = totalBudget > 0 ? mainScripting / totalBudget : 0;
    for (const f of frames) {
      f.scripting = Math.min(FRAME_BUDGET_MS, Math.max(0, scale * FRAME_BUDGET_MS));
      f.rendering = Math.min(FRAME_BUDGET_MS, Math.max(0, rendering / frames.length));
      f.painting = Math.min(FRAME_BUDGET_MS, Math.max(0, painting / frames.length));
    }
  }

  const recordingMs = Number.isFinite(maxTs) && Number.isFinite(minTs)
    ? Math.max(0, maxTs - minTs)
    : 0;

  idle = Math.max(0, recordingMs - mainScripting - workerScripting - rendering);

  // Only count inter-frame deltas (dt > 0). The first frame's dt is always
  // 0 because `lastDrawTs` starts null, but the frame itself is still real
  // — filter just removes that sentinel from the timing stats.
  const frameTimes = frames.map((f) => f.dt).filter((dt) => dt > 0);
  frameTimes.sort((a, b) => a - b);

  /** @param {number} p */
  function percentile(p) {
    if (frameTimes.length === 0) return 0;
    const idx = Math.min(frameTimes.length - 1, Math.floor((p / 100) * frameTimes.length));
    return frameTimes[idx] ?? 0;
  }

  /** @type {Array<{name: string, total: number, self: number}>} */
  const topTasks = Array.from(taskByName.entries())
    .map(([name, agg]) => ({ name, total: agg.total, self: agg.self }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 25);

  return {
    recordingMs,
    mainThreadId,
    scriptingTime: {
      total: round2(mainScripting + workerScripting),
      main: round2(mainScripting),
      workers: round2(workerScripting),
    },
    renderingTime: { total: round2(rendering) },
    paintingTime: { total: round2(painting) },
    idleTime: round2(idle),
    frameCount: frames.length,
    averageFrameMs: round2(frameTimes.length === 0 ? 0 : frameTimes.reduce((s, n) => s + n, 0) / frameTimes.length),
    p50FrameMs: round2(percentile(50)),
    p95FrameMs: round2(percentile(95)),
    topTasks,
    perFrame: frames,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function usage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      'parse-perf-trace.mjs — Chrome DevTools Performance Trace summarizer',
      '',
      'Usage:',
      '  node scripts/parse-perf-trace.mjs --input <trace.json[.gz]> [--label <n>] [--output <path>] [--max-frames <n>]',
      '  node scripts/parse-perf-trace.mjs --compare <a.json> <b.json>',
      '  node scripts/parse-perf-trace.mjs --help',
      '',
      'Options:',
      '  --input <path>     Path to trace.json or trace.json.gz (required unless --compare)',
      '  --label <name>     Label to embed in the JSON summary',
      '  --output <path>    Write JSON summary to this file instead of stdout',
      '  --max-frames <n>   Cap perFrame array length (default 240)',
      '  --compare <a> <b>  Compare two traces and print delta summary',
      '  --help             Show this help',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  /** @type {Record<string, string | boolean | string[]>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--input' || a === '-i') {
      out.input = argv[++i];
    } else if (a === '--label') {
      out.label = argv[++i];
    } else if (a === '--output' || a === '-o') {
      out.output = argv[++i];
    } else if (a === '--max-frames') {
      out.maxFrames = argv[++i];
    } else if (a === '--compare') {
      out.compare = [argv[++i], argv[++i]];
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const maxFrames = args.maxFrames ? Number(args.maxFrames) : 240;
  if (args.compare && Array.isArray(args.compare)) {
    const [a, b] = args.compare;
    const traceA = readJsonMaybeGz(a);
    const traceB = readJsonMaybeGz(b);
    const sumA = summarize(extractEvents(traceA), { maxFrames });
    const sumB = summarize(extractEvents(traceB), { maxFrames });
    const diff = {
      labelA: a,
      labelB: b,
      deltaRecordingMs: round2(sumB.recordingMs - sumA.recordingMs),
      deltaScriptingTotal: round2(sumB.scriptingTime.total - sumA.scriptingTime.total),
      deltaScriptingMain: round2(sumB.scriptingTime.main - sumA.scriptingTime.main),
      deltaRendering: round2(sumB.renderingTime.total - sumA.renderingTime.total),
      deltaPainting: round2(sumB.paintingTime.total - sumA.paintingTime.total),
      deltaP50FrameMs: round2(sumB.p50FrameMs - sumA.p50FrameMs),
      deltaP95FrameMs: round2(sumB.p95FrameMs - sumA.p95FrameMs),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(diff, null, 2));
    process.exit(0);
  }
  if (!args.input || typeof args.input !== 'string') {
    usage();
    process.exit(2);
  }
  const trace = readJsonMaybeGz(args.input);
  const events = extractEvents(trace);
  const summary = summarize(events, { maxFrames });
  const label = args.label;
  /** @type {Record<string, unknown>} */
  const out = { ...summary };
  if (label) out.label = label;
  const json = JSON.stringify(out, null, 2);
  if (typeof args.output === 'string') {
    writeFileSync(resolve(args.output), json, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${args.output}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(json);
  }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(here)) {
  try {
    main();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[parse-perf-trace] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

export { summarize, extractEvents };
