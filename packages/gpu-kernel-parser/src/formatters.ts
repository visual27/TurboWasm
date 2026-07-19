/**
 * Formatters for the `@turbowasm/gpu-kernel-parser` package.
 *
 * Two formatters are exported:
 *
 *   - {@link formatScratchComment} — turns a `.scgpu` body into the
 *     Scratch comment syntax: prefix every line with `// ` (or another
 *     prefix), normalise line endings to LF, and trim trailing whitespace.
 *
 *   - {@link formatScgpuDocument} — sorts directives inside a `.scgpu`
 *     document, removes redundant blank lines, and emits a canonical
 *     layout. Idempotent: running the output through it again must
 *     produce the same text.
 *
 * Both formatters accept the original text and return a fresh string.
 * They never mutate the input or touch the parser internals.
 */

import type {
  BindDirective,
  DocumentDirective,
  DocumentRegion,
  MapDirective,
  ParsedDirective,
  Position,
  Range,
  RepeatDirective,
  ScgpuFormatOptions,
  ScratchFormatOptions,
  WorkgroupSizeDirective,
} from './types';
import { parseScgpuDocument } from './document-parser';

export function formatScratchComment(
  text: string,
  options: ScratchFormatOptions = {},
): string {
  const prefix = options.prefix ?? '// ';
  const lineEnding = options.lineEnding ?? '\n';
  const normalised = text.replace(/\r\n|\r/g, '\n');
  let lines = normalised.split('\n');
  // Drop a single trailing empty line created by a final newline so
  // callers can paste without a dangling blank comment line.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  const output: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (prefix.length === 0) {
      output.push(trimmed);
    } else {
      output.push(trimmed.length === 0 ? prefix.trimEnd() : prefix + trimmed);
    }
  }
  return output.join(lineEnding);
}

export function formatScgpuDocument(
  text: string,
  options: ScgpuFormatOptions = {},
): string {
  const lineEnding = options.lineEnding ?? '\n';
  const aligned = options.alignedBinds ?? false;
  const parsed = parseScgpuDocument(text);

  let frontmatterBlock = '';
  if (parsed.frontmatter.range) {
    frontmatterBlock = extractFrontmatterBlock(text, parsed.frontmatter.range);
  }

  const regionBlocks = parsed.regions.map((region) =>
    formatRegion(region, { aligned, lineEnding }),
  );

  const blocks: string[] = [];
  if (frontmatterBlock.length > 0) blocks.push(frontmatterBlock);
  for (const block of regionBlocks) blocks.push(block);
  return blocks.join(lineEnding + lineEnding) + lineEnding;
}

interface RegionFormatOptions {
  aligned: boolean;
  lineEnding: '\n' | '\r\n';
}

function formatRegion(region: DocumentRegion, options: RegionFormatOptions): string {
  const groups = groupDirectives(region.directives);
  const out: string[] = [];

  out.push('@compute');

  const binds = sortBinds(groups.binds);
  if (binds.length > 0) {
    if (options.aligned) {
      out.push(...alignBinds(binds));
    } else {
      for (const d of binds) out.push(d.raw.trim());
    }
  }

  for (const d of groups.workgroup) out.push(d.raw.trim());

  const repeats = sortRepeats(groups.repeats);
  for (const d of repeats) out.push(d.raw.trim());

  for (const d of groups.maps) out.push(d.raw.trim());

  return out.join(options.lineEnding);
}

interface GroupedDirectives {
  binds: DocumentDirective[];
  workgroup: DocumentDirective[];
  repeats: DocumentDirective[];
  maps: DocumentDirective[];
}

function groupDirectives(directives: readonly DocumentDirective[]): GroupedDirectives {
  const groups: GroupedDirectives = {
    binds: [],
    workgroup: [],
    repeats: [],
    maps: [],
  };
  for (const d of directives) {
    const dir = d.directive;
    switch (dir.kind) {
      case 'bind':
        groups.binds.push(d);
        break;
      case 'workgroup_size':
        groups.workgroup.push(d);
        break;
      case 'repeat':
        groups.repeats.push(d);
        break;
      case 'map':
        groups.maps.push(d);
        break;
    }
  }
  return groups;
}

