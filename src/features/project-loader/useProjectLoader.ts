import { useCallback } from 'react';
import {
  loadProjectFromArrayBuffer,
  loadProjectFromFile,
  loadProjectFromId,
} from '@/runtime/player';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { ProjectLoadError } from '@/types/project';
import { extractProjectId } from '@/utils/project-id';

export interface UseProjectLoaderReturn {
  loadFile: (file: File) => Promise<void>;
  loadById: (id: string) => Promise<void>;
  loadArrayBuffer: (buf: ArrayBuffer, fileName: string) => Promise<void>;
}

export function useProjectLoader(): UseProjectLoaderReturn {
  const push = useErrorLogStore((s) => s.push);
  const setLoading = useProjectStore((s) => s.setLoading);
  const setReadyFromId = useProjectStore((s) => s.setReadyFromId);
  const setReadyFromFile = useProjectStore((s) => s.setReadyFromFile);
  const setError = useProjectStore((s) => s.setError);

  const loadFile = useCallback(
    async (file: File) => {
      setLoading('file', null);
      try {
        await loadProjectFromFile(file);
        setReadyFromFile();
        push('info', `Loaded "${file.name}".`);
      } catch (err) {
        setError();
        const msg = formatLoadError(err, file.name);
        push('error', msg);
      }
    },
    [push, setError, setLoading, setReadyFromFile],
  );

  const loadById = useCallback(
    async (id: string) => {
      const extracted = extractProjectId(id);
      if (!extracted) {
        setError();
        push('error', `${id}: Project ID must be a numeric string or Scratch/TurboWarp URL.`);
        return;
      }
      setLoading('id', extracted);
      try {
        const result = await loadProjectFromId(extracted);
        if (result.metadata) {
          setReadyFromId(extracted, result.metadata);
        } else {
          setReadyFromFile();
        }
        push('info', `Loaded project ${extracted}.`);
      } catch (err) {
        setError();
        const msg = formatLoadError(err, `#${extracted}`);
        push('error', msg);
      }
    },
    [push, setError, setLoading, setReadyFromFile, setReadyFromId],
  );

  const loadArrayBuffer = useCallback(
    async (buf: ArrayBuffer, fileName: string) => {
      setLoading('file', null);
      try {
        await loadProjectFromArrayBuffer(buf);
        setReadyFromFile();
        push('info', `Loaded "${fileName}".`);
      } catch (err) {
        setError();
        const msg = formatLoadError(err, fileName);
        push('error', msg);
      }
    },
    [push, setError, setLoading, setReadyFromFile],
  );

  return { loadFile, loadById, loadArrayBuffer };
}

function formatLoadError(err: unknown, label: string): string {
  if (err instanceof ProjectLoadError) {
    switch (err.kind) {
      case 'not_found':
        return `${label}: Project not found.`;
      case 'unshared':
        return `${label}: Project is unshared, private, or age-restricted.`;
      case 'age_restricted':
        return `${label}: Project is age-restricted and cannot be loaded.`;
      case 'network':
        return `${label}: Network error while fetching.`;
      case 'invalid':
        return `${label}: ${err.message}`;
      default:
        return `${label}: ${err.message}`;
    }
  }
  if (err instanceof Error) {
    return `${label}: ${err.message}`;
  }
  return `${label}: Unknown error.`;
}