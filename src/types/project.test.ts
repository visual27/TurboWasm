import { describe, expect, it } from 'vitest';
import { ProjectLoadError } from '@/types/project';

describe('ProjectLoadError', () => {
  it('carries kind, message, and cause', () => {
    const cause = new Error('inner');
    const err = new ProjectLoadError('network', 'outer', cause);
    expect(err.name).toBe('ProjectLoadError');
    expect(err.kind).toBe('network');
    expect(err.message).toBe('outer');
    expect(err.cause).toBe(cause);
    expect(err instanceof Error).toBe(true);
  });
});