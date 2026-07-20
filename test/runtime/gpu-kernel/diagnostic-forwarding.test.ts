import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatGpuDiagnosticMessage,
  forwardGpuDiagnostics,
} from '@/runtime/gpu-kernel/diagnostic-forwarding';
import type { Diagnostic } from '@/runtime/gpu-kernel/types';
import { useErrorLogStore } from '@/stores/useErrorLogStore';

function diag(partial: Partial<Diagnostic>): Diagnostic {
  return {
    severity: 'warn',
    code: 'gpu.test_code',
    message: 'test message',
    regionId: 'region:test',
    blockId: 'b1',
    ...partial,
  };
}

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
});

describe('formatGpuDiagnosticMessage', () => {
  it('prefixes the code and includes the region tag when present', () => {
    expect(
      formatGpuDiagnosticMessage(
        diag({ code: 'gpu.foo', regionId: 'region:abc:b1', message: 'hello' }),
      ),
    ).toBe('[gpu.foo region=region:abc:b1] hello');
  });

  it('omits the region tag when regionId is missing', () => {
    expect(
      formatGpuDiagnosticMessage(
        diag({ code: 'gpu.foo', regionId: undefined, message: 'hi' }),
      ),
    ).toBe('[gpu.foo] hi');
  });

  it('falls back to "gpu.diagnostic" when the code is empty', () => {
    // Region tag must be cleared too so the assertion isolates the
    // code fallback path: `gpu.foo` → `gpu.diagnostic`, regionTag → ``.
    expect(
      formatGpuDiagnosticMessage(
        diag({ code: '', regionId: undefined, message: 'noop' }),
      ),
    ).toBe('[gpu.diagnostic] noop');
  });
});

describe('forwardGpuDiagnostics: severity routing', () => {
  it('pushes error entries without capping', () => {
    const errors: Diagnostic[] = Array.from({ length: 20 }, (_, i) =>
      diag({ severity: 'error', code: `gpu.err_${i}`, message: `e${i}` }),
    );
    forwardGpuDiagnostics(errors);
    const entries = useErrorLogStore.getState().entries;
    expect(entries.filter((e) => e.severity === 'error')).toHaveLength(20);
  });

  it('caps warn at the default cap (5) and demotes the rest to info', () => {
    const warns: Diagnostic[] = Array.from({ length: 8 }, (_, i) =>
      diag({ severity: 'warn', code: `gpu.warn_${i}`, message: `w${i}` }),
    );
    forwardGpuDiagnostics(warns);
    const entries = useErrorLogStore.getState().entries;
    const warnEntries = entries.filter((e) => e.severity === 'warn');
    const infoEntries = entries.filter((e) => e.severity === 'info');
    expect(warnEntries).toHaveLength(5);
    expect(infoEntries).toHaveLength(3);
    expect(warnEntries.map((e) => e.message)).toEqual([
      '[gpu.warn_0 region=region:test] w0',
      '[gpu.warn_1 region=region:test] w1',
      '[gpu.warn_2 region=region:test] w2',
      '[gpu.warn_3 region=region:test] w3',
      '[gpu.warn_4 region=region:test] w4',
    ]);
    expect(infoEntries.map((e) => e.message)).toEqual([
      '[gpu.warn_5 region=region:test] w5',
      '[gpu.warn_6 region=region:test] w6',
      '[gpu.warn_7 region=region:test] w7',
    ]);
  });

  it('respects a custom warnCap', () => {
    const warns: Diagnostic[] = Array.from({ length: 3 }, (_, i) =>
      diag({ severity: 'warn', code: `gpu.w_${i}`, message: `m${i}` }),
    );
    forwardGpuDiagnostics(warns, { warnCap: 1 });
    const entries = useErrorLogStore.getState().entries;
    expect(entries.filter((e) => e.severity === 'warn')).toHaveLength(1);
    expect(entries.filter((e) => e.severity === 'info')).toHaveLength(2);
  });

  it('forwards info entries unchanged', () => {
    const infos: Diagnostic[] = Array.from({ length: 4 }, (_, i) =>
      diag({ severity: 'info', code: `gpu.i_${i}`, message: `i${i}` }),
    );
    forwardGpuDiagnostics(infos);
    const entries = useErrorLogStore.getState().entries;
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.severity === 'info')).toBe(true);
  });

  it('routes a mixed-severity batch through the same pipeline', () => {
    const batch: Diagnostic[] = [
      diag({ severity: 'error', code: 'gpu.e', message: 'e' }),
      diag({ severity: 'warn', code: 'gpu.w1', message: 'w1' }),
      diag({ severity: 'warn', code: 'gpu.w2', message: 'w2' }),
      diag({ severity: 'info', code: 'gpu.i', message: 'i' }),
    ];
    const summary = forwardGpuDiagnostics(batch);
    expect(summary).toEqual({
      total: 4,
      warned: 2,
      infoed: 1,
      errored: 1,
      skipped: 0,
    });
  });

  it('routes through a custom push target without touching the store', () => {
    const calls: Array<{ severity: string; message: string }> = [];
    forwardGpuDiagnostics(
      [
        diag({ severity: 'error', code: 'gpu.x', message: 'err' }),
        diag({ severity: 'warn', code: 'gpu.y', message: 'warn' }),
      ],
      {
        push: (severity, message): void => {
          calls.push({ severity, message });
        },
      },
    );
    expect(calls).toEqual([
      { severity: 'error', message: '[gpu.x region=region:test] err' },
      { severity: 'warn', message: '[gpu.y region=region:test] warn' },
    ]);
    expect(useErrorLogStore.getState().entries).toEqual([]);
  });
});
