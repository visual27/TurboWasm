import { useEffect, useRef } from 'react';
import { useProjectStore } from '@/stores/useProjectStore';
import { extractProjectId } from '@/utils/project-id';

/**
 * Read the project ID currently encoded in the URL hash.
 *
 * Accepts:
 *  - `#1197296165`
 *  - `#1197296165/editor?fps=48`
 *  - `#projects/1197296165`
 *  - any other fragment whose first run of 4+ digits is a numeric ID
 *
 * Returns `null` when no ID is present.
 */
export function readProjectIdFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  return extractProjectId(raw);
}

/**
 * Write the given project ID to the URL hash, preserving any other
 * hash-fragment content (e.g. an editor sub-path). When `id` is null the
 * hash is cleared instead.
 *
 * Uses `replaceState` so the user can hit Back to leave the page without
 * going through every ID change.
 */
export function writeProjectIdToHash(id: string | null): void {
  if (typeof window === 'undefined') return;
  const current = window.location.hash.replace(/^#/, '');
  let next = '';
  if (id) {
    const existing = current.replace(/^\/+/, '');
    if (existing) {
      // Replace the first numeric ID in the existing fragment, then keep
      // the rest of the sub-path / query intact.
      const replaced = existing.replace(/\d{4,20}/, id);
      next = `#${replaced.startsWith('/') ? replaced : `/${replaced}`}`;
    } else {
      next = `#${id}`;
    }
  }
  const newHash = next;
  const newUrl = `${window.location.pathname}${window.location.search}${newHash}`;
  // Only update if the URL actually changes — avoids spamming history
  // entries while a user is typing into the project-id input.
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === newUrl) {
    return;
  }
  try {
    window.history.replaceState(null, '', newUrl);
  } catch {
    /* ignore (e.g. file:// in tests) */
  }
}

/**
 * Synchronize the current project ID with the URL hash.
 *
 * Behavior:
 *  - On mount, if the hash contains a project ID, the project is loaded
 *    via the supplied callback.
 *  - When the project's `currentId` in the store changes, the hash is
 *    updated to match.
 *  - When the user manually changes the hash (Back/Forward, address-bar
 *    edit), the project is reloaded for the new ID.
 *
 * The hook does not own the loader; callers pass `loadById` and the
 * project store to keep the dependency direction clean.
 */
export interface UseProjectUrlSyncArgs {
  loadById: (id: string) => Promise<unknown>;
}

export function useProjectUrlSync({ loadById }: UseProjectUrlSyncArgs): void {
  const currentId = useProjectStore((s) => s.currentId);
  const lastWrittenRef = useRef<string | null>(null);
  const initialSyncDoneRef = useRef<boolean>(false);

  // (1) On mount: if the hash has a project ID, load it.
  useEffect(() => {
    if (initialSyncDoneRef.current) return;
    initialSyncDoneRef.current = true;
    const id = readProjectIdFromHash();
    if (id) {
      lastWrittenRef.current = id;
      void loadById(id);
    }
    // We intentionally only want this to run on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (2) When the user changes the hash (Back / Forward / address bar),
  // load the new ID — but only if the change did not come from us.
  useEffect(() => {
    const onHashChange = (): void => {
      const id = readProjectIdFromHash();
      if (!id) return;
      if (id === lastWrittenRef.current) return;
      if (id === useProjectStore.getState().currentId) {
        // Already showing this project — just remember the hash so we
        // don't trigger a redundant load.
        lastWrittenRef.current = id;
        return;
      }
      lastWrittenRef.current = id;
      void loadById(id);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [loadById]);

  // (3) When the project store's currentId changes, reflect it in the URL.
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;
    if (currentId === lastWrittenRef.current) return;
    lastWrittenRef.current = currentId;
    writeProjectIdToHash(currentId);
  }, [currentId]);
}