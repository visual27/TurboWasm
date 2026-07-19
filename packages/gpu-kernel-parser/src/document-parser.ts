/**
 * Parser for a `.scgpu` document — the entire text a user types in the
 * editor. Splits the file into one or more regions (each introduced by
 * a `@compute` line) and forwards each region body to the existing
 * {@link parseComputeComment} parser.
 *
 * Highlights:
 *
 *   - UTF-8 BOM at the start of the file is stripped (configurable).
 *   - A leading YAML frontmatter (`---\n...\n---\n`) is skipped so the
 *     parser only sees directive lines. The number of lines consumed
 *     by the frontmatter is added to every emitted `Position.line` so
 *     directive / diagnostic ranges map back to the original document
 *     (Phase 2 §15.13).
 *   - Lines are normalised to LF before splitting; CRLF / CR / mixed
 *     line endings all parse correctly.
 *   - Multiple `@compute` regions in a single file are accepted; v1
 *     recommends writing one region per file, but the parser is
 *     permissive.
 *   - Each region's directives carry a `Range` pointing back into the
 *     original text so the editor can map diagnostics to source.
 *
 * Diagnostic coordinates (`line`, `column`) are 0-based to match the
 * existing `comment-parser.ts` contract. Callers that need 1-based
 * coordinates (VSCode, Monaco) must add `1` when emitting.
 */

import type {
  Diagnostic,
  DocumentDirective,
  DocumentFrontmatter,
  DocumentRegion,
  ParseScgpuDocumentOptions,
  ParseScgpuDocumentResult,
  ParsedComment,
  Position,
  Range,
} from './types';
import { parseComputeComment } from './comment-parser';

const DEFAULT_REGION_ID = 'region:document';

const BOM = '\uFEFF';
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Internal: a region under construction. `markerLine` and
 * `bodyStartLine` are both ABSOLUTE coordinates (= original-document
 * line numbers after the frontmatter offset has been applied).
 *
 * - For `@compute`-marked regions: `bodyStartLine = markerLine + 1`
 *   (the canonical "directives follow the marker" layout).
 * - For implicit regions (bare directive without marker):
 *   `bodyStartLine = markerLine` so the directive sits on its own line.
 *
 * §Phase 2 (15.13): the body-line-offset on the parser-internal
 * `current.lines[]` array stays 0-based (relative to the body); the
 * absolute-line math is done at region-creation and `finaliseRegion`
 * time only.
 */
interface PendingRegion {
  region: DocumentRegion;
  lines: string[];
  markerLine: number;
  bodyStartLine: number;
}

export function parseScgpuDocument(
  text: string,
  options: ParseScgpuDocumentOptions = {},
): ParseScgpuDocumentResult {
  const stripBom = options.stripBom ?? true;
  const skipFrontmatter = options.skipFrontmatter ?? true;
  const regionIdBase = options.regionId ?? DEFAULT_REGION_ID;

  let working = text;
  if (stripBom && working.startsWith(BOM)) {
    working = working.slice(BOM.length);
  }

  let frontmatter: DocumentFrontmatter = { range: null };
  // §Phase 2 (15.13): capture the line offset consumed by the
  // frontmatter so every emitted Range / diagnostic line maps back to
  // the original document. `extractFrontmatter` returns
  // `bodyOffsetLines` (= number of original-text lines used by the
  // `--- ... ---` block including the trailing newline).
  let bodyOffsetLines = 0;
  if (skipFrontmatter && working.trimStart().startsWith('---')) {
    const fm = extractFrontmatter(working);
    if (fm) {
      frontmatter = { range: fm.range };
      bodyOffsetLines = fm.bodyOffsetLines;
      working = fm.body;
    }
  }

  const lines = working.split(LINE_BREAK);

  const regions: DocumentRegion[] = [];
  const diagnostics: Diagnostic[] = [];

  let current: PendingRegion | null = null;
  let anonymousRegionCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const withoutPrefix = trimmed.replace(/^\/\/\s*/, '');
    if (withoutPrefix.length === 0) continue;

    if (withoutPrefix.startsWith('@compute')) {
      if (current) {
        regions.push(finaliseRegion(current));
      }
      anonymousRegionCounter = current ? anonymousRegionCounter + 1 : 0;
      const id =
        anonymousRegionCounter === 0
          ? regionIdBase
          : `${regionIdBase}:${anonymousRegionCounter}`;
      const absoluteMarkerLine = bodyOffsetLines + i;
      current = {
        region: {
          regionId: id,
          range: {
            start: { line: absoluteMarkerLine, character: 0 },
            end: { line: absoluteMarkerLine, character: line.length },
          },
          markerLine: absoluteMarkerLine,
          directives: [],
          diagnostics: [],
        },
        lines: [],
        markerLine: absoluteMarkerLine,
        // §Phase 2 (15.13): marker regions start their body one line
        // below the @compute marker.
        bodyStartLine: absoluteMarkerLine + 1,
      };
      continue;
    }

    if (!current) {
      if (!withoutPrefix.startsWith('@')) {
        diagnostics.push({
          severity: 'warn',
          code: 'gpu.dsl_syntax_error',
          message: `expected a directive starting with '@', got '${truncate(withoutPrefix, 24)}'`,
          line: bodyOffsetLines + i,
          column: 0,
        });
        continue;
      }
      // Bare directive without a preceding `@compute` marker. Wrap it in
      // an implicit region so the parser still surfaces its directives
      // and diagnostics. This matches the historical Scratch comment
      // behaviour where a region is implicit once a directive appears.
      anonymousRegionCounter = anonymousRegionCounter + 1;
      const id = anonymousRegionCounter === 1 ? regionIdBase : `${regionIdBase}:${anonymousRegionCounter}`;
      const absoluteMarkerLine = bodyOffsetLines + i;
      current = {
        region: {
          regionId: id,
          range: {
            start: { line: absoluteMarkerLine, character: 0 },
            end: { line: absoluteMarkerLine, character: line.length },
          },
          markerLine: absoluteMarkerLine,
          directives: [],
          diagnostics: [],
        },
        lines: [],
        markerLine: absoluteMarkerLine,
        // §Phase 2 (15.13): implicit regions start their body on the
        // same line as the bare directive (pre-15.13 the body started
        // one line below, which shifted the directive's `Range.start`
        // by one).
        bodyStartLine: absoluteMarkerLine,
      };
    }

    current.lines.push(line);
  }

  if (current) {
    regions.push(finaliseRegion(current));
  }

  return { regions, diagnostics, frontmatter };
}

