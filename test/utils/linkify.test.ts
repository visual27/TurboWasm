import { describe, expect, it } from 'vitest';
import {
  linkifyMetadataText,
  scratchProfileUrl,
  type LinkifySegment,
} from '@/utils/linkify';

const text = (t: string): LinkifySegment => ({ type: 'text', text: t });
const url = (t: string): LinkifySegment => ({
  type: 'url',
  text: t,
  href: t,
});
const mention = (username: string): LinkifySegment => ({
  type: 'mention',
  text: `@${username}`,
  username,
});

describe('linkifyMetadataText', () => {
  describe('empty / plain input', () => {
    it('returns an empty array for the empty string', () => {
      expect(linkifyMetadataText('')).toEqual([]);
    });

    it('returns a single text segment for input with no URLs or mentions', () => {
      const out = linkifyMetadataText('Just some plain prose.');
      expect(out).toEqual([text('Just some plain prose.')]);
    });

    it('does not recognise email-like sequences as mentions', () => {
      const out = linkifyMetadataText('Contact foo@example.com for help.');
      // The email-like text passes through untouched — no mention spans
      // are produced because the rule requires the @ to follow
      // whitespace / punctuation / start-of-input, not a word char.
      expect(out).toEqual([text('Contact foo@example.com for help.')]);
    });
  });

  describe('URLs', () => {
    it('recognises a single https URL', () => {
      const out = linkifyMetadataText('see https://example.com for info');
      expect(out).toEqual([
        text('see '),
        url('https://example.com'),
        text(' for info'),
      ]);
    });

    it('recognises http (non-tls) URLs', () => {
      const out = linkifyMetadataText('http://example.com/page');
      expect(out).toEqual([url('http://example.com/page')]);
    });

    it('recognises https URLs that start at the beginning of input', () => {
      const out = linkifyMetadataText('https://example.com is great');
      expect(out).toEqual([url('https://example.com'), text(' is great')]);
    });

    it('strips sentence-ending punctuation from the URL', () => {
      const out = linkifyMetadataText('See https://example.com.');
      expect(out).toEqual([
        text('See '),
        url('https://example.com'),
        text('.'),
      ]);
    });

    it('strips multiple trailing punctuation marks', () => {
      const out = linkifyMetadataText('See https://example.com?!');
      expect(out).toEqual([
        text('See '),
        url('https://example.com'),
        text('?!'),
      ]);
    });

    it('preserves query strings and fragments', () => {
      const out = linkifyMetadataText('see https://example.com/p?q=v#x');
      expect(out).toEqual([
        text('see '),
        url('https://example.com/p?q=v#x'),
      ]);
    });

    it('recognises multiple URLs in the same string', () => {
      const out = linkifyMetadataText('see https://a.com and https://b.com');
      expect(out).toEqual([
        text('see '),
        url('https://a.com'),
        text(' and '),
        url('https://b.com'),
      ]);
    });

    it('does not recognise a URL that lacks the http:// scheme', () => {
      // example.com without scheme should pass through as text — the
      // recogniser requires the literal prefix.
      const out = linkifyMetadataText('see example.com for info');
      expect(out).toEqual([text('see example.com for info')]);
    });
  });

  describe('mentions', () => {
    it('recognises a mention at the start of input', () => {
      const out = linkifyMetadataText('@grape is cool');
      expect(out).toEqual([mention('grape'), text(' is cool')]);
    });

    it('recognises a mention after whitespace', () => {
      const out = linkifyMetadataText('thanks @grape for the help');
      expect(out).toEqual([
        text('thanks '),
        mention('grape'),
        text(' for the help'),
      ]);
    });

    it('recognises a mention after sentence punctuation', () => {
      const out = linkifyMetadataText('thanks,@grape!');
      expect(out).toEqual([
        text('thanks,'),
        mention('grape'),
        text('!'),
      ]);
    });

    it('recognises a mention after an opening parenthesis', () => {
      const out = linkifyMetadataText('CC (@grape)');
      expect(out).toEqual([
        text('CC ('),
        mention('grape'),
        text(')'),
      ]);
    });

    it('ignores a mention inside a URL', () => {
      // The `@v1` inside this URL must NOT be treated as a Scratch
      // mention.
      const out = linkifyMetadataText('see https://api.example.com/@v1/');
      expect(out).toEqual([
        text('see '),
        url('https://api.example.com/@v1/'),
      ]);
    });

    it('truncates long usernames to the 30-character maximum', () => {
      // The recogniser only consumes `[A-Za-z][A-Za-z0-9_-]{0,29}` —
      // any extra characters fall back to surrounding text.
      const out = linkifyMetadataText(
        `@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa extra`,
      );
      // 30 'a's followed by " extra".
      expect(out).toEqual([
        mention('a'.repeat(30)),
        text(' extra'),
      ]);
    });

    it('does not recognise a mention starting with a digit', () => {
      // Scratch usernames start with a letter — a digit-only name is
      // rejected by the syntax class and falls back to text.
      const out = linkifyMetadataText('hi @1grape there');
      expect(out).toEqual([text('hi @1grape there')]);
    });

    it('recognises multiple mentions in the same string', () => {
      const out = linkifyMetadataText('cc @grape and @apple');
      expect(out).toEqual([
        text('cc '),
        mention('grape'),
        text(' and '),
        mention('apple'),
      ]);
    });

    it('recognises mentions interleaved with URLs', () => {
      const out = linkifyMetadataText(
        'see https://a.com and @grape for details',
      );
      expect(out).toEqual([
        text('see '),
        url('https://a.com'),
        text(' and '),
        mention('grape'),
        text(' for details'),
      ]);
    });
  });
});

describe('scratchProfileUrl', () => {
  it('builds the canonical Scratch profile URL for a plain username', () => {
    expect(scratchProfileUrl('grape')).toBe(
      'https://scratch.mit.edu/users/grape/',
    );
  });

  it('URL-encodes special characters in the username', () => {
    expect(scratchProfileUrl('user name')).toBe(
      'https://scratch.mit.edu/users/user%20name/',
    );
  });
});
