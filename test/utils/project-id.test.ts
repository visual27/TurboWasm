import { describe, expect, it } from 'vitest';
import { extractProjectId } from '@/utils/project-id';

describe('extractProjectId', () => {
  it('returns the bare numeric ID when given only digits', () => {
    expect(extractProjectId('1197296165')).toBe('1197296165');
    expect(extractProjectId('1334154904')).toBe('1334154904');
  });

  it('extracts the ID from a Scratch project URL', () => {
    expect(extractProjectId('https://scratch.mit.edu/projects/1334154904')).toBe('1334154904');
    expect(extractProjectId('https://scratch.mit.edu/projects/1334154904/')).toBe('1334154904');
    expect(extractProjectId('https://scratch.mit.edu/projects/1334154904/#player')).toBe(
      '1334154904',
    );
  });

  it('extracts the ID from a TurboWarp editor URL with query params', () => {
    expect(
      extractProjectId(
        'https://turbowarp.org/1197296165/editor?fps=48&limitless&hqpen&size=480x270',
      ),
    ).toBe('1197296165');
  });

  it('extracts the ID from a TurboWarp fullscreen URL', () => {
    expect(extractProjectId('https://turbowarp.org/1197296165/fullscreen')).toBe('1197296165');
    expect(extractProjectId('https://turbowarp.org/1197296165/?fps=60')).toBe('1197296165');
  });

  it('extracts the ID from a TurboWarp hash URL', () => {
    expect(extractProjectId('https://turbowarp.org/#1197296165')).toBe('1197296165');
  });

  it('extracts the ID from a TurboWarp embed URL', () => {
    expect(extractProjectId('https://turbowarp.org/embed.html?id=1197296165')).toBe('1197296165');
  });

  it('trims surrounding whitespace', () => {
    expect(extractProjectId('   1197296165   ')).toBe('1197296165');
    expect(extractProjectId('\n\thttps://scratch.mit.edu/projects/1334154904\n')).toBe(
      '1334154904',
    );
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(extractProjectId('')).toBeNull();
    expect(extractProjectId('   ')).toBeNull();
  });

  it('returns null when no digits are present', () => {
    expect(extractProjectId('hello world')).toBeNull();
    expect(extractProjectId('https://example.com/projects/abc')).toBeNull();
  });

  it('returns null for inputs with only 1–3 digit numbers', () => {
    expect(extractProjectId('123')).toBeNull();
    expect(extractProjectId('abc 42 def')).toBeNull();
  });

  it('extracts the first ID when multiple are present', () => {
    expect(extractProjectId('old=1 new=1334154904')).toBe('1334154904');
  });
});