function finaliseRegion(region: PendingRegion): DocumentRegion {
  const blockId = `${region.region.regionId}:comment`;
  const comment: ParsedComment = {
    blockId,
    text: region.lines.join('\n'),
  };
  const { directives, diagnostics: innerDiag } = parseComputeComment(comment, region.region.regionId);

  // §Phase 2 (15.13): `bodyStartLine` is already absolute (=
  // original-document line). `d.line` is body-relative, so the sum is
  // absolute. This was previously `markerLine + 1 + d.line` which
  // silently dropped the frontmatter offset and shifted implicit
  // regions by one line.
  const directivesWithRange: DocumentDirective[] = directives.map((d) => ({
    directive: d,
    raw: region.lines[d.line] ?? '',
    range: directiveRange(region.lines, region.bodyStartLine, d.line, d.column),
  }));

  const diagnosticsWithRange: Diagnostic[] = innerDiag.map((d) => ({
    ...d,
    line: region.bodyStartLine + (d.line ?? 0),
    column: d.column ?? 0,
  }));

  const lastLineIdx = region.lines.length > 0 ? region.lines.length - 1 : 0;
  const endLine = region.bodyStartLine + lastLineIdx;
  const endCharacter = (region.lines[lastLineIdx] ?? '').length;

  return {
    ...region.region,
    directives: directivesWithRange,
    diagnostics: diagnosticsWithRange,
    range: {
      start: { line: region.markerLine, character: 0 },
      end: { line: endLine, character: endCharacter },
    },
  };
}

function extractFrontmatter(
  text: string,
): { range: Range; body: string; bodyOffsetLines: number } | null {
  if (!text.startsWith('---')) return null;
  // Strip the opening `---` (3 chars). The line break right after it is
  // required (frontmatter is a YAML document).
  const rest = text.slice(3);
  if (!rest.startsWith('\n') && !rest.startsWith('\r')) return null;
  const normalised = rest.replace(/^\r\n/, '\n');
  // Find the closing `\n---` (= the line break that ends the YAML
  // document, followed by the closing marker). `close` is the index of
  // that `\n` in `normalised`.
  const close = normalised.indexOf('\n---');
  if (close === -1) return null;
  // Closing `---` starts at `close + 1` in normalised and is 3 chars.
  // The body begins right after it. Convert back to text-relative by
  // adding the normalised offset (= opening `---` (3 chars) + its
  // trailing `\n` (1 char) = 4).
  const bodyStartInText = close + 1 + 3 + 4;
  // Skip an optional `\n` / `\r\n` separator between the closing `---`
  // and the body so the body's first line starts at its own position.
  const ch0 = text[bodyStartInText];
  const ch1 = text[bodyStartInText + 1];
  let endOffset = bodyStartInText;
  if (ch0 === '\n') endOffset = bodyStartInText + 1;
  else if (ch0 === '\r' && ch1 === '\n') endOffset = bodyStartInText + 2;
  else if (ch0 === '\r') endOffset = bodyStartInText + 1;
  const consumed = text.slice(0, endOffset);
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: countLines(consumed), character: 0 },
    },
    body: text.slice(endOffset),
    // §Phase 2 (15.13): number of original-document lines consumed by
    // the frontmatter (= the body-relative line 0 corresponds to the
    // absolute line `bodyOffsetLines` in the user's document).
    bodyOffsetLines: countLines(consumed),
  };
}

function directiveRange(
  lines: string[],
  startLine: number,
  relativeLine: number,
  relativeColumn: number,
): Range {
  const raw = lines[relativeLine] ?? '';
  // §Phase 2 (15.13): `startLine` is already absolute (=
  // original-document line number). `relativeLine` is body-relative;
  // the sum is absolute. Previously this was `startLine + relativeLine`
  // where `startLine = markerLine + 1`, which silently dropped the
  // frontmatter offset and shifted implicit regions by one line.
  const absoluteLine = startLine + relativeLine;
  const endColumn = raw.length === 0 ? 0 : raw.length;
  return {
    start: { line: absoluteLine, character: relativeColumn },
    end: { line: absoluteLine, character: endColumn },
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function positionOf(lineOffsets: readonly number[], offset: number): Position {
  // Binary search for the line that contains the given offset.
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const midStart = lineOffsets[mid] ?? 0;
    if (midStart <= offset) lo = mid;
    else hi = mid - 1;
  }
  const start = lineOffsets[lo] ?? 0;
  return { line: lo, character: offset - start };
}

function countLines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') count++;
    else if (ch === '\r') {
      count++;
      if (text[i + 1] === '\n') i++;
    }
  }
  return count;
}
