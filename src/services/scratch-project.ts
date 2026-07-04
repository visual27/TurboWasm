import type { ProjectFetchResult, ProjectMetadata } from '@/types/project';
import { ProjectLoadError } from '@/types/project';
import { extractProjectId } from '@/utils/project-id';

const TRAMPOLINE_METADATA_URL = (id: string): string =>
  `https://trampoline.turbowarp.org/api/projects/${id}`;

const SCRATCH_METADATA_URL = (id: string): string => `https://api.scratch.mit.edu/projects/${id}`;
const SCRATCH_PROJECT_URL = (id: string, token: string): string =>
  `https://projects.scratch.mit.edu/${id}?token=${token}`;

interface TrampolineMetadata {
  id: number;
  title: string;
  description?: string;
  instructions?: string;
  notes?: string;
  author?: { username: string };
  image?: string;
  project_token?: string;
}

interface ScratchMetadata {
  id: number;
  title: string;
  description?: string;
  instructions?: string;
  notes?: string;
  author?: { username: string };
  history?: { id: string };
}

export function asProjectMetadata(raw: {
  id: number | string;
  title: string;
  description?: string;
  instructions?: string;
  notes?: string;
  notesAndCredits?: string;
  author?: { username: string };
  image?: string;
}): ProjectMetadata {
  // Scratch API field semantics (verified against the official Scratch API
  // docs: https://en.scratch-wiki.info/wiki/Scratch_API#GET_.2Fprojects.2F.3Cproject_id.3E
  // and the PUT example request body, where the "description" key holds the
  // "Notes and Credits" content):
  //   - `description` is the project's "Notes and Credits" text.
  //   - `instructions` is the project's "Instructions" text.
  //   - The Scratch API does NOT expose a separate short "description" field.
  //   - `notes` is included by some proxies (e.g. Trampoline) as an alias of
  //     `description`. Prefer `notes` if present, fall back to `description`.
  return {
    id: String(raw.id),
    title: raw.title || 'Untitled',
    ...(raw.instructions ? { instructions: raw.instructions } : {}),
    // notesAndCredits precedence (later spreads win):
    //   notesAndCredits > notes > description.
    // The base value is `description` (which IS the Notes & Credits text
    // per the Scratch REST API). If a richer `notes` field is present
    // (some proxies like Trampoline add it as an alias), it overrides.
    // An explicit `notesAndCredits` field, if provided, wins over both.
    ...(raw.description ? { notesAndCredits: raw.description } : {}),
    ...(raw.notes ? { notesAndCredits: raw.notes } : {}),
    ...(raw.notesAndCredits ? { notesAndCredits: raw.notesAndCredits } : {}),
    ...(raw.author?.username ? { author: { username: raw.author.username } } : {}),
    ...(raw.image ? { thumbnailUrl: raw.image } : {}),
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryTrampoline(id: string): Promise<ProjectFetchResult | null> {
  try {
    const metaRes = await fetchWithTimeout(TRAMPOLINE_METADATA_URL(id), {
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as TrampolineMetadata;
    const token = meta.project_token;
    if (!token) return null;
    const projRes = await fetchWithTimeout(SCRATCH_PROJECT_URL(id, token), {
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/octet-stream,*/*' },
    });
    if (!projRes.ok) return null;
    const data = await projRes.arrayBuffer();
    return {
      metadata: asProjectMetadata({
        id: meta.id,
        title: meta.title,
        description: meta.description,
        instructions: meta.instructions,
        notes: meta.notes,
        author: meta.author,
        image: meta.image,
      }),
      data,
    };
  } catch {
    return null;
  }
}

async function tryScratch(id: string): Promise<ProjectFetchResult> {
  const metaRes = await fetchWithTimeout(SCRATCH_METADATA_URL(id), {
    credentials: 'omit',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (metaRes.status === 404) {
    throw new ProjectLoadError(
      'unshared',
      `Project ${id} is unshared, private, or does not exist on Scratch.`,
    );
  }
  if (!metaRes.ok) {
    throw new ProjectLoadError(
      'network',
      `Failed to fetch project metadata: HTTP ${metaRes.status}`,
    );
  }
  const meta = (await metaRes.json()) as ScratchMetadata;
  const token = (meta.history?.id as string | undefined) ?? '';
  const dataRes = await fetchWithTimeout(SCRATCH_PROJECT_URL(id, token), {
    credentials: 'omit',
    cache: 'no-store',
    headers: { Accept: 'application/octet-stream,*/*' },
  });
  if (!dataRes.ok) {
    if (dataRes.status === 404) {
      throw new ProjectLoadError(
        'unshared',
        `Project data not available (HTTP 404). It may be unshared or age-restricted.`,
      );
    }
    throw new ProjectLoadError('network', `Failed to fetch project data: HTTP ${dataRes.status}`);
  }
  const data = await dataRes.arrayBuffer();
  return {
    metadata: asProjectMetadata({
      id: meta.id,
      title: meta.title,
      description: meta.description,
      instructions: meta.instructions,
      notes: meta.notes,
      author: meta.author,
    }),
    data,
  };
}

export async function fetchProjectFromId(
  id: string,
  options: { metadata?: ProjectMetadata } = {},
): Promise<ProjectFetchResult> {
  const extracted = extractProjectId(id);
  if (!extracted) {
    throw new ProjectLoadError(
      'invalid',
      `Project ID must be a numeric string or Scratch/TurboWarp URL (got: "${id}").`,
    );
  }
  const trampoline = await tryTrampoline(extracted);
  if (trampoline) return trampoline;
  void options;
  try {
    return await tryScratch(extracted);
  } catch (err) {
    if (err instanceof ProjectLoadError) {
      throw err;
    }
    throw new ProjectLoadError(
      'network',
      `Network error while fetching project ${extracted}.`,
      err,
    );
  }
}
