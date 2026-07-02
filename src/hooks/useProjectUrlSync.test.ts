import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  readProjectIdFromHash,
  writeProjectIdToHash,
  useProjectUrlSync,
} from '@/hooks/useProjectUrlSync';
import { useProjectStore } from '@/stores/useProjectStore';

describe('URL hash utilities', () => {
  beforeEach(() => {
    // Reset the hash before each test.
    window.history.replaceState(null, '', '/');
  });

  it('readProjectIdFromHash returns null when hash is empty', () => {
    expect(readProjectIdFromHash()).toBeNull();
  });

  it('readProjectIdFromHash extracts a bare numeric ID', () => {
    window.location.hash = '#1197296165';
    expect(readProjectIdFromHash()).toBe('1197296165');
  });

  it('readProjectIdFromHash extracts an ID from a sub-path', () => {
    window.location.hash = '#/1197296165/editor';
    expect(readProjectIdFromHash()).toBe('1197296165');
  });

  it('readProjectIdFromHash extracts an ID from a query-style hash', () => {
    window.location.hash = '#?id=1197296165';
    expect(readProjectIdFromHash()).toBe('1197296165');
  });

  it('writeProjectIdToHash sets the hash to a bare ID', () => {
    writeProjectIdToHash('1234567890');
    expect(window.location.hash).toBe('#1234567890');
  });

  it('writeProjectIdToHash replaces the existing ID in a sub-path', () => {
    window.location.hash = '#/1197296165/editor';
    writeProjectIdToHash('2222222222');
    expect(window.location.hash).toBe('#/2222222222/editor');
  });

  it('writeProjectIdToHash(null) clears the hash', () => {
    window.location.hash = '#1197296165';
    writeProjectIdToHash(null);
    expect(window.location.hash).toBe('');
  });
});

describe('useProjectUrlSync', () => {
  let loadByIdMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    useProjectStore.setState({
      currentId: null,
      metadata: null,
      source: null,
      loadState: 'idle',
    });
    loadByIdMock = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the project from the hash on mount', () => {
    window.location.hash = '#1197296165';
    renderHook(() => useProjectUrlSync({ loadById: loadByIdMock }));
    expect(loadByIdMock).toHaveBeenCalledWith('1197296165');
  });

  it('does not call loadById when the hash is empty on mount', () => {
    renderHook(() => useProjectUrlSync({ loadById: loadByIdMock }));
    expect(loadByIdMock).not.toHaveBeenCalled();
  });

  it('updates the hash when currentId changes', () => {
    const { result } = renderHook(() =>
      useProjectUrlSync({ loadById: loadByIdMock }),
    );
    void result; // unused, just to invoke the hook
    act(() => {
      useProjectStore.getState().setReadyFromId('1234567890', {
        id: '1234567890',
        title: 'demo',
      });
    });
    expect(window.location.hash).toBe('#1234567890');
  });

  it('clears the hash when currentId is reset to null', () => {
    window.location.hash = '#1234567890';
    const { result } = renderHook(() =>
      useProjectUrlSync({ loadById: loadByIdMock }),
    );
    void result;
    act(() => {
      useProjectStore.getState().setReadyFromId('1234567890', {
        id: '1234567890',
        title: 'demo',
      });
    });
    act(() => {
      useProjectStore.getState().setReadyFromFile();
    });
    expect(window.location.hash).toBe('');
  });

  it('reacts to manual hash changes by reloading the project', () => {
    renderHook(() => useProjectUrlSync({ loadById: loadByIdMock }));
    expect(loadByIdMock).not.toHaveBeenCalled();

    act(() => {
      window.location.hash = '#2222222222';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(loadByIdMock).toHaveBeenCalledWith('2222222222');
  });
});