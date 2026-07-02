import { create } from 'zustand';
import type { ProjectLoadState, ProjectMetadata, ProjectSource } from '@/types/project';

export interface ProjectState {
  currentId: string | null;
  metadata: ProjectMetadata | null;
  source: ProjectSource | null;
  loadState: ProjectLoadState;
  setLoading: (source: ProjectSource, id: string | null) => void;
  setReadyFromId: (id: string, metadata: ProjectMetadata) => void;
  setReadyFromFile: () => void;
  setError: () => void;
  reset: () => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentId: null,
  metadata: null,
  source: null,
  loadState: 'idle',
  setLoading: (source, id) => set({ source, currentId: id, loadState: 'loading', metadata: null }),
  setReadyFromId: (id, metadata) =>
    set({ currentId: id, metadata, source: 'id', loadState: 'ready' }),
  setReadyFromFile: () =>
    set({ source: 'file', loadState: 'ready', metadata: null, currentId: null }),
  setError: () => set({ loadState: 'error' }),
  reset: () =>
    set({ currentId: null, metadata: null, source: null, loadState: 'idle' }),
}));