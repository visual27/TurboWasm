import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectLoader } from '@/features/project-loader/useProjectLoader';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { ProjectLoadError } from '@/types/project';

const loadProjectFromFileMock = vi.fn();
const loadProjectFromArrayBufferMock = vi.fn();
const loadProjectFromIdMock = vi.fn();

vi.mock('@/runtime/player', () => ({
  loadProjectFromFile: (...args: unknown[]) => loadProjectFromFileMock(...args),
  loadProjectFromArrayBuffer: (...args: unknown[]) => loadProjectFromArrayBufferMock(...args),
  loadProjectFromId: (...args: unknown[]) => loadProjectFromIdMock(...args),
}));

function pushEntries() {
  return useErrorLogStore.getState().entries.map((e) => ({ severity: e.severity, message: e.message }));
}

beforeEach(() => {
  useErrorLogStore.setState({ entries: [] });
  useProjectStore.setState({ currentId: null, metadata: null, source: null, loadState: 'idle' });
  loadProjectFromFileMock.mockReset();
  loadProjectFromArrayBufferMock.mockReset();
  loadProjectFromIdMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useProjectLoader.loadFile', () => {
  it('success path: setLoading → setReadyFromFile → info log', async () => {
    loadProjectFromFileMock.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useProjectLoader());
    const file = new File(['x'], 'demo.sb3', { type: 'application/octet-stream' });

    await act(async () => {
      await result.current.loadFile(file);
    });

    expect(loadProjectFromFileMock).toHaveBeenCalledExactlyOnceWith(file);
    expect(useProjectStore.getState().loadState).toBe('ready');
    expect(useProjectStore.getState().source).toBe('file');
    expect(pushEntries()).toEqual([{ severity: 'info', message: 'Loaded "demo.sb3".' }]);
  });

  it('error path: ProjectLoadError messages vary by kind', async () => {
    const { result } = renderHook(() => useProjectLoader());
    const file = new File(['x'], 'broken.sb3');

    const kinds: Array<[ProjectLoadError['kind'], string]> = [
      ['not_found', 'broken.sb3: Project not found.'],
      ['unshared', 'broken.sb3: Project is unshared, private, or age-restricted.'],
      ['age_restricted', 'broken.sb3: Project is age-restricted and cannot be loaded.'],
      ['network', 'broken.sb3: Network error while fetching.'],
      ['invalid', 'broken.sb3: custom invalid reason'],
    ];

    for (const [kind, expected] of kinds) {
      useErrorLogStore.setState({ entries: [] });
      loadProjectFromFileMock.mockRejectedValueOnce(new ProjectLoadError(kind, 'custom invalid reason'));
      await act(async () => {
        await result.current.loadFile(file);
      });
      expect(useProjectStore.getState().loadState).toBe('error');
      expect(pushEntries()).toEqual([{ severity: 'error', message: expected }]);
    }
  });

  it('error path: non-ProjectLoadError falls back to err.message', async () => {
    loadProjectFromFileMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useProjectLoader());
    const file = new File(['x'], 'plain.sb3');

    await act(async () => {
      await result.current.loadFile(file);
    });

    expect(pushEntries()).toEqual([{ severity: 'error', message: 'plain.sb3: boom' }]);
  });

  it('error path: unknown non-Error throw becomes "Unknown error."', async () => {
    loadProjectFromFileMock.mockRejectedValueOnce('not-an-error');
    const { result } = renderHook(() => useProjectLoader());
    const file = new File(['x'], 'weird.sb3');

    await act(async () => {
      await result.current.loadFile(file);
    });

    expect(pushEntries()).toEqual([{ severity: 'error', message: 'weird.sb3: Unknown error.' }]);
  });
});

describe('useProjectLoader.loadById', () => {
  it('rejects unparseable IDs without hitting the player', async () => {
    const { result } = renderHook(() => useProjectLoader());

    await act(async () => {
      await result.current.loadById('not-a-number');
    });

    expect(loadProjectFromIdMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().loadState).toBe('error');
    expect(pushEntries()).toEqual([
      {
        severity: 'error',
        message: 'not-a-number: Project ID must be a numeric string or Scratch/TurboWarp URL.',
      },
    ]);
  });

  it('happy path with metadata: setReadyFromId is used', async () => {
    const metadata = { id: '1197296165', title: 't', author: { username: 'u' } };
    loadProjectFromIdMock.mockResolvedValueOnce({ metadata, data: new ArrayBuffer(0) });
    const { result } = renderHook(() => useProjectLoader());

    await act(async () => {
      await result.current.loadById('https://scratch.mit.edu/projects/1197296165');
    });

    expect(loadProjectFromIdMock).toHaveBeenCalledExactlyOnceWith('1197296165');
    const state = useProjectStore.getState();
    expect(state.loadState).toBe('ready');
    expect(state.source).toBe('id');
    expect(state.currentId).toBe('1197296165');
    expect(state.metadata).toEqual(metadata);
    expect(pushEntries()).toEqual([{ severity: 'info', message: 'Loaded project 1197296165.' }]);
  });

  it('falls back to setReadyFromFile when metadata is null', async () => {
    loadProjectFromIdMock.mockResolvedValueOnce({ metadata: null, data: new ArrayBuffer(0) });
    const { result } = renderHook(() => useProjectLoader());

    await act(async () => {
      await result.current.loadById('1197296165');
    });

    const state = useProjectStore.getState();
    expect(state.loadState).toBe('ready');
    expect(state.source).toBe('file');
    expect(state.metadata).toBeNull();
    expect(state.currentId).toBeNull();
  });

  it('ProjectLoadError surfaces with the #<id> label', async () => {
    loadProjectFromIdMock.mockRejectedValueOnce(new ProjectLoadError('unshared', 'private'));
    const { result } = renderHook(() => useProjectLoader());

    await act(async () => {
      await result.current.loadById('https://turbowarp.org/1197296165/editor');
    });

    expect(pushEntries()).toEqual([
      {
        severity: 'error',
        message: '#1197296165: Project is unshared, private, or age-restricted.',
      },
    ]);
  });
});

describe('useProjectLoader.loadArrayBuffer', () => {
  it('delegates to loadProjectFromArrayBuffer with the provided label', async () => {
    loadProjectFromArrayBufferMock.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useProjectLoader());
    const buf = new ArrayBuffer(0);

    await act(async () => {
      await result.current.loadArrayBuffer(buf, 'dropped.sb3');
    });

    expect(loadProjectFromArrayBufferMock).toHaveBeenCalledExactlyOnceWith(buf);
    expect(useProjectStore.getState().loadState).toBe('ready');
    expect(useProjectStore.getState().source).toBe('file');
    expect(pushEntries()).toEqual([{ severity: 'info', message: 'Loaded "dropped.sb3".' }]);
  });

  it('error path surfaces the loader\'s Error message verbatim', async () => {
    loadProjectFromArrayBufferMock.mockRejectedValueOnce(new ProjectLoadError('invalid', 'bad zip'));
    const { result } = renderHook(() => useProjectLoader());

    await act(async () => {
      await result.current.loadArrayBuffer(new ArrayBuffer(0), 'broken.sb3');
    });

    expect(pushEntries()).toEqual([{ severity: 'error', message: 'broken.sb3: bad zip' }]);
  });
});
