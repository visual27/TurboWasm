import JSZip from 'jszip';
import type { AdvancedSettings } from '@/types/settings';

interface RawProjectJson {
  comments?: unknown;
}

interface CommentBlock {
  blockId?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  text: string;
}

const TWCONFIG_MARKER = '// _twconfig_';
const SUPPORTED_KEYS: ReadonlyArray<keyof AdvancedSettings> = [
  'fps',
  'interpolation',
  'highQualityPen',
  'warpTimer',
  'infiniteClones',
  'removeFencing',
  'removeMiscLimits',
  'turboMode',
  'disableCompiler',
  'stageWidth',
  'stageHeight',
];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function coerceBoolean(v: unknown): boolean | null {
  if (isBoolean(v)) return v;
  return null;
}

function coerceFps(v: unknown): number | null {
  if (!isFiniteNumber(v)) return null;
  if (v < 1 || v > 240) return null;
  return Math.round(v);
}

function coerceStageDim(v: unknown): number | null {
  if (!isFiniteNumber(v)) return null;
  if (v < 1 || v > 8192) return null;
  return Math.round(v);
}

function mapKeyToAdvanced(key: string, value: unknown): Partial<AdvancedSettings> | null {
  if (!SUPPORTED_KEYS.includes(key as keyof AdvancedSettings)) return null;
  switch (key) {
    case 'fps':
      return coerceFps(value) !== null ? { fps: coerceFps(value) as number } : null;
    case 'stageWidth':
      return coerceStageDim(value) !== null
        ? { stageWidth: coerceStageDim(value) as number }
        : null;
    case 'stageHeight':
      return coerceStageDim(value) !== null
        ? { stageHeight: coerceStageDim(value) as number }
        : null;
    case 'interpolation':
    case 'highQualityPen':
    case 'warpTimer':
    case 'infiniteClones':
    case 'removeFencing':
    case 'removeMiscLimits':
    case 'turboMode':
    case 'disableCompiler': {
      const b = coerceBoolean(value);
      return b !== null
        ? ({ [key]: b } as unknown as Partial<AdvancedSettings>)
        : null;
    }
    default:
      return null;
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseTwconfigJson(text: string): Partial<AdvancedSettings> {
  const candidate = extractFirstJsonObject(text);
  if (candidate === null) return {};
  const parsed: unknown = JSON.parse(candidate);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Partial<AdvancedSettings> = {};
  const obj = parsed as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    const mapped = mapKeyToAdvanced(k, v);
    if (mapped) Object.assign(result, mapped);
  }
  return result;
}

function* iterateCommentStrings(comments: unknown): Generator<string> {
  if (!Array.isArray(comments)) return;
  for (const c of comments) {
    if (!c || typeof c !== 'object') continue;
    const text = (c as CommentBlock).text;
    if (typeof text === 'string' && text.length > 0) yield text;
  }
}

export function parseTwconfigFromComments(comments: unknown): Partial<AdvancedSettings> {
  for (const text of iterateCommentStrings(comments)) {
    const idx = text.indexOf(TWCONFIG_MARKER);
    if (idx < 0) continue;
    const after = text.slice(idx + TWCONFIG_MARKER.length);
    try {
      return parseTwconfigJson(after);
    } catch {
      return {};
    }
  }
  return {};
}

export async function readTwconfigFromArrayBuffer(
  buf: ArrayBuffer,
): Promise<Partial<AdvancedSettings>> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const projectJsonEntry = zip.file('project.json');
    if (!projectJsonEntry) return {};
    const projectJsonText = await projectJsonEntry.async('string');
    const projectJson = JSON.parse(projectJsonText) as RawProjectJson;
    return parseTwconfigFromComments(projectJson.comments);
  } catch {
    return {};
  }
}