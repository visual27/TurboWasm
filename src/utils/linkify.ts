/**
 * Linkify project metadata text — turn raw text returned by the Scratch /
 * Trampoline API into an array of typed segments so the UI can render
 * inline anchors for `https://...` URLs and `@username` references.
 *
 * The functions in this file are intentionally pure and
 * platform-agnostic so they can be unit-tested without a DOM.
 *
 * Two recognisers are supported:
 *
 *   1. `https://` / `http://` URLs.
 *
 *      A URL run starts at any whitespace-or-start boundary, the literal
 *      scheme prefix, and continues to the next whitespace, `<`, `>`, or
 *      `"`. Trailing punctuation that is more likely to be sentence-ending
 *      than part of the URL (`.,;:!?`) is stripped from the captured URL
 *      and emitted as a separate text segment after the link, so
 *      "See https://example.com." renders as anchor `https://example.com`
 *      followed by `.`. Fragments (`#foo`) and queries (`?bar=baz`) are
 *      preserved as part of the URL.
 *
 *   2. `@`-mentions.
 *
 *      A mention is an `@` immediately preceded by either the start of
 *      input, a whitespace character, or an opening bracket/punctuation
 *      (`(`, `,`, `;`, `:`, `!`, `?`), followed by 1–30 username
 *      characters `[A-Za-z][A-Za-z0-9_-]{0,29}`, terminated by a
 *      non-username character or end of input. Email-like sequences
 *      (`foo@example.com`) are intentionally NOT recognised because the
 *      `@` there is preceded by a word character — only `@` after
 *      whitespace or sentence-start is treated as a mention.
 *
 *      Recognised mentions resolve to
 *      `https://scratch.mit.edu/users/<username>/`, matching the URL
 *      pattern used elsewhere by the panel for the project author link.
 *
 * A `@` mention that falls inside an already-recognised URL span is
 * skipped (URLs can legitimately contain `@` characters such as in
 * `https://api.example.com/@v1/`).
 */
export type LinkifySegment =
  | { type: 'text'; text: string }
  | { type: 'url'; text: string; href: string }
  | { type: 'mention'; text: string; username: string };

interface Span {
  start: number;
  end: number;
  segment: LinkifySegment;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"]+/g;
const MENTION_PATTERN =
  /(?:^|(?<=[\s(,;:!?]))@([A-Za-z][A-Za-z0-9_-]{0,29})(?![A-Za-z0-9_-])/g;
const TRAILING_PUNCT_PATTERN = /[.,;:!?]+$/;

export function linkifyMetadataText(text: string): LinkifySegment[] {
  const out: LinkifySegment[] = [];
  if (text.length === 0) return out;

  const spans: Span[] = [];

  // 1. Collect URLs (longest first; mentions are matched only outside URL
  //    spans in step 2).
  const urlRe = new RegExp(URL_PATTERN.source, 'g');
  let urlMatch: RegExpExecArray | null;
  while ((urlRe.lastIndex < text.length) && (urlMatch = urlRe.exec(text)) !== null) {
    const raw = urlMatch[0];
    const punctMatch = TRAILING_PUNCT_PATTERN.exec(raw);
    const url = punctMatch ? raw.slice(0, raw.length - punctMatch[0].length) : raw;
    // Guard against pathological empty captures (defensive — the regex
    // requires at least the scheme + one char).
    if (url.length === 0) continue;
    spans.push({
      start: urlMatch.index,
      end: urlMatch.index + url.length,
      segment: { type: 'url', text: url, href: url },
    });
  }

  const isInsideUrl = (idx: number): boolean => {
    // Linear scan is acceptable here: metadata text is short and we only
    // call this per mention match.
    for (const span of spans) {
      if (span.segment.type !== 'url') continue;
      if (idx >= span.start && idx < span.end) return true;
    }
    return false;
  };

  // 2. Collect `@`-mentions outside of URL spans.
  const mentionRe = new RegExp(MENTION_PATTERN.source, 'g');
  let mentionMatch: RegExpExecArray | null;
  while (
    (mentionRe.lastIndex < text.length) &&
    (mentionMatch = mentionRe.exec(text)) !== null
  ) {
    const username = mentionMatch[1] ?? '';
    const start = mentionMatch.index;
    const fullText = mentionMatch[0];
    if (isInsideUrl(start)) {
      // Avoid pushing the regex past consumed URLs.
      mentionRe.lastIndex = urlSpansEndAfter(spans, mentionRe.lastIndex);
      continue;
    }
    spans.push({
      start,
      end: start + fullText.length,
      segment: { type: 'mention', text: fullText, username },
    });
  }

  // 3. Emit spans in left-to-right order, filling gaps with text.
  spans.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // defensive — overlap would be a bug
    if (span.start > cursor) {
      out.push({ type: 'text', text: text.slice(cursor, span.start) });
    }
    out.push(span.segment);
    cursor = span.end;
  }
  if (cursor < text.length) {
    out.push({ type: 'text', text: text.slice(cursor) });
  }
  return out;
}

// Advance `cursor` to the end of the next URL span that ends at or after
// `cursor`. Used to keep the mention regex from re-scanning content
// consumed by an earlier URL match.
function urlSpansEndAfter(spans: readonly Span[], cursor: number): number {
  let next = cursor;
  for (const span of spans) {
    if (span.segment.type !== 'url') continue;
    if (span.end > next && span.start <= cursor) next = span.end;
  }
  return next;
}

/**
 * Canonical Scratch profile URL for a given username. Mirrors the
 * existing `scratchProfileUrl` helper used by the project metadata
 * panel header so both call-sites stay in sync.
 */
export function scratchProfileUrl(username: string): string {
  return `https://scratch.mit.edu/users/${encodeURIComponent(username)}/`;
}
