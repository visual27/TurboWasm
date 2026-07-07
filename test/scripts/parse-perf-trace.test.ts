import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- the parser script is JS without its own .d.ts file
import { summarize, extractEvents } from '../../scripts/parse-perf-trace.mjs';

type TraceEvent = {
  name?: string;
  cat?: string;
  ph: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  args?: Record<string, unknown>;
};

function makeFakeTrace(events: TraceEvent[]): { traceEvents: TraceEvent[] } {
  return { traceEvents: events };
}

describe('parse-perf-trace', () => {
  it('extractEvents accepts a top-level traceEvents object', () => {
    const events: TraceEvent[] = [
      { name: 'DrawFrame', ph: 'X', ts: 1000, dur: 5, pid: 1, tid: 1 },
    ];
    expect(extractEvents(makeFakeTrace(events))).toEqual(events);
  });

  it('extractEvents accepts a bare array', () => {
    const events: TraceEvent[] = [{ name: 'DrawFrame', ph: 'X', ts: 0, dur: 0, pid: 1, tid: 1 }];
    expect(extractEvents(events)).toEqual(events);
  });

  it('extractEvents rejects malformed input', () => {
    expect(() => extractEvents({})).toThrow();
  });

  it('summarize counts main scripting and rendering correctly', () => {
    const events: TraceEvent[] = [
      { name: 'DrawFrame', ph: 'X', ts: 0, dur: 10, pid: 1, tid: 1 },
      { name: 'Function call', ph: 'X', ts: 0, dur: 4, pid: 1, tid: 1 },
      { name: 'Function call', ph: 'X', ts: 4, dur: 3, pid: 1, tid: 1 },
      { name: 'Paint', ph: 'X', ts: 7, dur: 2, pid: 1, tid: 1 },
      { name: 'CompositeLayers', ph: 'X', ts: 9, dur: 1, pid: 1, tid: 1 },
      // Worker should be classified separately
      { name: 'Function call', ph: 'X', ts: 0, dur: 6, pid: 2, tid: 5 },
    ];
    const s = summarize(events);
    expect(s.scriptingTime.main).toBe(7);
    expect(s.scriptingTime.workers).toBe(6);
    expect(s.renderingTime.total).toBeGreaterThanOrEqual(3);
    expect(s.paintingTime.total).toBeGreaterThanOrEqual(3);
    expect(s.frameCount).toBe(1);
  });

  it('summarize counts inter-frame deltas separately from frame count', () => {
    const events: TraceEvent[] = [
      { name: 'DrawFrame', ph: 'X', ts: 0, dur: 5, pid: 1, tid: 1 },
      { name: 'DrawFrame', ph: 'X', ts: 20, dur: 5, pid: 1, tid: 1 },
      { name: 'DrawFrame', ph: 'X', ts: 40, dur: 5, pid: 1, tid: 1 },
    ];
    const s = summarize(events);
    expect(s.frameCount).toBe(3);
    expect(s.averageFrameMs).toBeCloseTo(20, 5);
  });

  it('summarize returns top tasks sorted by total', () => {
    const events: TraceEvent[] = [
      { name: 'TaskA', ph: 'X', ts: 0, dur: 5, pid: 1, tid: 1 },
      { name: 'TaskA', ph: 'X', ts: 5, dur: 4, pid: 1, tid: 1 },
      { name: 'TaskB', ph: 'X', ts: 9, dur: 2, pid: 1, tid: 1 },
    ];
    const s = summarize(events);
    const topNames = s.topTasks.map((t: { name: string }) => t.name);
    expect(topNames[0]).toBe('TaskA');
    const ta = s.topTasks.find((t: { name: string }) => t.name === 'TaskA');
    expect(ta?.total).toBe(9);
  });

  it('summarize handles empty trace gracefully', () => {
    const s = summarize([]);
    expect(s.frameCount).toBe(0);
    expect(s.scriptingTime.total).toBe(0);
    expect(s.recordingMs).toBe(0);
  });
});