function sortBinds(directives: readonly DocumentDirective[]): DocumentDirective[] {
  return [...directives].sort((a, b) => {
    const aBind = a.directive as BindDirective;
    const bBind = b.directive as BindDirective;
    if (aBind.slot !== bBind.slot) return aBind.slot - bBind.slot;
    return aBind.name.localeCompare(bBind.name);
  });
}

function sortRepeats(directives: readonly DocumentDirective[]): DocumentDirective[] {
  const axisPriority: Record<string, number> = {
    global_x: 0,
    global_y: 1,
    global_z: 2,
    local_x: 3,
    local_y: 4,
    local_z: 5,
    workgroup_x: 6,
    workgroup_y: 7,
    workgroup_z: 8,
    sequential: 9,
  };
  return [...directives].sort((a, b) => {
    const aRepeat = a.directive as RepeatDirective;
    const bRepeat = b.directive as RepeatDirective;
    const ap = axisPriority[aRepeat.axis] ?? 9;
    const bp = axisPriority[bRepeat.axis] ?? 9;
    if (ap !== bp) return ap - bp;
    return aRepeat.name.localeCompare(bRepeat.name);
  });
}

function alignBinds(
  directives: readonly DocumentDirective[],
): string[] {
  if (directives.length === 0) return [];
  const regex =
    /^(?<prefix>@bind\s+(?:"[^"\\]*(?:\\.[^"\\]*)*"|[A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\d+\s*\)\s+)(?<rw>ro|rw)(?<rest>.*)$/i;
  const matches = directives.map((d) => d.raw.trim().match(regex));
  let widest = 0;
  for (const m of matches) {
    if (m?.groups?.prefix) widest = Math.max(widest, m.groups.prefix.length);
  }
  return directives.map((d, idx) => {
    const match = matches[idx];
    if (!match || !match.groups) return d.raw.trim();
    const prefix = match.groups.prefix ?? '';
    const padded = prefix.padEnd(widest, ' ');
    return padded + (match.groups.rw ?? '') + (match.groups.rest ?? '');
  });
}

function extractFrontmatterBlock(text: string, range: Range): string {
  const lines = text.split(/\r\n|\r|\n/);
  const result: string[] = [];
  for (let i = range.start.line; i <= range.end.line; i++) {
    const line = lines[i] ?? '';
    result.push(line);
  }
  return result.join('\n').replace(/\n+$/, '');
}

export function positionToOffset(
  text: string,
  position: Position,
  lineEnding: '\n' | '\r\n' = '\n',
): number {
  let line = 0;
  let column = 0;
  let offset = 0;
  for (let i = 0; i < text.length; i++) {
    if (line === position.line && column === position.character) return offset;
    const ch = text[i];
    if (ch === '\n') {
      line++;
      column = 0;
      offset += lineEnding.length;
    } else if (ch === '\r') {
      line++;
      column = 0;
      offset += 1;
      if (text[i + 1] === '\n') {
        i++;
        offset += 1;
      }
    } else {
      column++;
      offset += 1;
    }
  }
  return offset;
}

export function listBindings(directives: readonly ParsedDirective[]): BindDirective[] {
  return directives.filter((d): d is BindDirective => d.kind === 'bind');
}

export function listRepeats(directives: readonly ParsedDirective[]): RepeatDirective[] {
  return directives.filter((d): d is RepeatDirective => d.kind === 'repeat');
}

export function listMaps(directives: readonly ParsedDirective[]): MapDirective[] {
  return directives.filter((d): d is MapDirective => d.kind === 'map');
}

export function listWorkgroupSizes(
  directives: readonly ParsedDirective[],
): WorkgroupSizeDirective[] {
  return directives.filter((d): d is WorkgroupSizeDirective => d.kind === 'workgroup_size');
}
