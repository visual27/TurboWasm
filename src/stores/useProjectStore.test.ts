import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '@/stores/useProjectStore';
import type { ProjectMetadata } from '@/types/project';

const META: ProjectMetadata = {
  id: '60917032',
  title: 'Test',
  description: 'desc',
  instructions: 'instr',
};

describe('useProjectStore', () => {
  beforeEach(() => {
    useProjectStore.setState({
      currentId: null,
      metadata: null,
      source: null,
      loadState: 'idle',
    });
  });

  it('transitions idle → loading → ready', () => {
    useProjectStore.getState().setLoading('id', '123');
    expect(useProjectStore.getState().loadState).toBe('loading');
    useProjectStore.getState().setReadyFromId('123', META);
    const s = useProjectStore.getState();
    expect(s.loadState).toBe('ready');
    expect(s.source).toBe('id');
    expect(s.metadata?.title).toBe('Test');
  });

  it('clears metadata when loading from file', () => {
    useProjectStore.getState().setReadyFromId('1', META);
    useProjectStore.getState().setReadyFromFile();
    const s = useProjectStore.getState();
    expect(s.metadata).toBeNull();
    expect(s.source).toBe('file');
  });

  it('reset returns to idle', () => {
    useProjectStore.getState().setReadyFromId('1', META);
    useProjectStore.getState().reset();
    expect(useProjectStore.getState().loadState).toBe('idle');
  });
});