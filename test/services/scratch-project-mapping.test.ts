import { describe, expect, it } from 'vitest';
import { asProjectMetadata } from '@/services/scratch-project';

describe('asProjectMetadata', () => {
  it('maps the Scratch API description field (which is Notes & Credits) to notesAndCredits', () => {
    // This is the critical mapping: per the official Scratch REST API,
    // the `description` field holds the project's "Notes and Credits"
    // content (see
    // https://en.scratch-wiki.info/wiki/Scratch_API#PUT_.2Fprojects.2F.3Cproject_id.3E
    // where the PUT example request body sets
    // `"description": "New Notes and Credits"`).
    const result = asProjectMetadata({
      id: 123,
      title: 'Title',
      description: 'Thanks for playing!',
      instructions: 'Click the flag.',
    });
    expect(result.notesAndCredits).toBe('Thanks for playing!');
    expect(result.instructions).toBe('Click the flag.');
    // description (a separate short description) is NOT a Scratch API
    // field — it should not be populated.
    expect(result.description).toBeUndefined();
  });

  it('prefers a separate `notes` field over `description` when both are present', () => {
    // Some proxies (e.g. Trampoline) expose the same content as `notes`
    // (an alias of `description`). Prefer `notes` if both exist.
    const result = asProjectMetadata({
      id: 123,
      title: 'Title',
      description: 'old description',
      notes: 'newer notes',
    });
    expect(result.notesAndCredits).toBe('newer notes');
  });

  it('falls back to description when notes is missing', () => {
    const result = asProjectMetadata({
      id: 123,
      title: 'Title',
      description: 'fallback notes',
    });
    expect(result.notesAndCredits).toBe('fallback notes');
  });

  it('returns undefined notesAndCredits when neither notes nor description are provided', () => {
    const result = asProjectMetadata({
      id: 123,
      title: 'Title',
    });
    expect(result.notesAndCredits).toBeUndefined();
  });

  it('maps instructions verbatim', () => {
    const result = asProjectMetadata({
      id: 123,
      title: 'Title',
      instructions: 'Use arrow keys to move.',
    });
    expect(result.instructions).toBe('Use arrow keys to move.');
  });

  it('maps author and thumbnail image', () => {
    const result = asProjectMetadata({
      id: 123,
      title: 'Title',
      author: { username: 'someone' },
      image: 'https://example.com/thumb.png',
    });
    expect(result.author).toEqual({ username: 'someone' });
    expect(result.thumbnailUrl).toBe('https://example.com/thumb.png');
  });

  it('falls back to "Untitled" for empty title', () => {
    const result = asProjectMetadata({
      id: 123,
      title: '',
    });
    expect(result.title).toBe('Untitled');
  });

  it('stringifies numeric ids', () => {
    const result = asProjectMetadata({ id: 999999999, title: 'T' });
    expect(result.id).toBe('999999999');
  });
});