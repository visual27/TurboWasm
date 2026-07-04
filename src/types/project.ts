export type ProjectSource = 'file' | 'id';

export type ProjectLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface ProjectMetadata {
  id: string;
  title: string;
  description?: string;
  instructions?: string;
  notesAndCredits?: string;
  author?: { username: string };
  thumbnailUrl?: string;
}

export interface ProjectFetchResult {
  metadata: ProjectMetadata | null;
  data: ArrayBuffer;
}

export type ProjectLoadErrorKind =
  | 'not_found'
  | 'unshared'
  | 'age_restricted'
  | 'network'
  | 'invalid'
  | 'unknown';

export class ProjectLoadError extends Error {
  public readonly kind: ProjectLoadErrorKind;
  public readonly cause?: unknown;

  public constructor(kind: ProjectLoadErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'ProjectLoadError';
    this.kind = kind;
    this.cause = cause;
  }
}
