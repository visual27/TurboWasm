import { describe, expect, it } from 'vitest';
import { fetchProjectFromId } from '@/services/scratch-project';
import { ProjectLoadError } from '@/types/project';

describe('services/scratch-project', () => {
  it('rejects empty id', async () => {
    await expect(fetchProjectFromId('')).rejects.toBeInstanceOf(ProjectLoadError);
  });

  it('rejects non-numeric id', async () => {
    await expect(fetchProjectFromId('abc')).rejects.toBeInstanceOf(ProjectLoadError);
  });

  it('attempts trampoline and falls back to scratch on failure', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push(url);
      // trampoline returns 404 → fallback to scratch → scratch metadata 404 → throws unshared
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      await expect(fetchProjectFromId('999999999')).rejects.toThrow(/unshared|not found|age/i);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toContain('trampoline.turbowarp.org');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});