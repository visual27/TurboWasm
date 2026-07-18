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
 *     parser only sees directive lines.
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
  if (skipFrontmatter && working.trimStart().startsWith('---')) {
    const fm = extractFrontmatter(working);
    if (fm) {
      frontmatter = { range: fm.range };
      working = fm.body;
    }
  }

  const lines = working.split(LINE_BREAK);

  const regions: DocumentRegion[] = [];
  const diagnostics: Diagnostic[] = [];

  let current: { region: DocumentRegion; lines: string[]; markerLine: number } | null = null;
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
      current = {
        region: {
          regionId: id,
          range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
          markerLine: i,
          directives: [],
          diagnostics: [],
        },
        lines: [],
        markerLine: i,
      };
      continue;
    }

    if (!current) {
      if (!withoutPrefix.startsWith('@')) {
        diagnostics.push({
          severity: 'warn',
          code: 'gpu.dsl_syntax_error',
          message: `expected a directive starting with '@', got '${truncate(withoutPrefix, 24)}'`,
          line: i,
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
      current = {
        region: {
          regionId: id,
          range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
          markerLine: i,
          directives: [],
          diagnostics: [],
        },
        lines: [],
        markerLine: i,
      };
    }

    current.lines.push(line);
  }

  if (current) {
    regions.push(finaliseRegion(current));
  }

  return { regions, diagnostics, frontmatter };

  function finaliseRegion(
    region: { region: DocumentRegion; lines: string[]; markerLine: number },
  ): DocumentRegion {
    const markerLine = region.markerLine;
    const bodyStartLine = markerLine + 1;
    const blockId = `${region.region.regionId}:comment`;
    const comment: ParsedComment = {
      blockId,
      text: region.lines.join('\n'),
    };
    const { directives, diagnostics: innerDiag } = parseComputeComment(comment, region.region.regionId);

    const directivesWithRange: DocumentDirective[] = directives.map((d) => ({
      directive: d,
      raw: region.lines[d.line] ?? '',
      range: directiveRange(region.lines, bodyStartLine, d.line, d.column),
    }));

    const diagnosticsWithRange: Diagnostic[] = innerDiag.map((d) => ({
      ...d,
      line: bodyStartLine + (d.line ?? 0),
      column: d.column ?? 0,
    }));

    const lastLineIdx = region.lines.length > 0 ? region.lines.length - 1 : 0;
    const endLine = bodyStartLine + lastLineIdx;
    const endCharacter = (region.lines[lastLineIdx] ?? '').length;

    return {
      ...region.region,
      directives: directivesWithRange,
      diagnostics: diagnosticsWithRange,
      range: {
        start: { line: markerLine, character: 0 },
        end: { line: endLine, character: endCharacter },
      },
    };
  }
}

function extractFrontmatter(
  text: string,
): { range: Range; body: string } | null {
  if (!text.startsWith('---')) return null;
  const rest = text.slice(3);
  if (!rest.startsWith('\n') && !rest.startsWith('\r')) return null;
  const normalised = rest.replace(/^\r\n/, '\n');
  const close = normalised.indexOf('\n---');
  if (close === -1) return null;
  const afterMarker = close + 4;
  const trailer = normalised.slice(afterMarker);
  const bodyStart = 3 + 1 + close + 4;
  const endOffset = bodyStart + (trailer.startsWith('\n') || trailer.startsWith('\r') ? 1 : 0);
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: countLines(text.slice(0, endOffset)), character: 0 },
    },
    body: text.slice(endOffset),
  };
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

function directiveRange(
  lines: string[],
  startLine: number,
  relativeLine: number,
  relativeColumn: number,
): Range {
  const raw = lines[relativeLine] ?? '';
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
