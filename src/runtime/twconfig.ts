import type { AdvancedSettings, ExtensionSandboxMode } from '@/types/settings';

interface RawProjectJson {
  targets?: Array<{
    isStage?: boolean;
    comments?: unknown;
  }>;
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

/**
 * Internal AdvancedSettings keys accepted in twconfig payloads. Used for
 * backward compatibility with earlier versions of the viewer and with
 * hand-written payloads. The TurboWarp wire format is mapped to these
 * internal names further down — see {@link WIRE_FLAT_KEY_MAP} and
 * {@link WIRE_NESTED_KEY_MAP}.
 */
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
  'extensionSandboxMode',
];

/**
 * Compose the per-project runtime AdvancedSettings from a saved
 * `defaultAdvanced` baseline and the project's `// _twconfig_` overrides.
 *
 * Contract:
 *  - The project's overrides take priority over the saved defaults.
 *  - Keys absent from `overrides` fall back to the saved defaults.
 *  - `disableCompiler` is forced to `false` (it is intentionally never
 *    carried in the saved defaults — see `sanitizeAdvanced` /
 *    `saveAdvancedAsDefault`).
 *  - `turboWasmAccelerationEnabled` is taken from the baseline (so a
 *    user who disabled the WASM hook in the Settings dialog does not
 *    have it re-enabled by loading a project).
 *
 * Used by both `useSettingsStore.applyRuntimeOverrides` (Settings dialog
 * mirror) and `player.loadProjectFromArrayBuffer` (module-local VM
 * state). Centralising the merge here guarantees the two paths can
 * never drift.
 */
export function buildProjectAdvanced(
  baseline: AdvancedSettings,
  overrides: Partial<AdvancedSettings>,
): AdvancedSettings {
  return {
    ...baseline,
    ...overrides,
    disableCompiler: false,
    turboWasmAccelerationEnabled:
      baseline.turboWasmAccelerationEnabled ?? true,
  };
}

/**
 * How a TurboWarp wire-format key translates into an AdvancedSettings
 * field. The TurboWarp twconfig uses a different vocabulary than ours
 * (`framerate` vs `fps`, `hq` vs `highQualityPen`, ...) and three
 * polarity inversions:
 *
 *  - `fencing`     = "fence ON, sprites are confined to the stage"
 *                  → `removeFencing: false` (we flip the polarity)
 *  - `miscLimits`  = "miscellaneous limits are ON"
 *                  → `removeMiscLimits: false` (we flip the polarity)
 *  - `clones` / `maxClones` is a number; we coerce to
 *                  `infiniteClones: v >= 1e9`. TurboWarp treats
 *                  `Infinity` (or any value `>= 1e9`) as the
 *                  "infinite clones" sentinel.
 */
type WireKeyTransform =
  | { kind: 'direct'; internal: keyof AdvancedSettings }
  | { kind: 'inverted'; internal: keyof AdvancedSettings }
  | { kind: 'numeric-infinite'; internal: keyof AdvancedSettings };

/**
 * Top-level TurboWarp `// _twconfig_` keys (flat) and their internal
 * translation. Used by {@link parseTwconfigFromComments} when the
 * project's `project.json` comment carries the canonical wire format.
 *
 * Only the **TurboWarp wire names** are listed here (e.g. `framerate`,
 * `hq`, `fencing`). Internal viewer names like `fps` / `removeFencing`
 * are still accepted via the legacy `mapKeyToAdvanced` path so that
 * hand-written payloads and earlier save formats keep working.
 */
const WIRE_FLAT_KEY_MAP: Readonly<Record<string, WireKeyTransform>> = {
  framerate: { kind: 'direct', internal: 'fps' },
  hq: { kind: 'direct', internal: 'highQualityPen' },
  width: { kind: 'direct', internal: 'stageWidth' },
  height: { kind: 'direct', internal: 'stageHeight' },
  interpolation: { kind: 'direct', internal: 'interpolation' },
  turboMode: { kind: 'direct', internal: 'turboMode' },
  warpTimer: { kind: 'direct', internal: 'warpTimer' },
  disableCompilation: { kind: 'direct', internal: 'disableCompiler' },
  clones: { kind: 'numeric-infinite', internal: 'infiniteClones' },
  fencing: { kind: 'inverted', internal: 'removeFencing' },
  miscLimits: { kind: 'inverted', internal: 'removeMiscLimits' },
};

/**
 * Keys nested under `runtimeOptions` in the wire format. The flat-key
 * table above takes precedence over this one when both forms are
 * present.
 */
const WIRE_NESTED_KEY_MAP: Readonly<Record<string, WireKeyTransform>> = {
  miscLimits: { kind: 'inverted', internal: 'removeMiscLimits' },
  fencing: { kind: 'inverted', internal: 'removeFencing' },
  maxClones: { kind: 'numeric-infinite', internal: 'infiniteClones' },
};

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

function coerceSandboxMode(v: unknown): ExtensionSandboxMode | null {
  if (v === 'worker' || v === 'iframe' || v === 'unsandboxed') return v;
  return null;
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
      return b !== null ? ({ [key]: b } as unknown as Partial<AdvancedSettings>) : null;
    }
    case 'extensionSandboxMode': {
      const mode = coerceSandboxMode(value);
      return mode !== null ? { extensionSandboxMode: mode } : null;
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

function applyDirectValue(
  internal: keyof AdvancedSettings,
  value: unknown,
): Partial<AdvancedSettings> | null {
  if (!SUPPORTED_KEYS.includes(internal)) return null;
  // Delegate to the legacy single-key mapper so the existing type
  // coercion (fps 1..240, stage dim 1..8192, sandbox mode whitelist)
  // is reused.
  return mapKeyToAdvanced(internal, value);
}

function applyWireTransform(
  transform: WireKeyTransform,
  value: unknown,
): Partial<AdvancedSettings> | null {
  switch (transform.kind) {
    case 'direct':
      return applyDirectValue(transform.internal, value);
    case 'inverted': {
      const b = coerceBoolean(value);
      if (b === null) return null;
      return { [transform.internal]: !b } as Partial<AdvancedSettings>;
    }
    case 'numeric-infinite': {
      // TurboWarp `clones: Infinity` (or any value >= 1e9) means
      // "infinite clones". Smaller finite values are a finite cap
      // (we don't model finite caps in AdvancedSettings, so anything
      // finite maps to `false`).
      if (typeof value === 'boolean') {
        return { [transform.internal]: value } as Partial<AdvancedSettings>;
      }
      if (!isFiniteNumber(value)) return null;
      const isInfinite = value >= 1e9;
      return { [transform.internal]: isInfinite } as Partial<AdvancedSettings>;
    }
  }
}

function parseTwconfigJson(text: string): Partial<AdvancedSettings> {
  const candidate = extractFirstJsonObject(text);
  if (candidate === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Partial<AdvancedSettings> = {};
  const obj = parsed as Record<string, unknown>;
  // First pass: top-level keys, skipping the nested `runtimeOptions`
  // bag. We try the wire-format name first, then fall back to the
  // internal-name mapper (for hand-written payloads and earlier save
  // formats that used the viewer's own vocabulary).
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'runtimeOptions') continue;
    const wireTransform = WIRE_FLAT_KEY_MAP[k];
    if (wireTransform) {
      const mapped = applyWireTransform(wireTransform, v);
      if (mapped) Object.assign(result, mapped);
      continue;
    }
    const mapped = mapKeyToAdvanced(k, v);
    if (mapped) Object.assign(result, mapped);
  }
  // Second pass: nested `runtimeOptions.{miscLimits,fencing,maxClones}`.
  // Skipped when `runtimeOptions` is missing or not a plain object
  // (string / number / array / null are all silently ignored). The
  // flat key takes precedence when both forms specify the same
  // internal setting, so the nested value is only applied if the
  // flat pass did not already set the field.
  const runtimeOptions = obj.runtimeOptions;
  if (runtimeOptions && typeof runtimeOptions === 'object' && !Array.isArray(runtimeOptions)) {
    const ro = runtimeOptions as Record<string, unknown>;
    for (const [k, v] of Object.entries(ro)) {
      const transform = WIRE_NESTED_KEY_MAP[k];
      if (!transform) continue;
      const targetKey = transform.internal;
      if (Object.prototype.hasOwnProperty.call(result, targetKey)) continue;
      const mapped = applyWireTransform(transform, v);
      if (mapped) Object.assign(result, mapped);
    }
  }
  return result;
}

function* iterateCommentStrings(comments: unknown): Generator<string> {
  if (!comments) return;
  if (Array.isArray(comments)) {
    for (const c of comments) {
      if (!c || typeof c !== 'object') continue;
      const text = (c as CommentBlock).text;
      if (typeof text === 'string' && text.length > 0) yield text;
    }
    return;
  }
  if (typeof comments === 'object') {
    // Real SB3 / TurboWarp projects carry the comments as an object map
    // keyed by id, e.g. `{ blockA: { text: '...' } }`. The viewer also
    // accepts the legacy array shape (above) for hand-written payloads.
    for (const c of Object.values(comments as Record<string, unknown>)) {
      if (!c || typeof c !== 'object') continue;
      const text = (c as CommentBlock).text;
      if (typeof text === 'string' && text.length > 0) yield text;
    }
  }
}

function* iterateProjectComments(project: RawProjectJson | null): Generator<string> {
  if (!project || typeof project !== 'object') return;
  // TurboWarp stores the `_twconfig_` comment on the Stage target, not
  // on the top-level `comments` field. We consult the Stage first because
  // it is the canonical location, then fall back to the legacy top-level
  // field for backward compatibility.
  if (Array.isArray(project.targets)) {
    for (const t of project.targets) {
      if (t && typeof t === 'object' && t.isStage === true) {
        yield* iterateCommentStrings(t.comments);
        return;
      }
    }
  }
  yield* iterateCommentStrings(project.comments);
}

export function parseTwconfigFromComments(comments: unknown): Partial<AdvancedSettings> {
  // Backward-compatible input shape: the function historically accepted
  // a comment array (`[{ text: '...' }, ...]`) directly. The real SB3
  // format uses an object map keyed by id (`{ blockA: { text: '...' } }`)
  // — either the comment array at the project root, or the same shape
  // nested under `targets[isStage].comments`. We accept all three
  // shapes for forward-compat with hand-written payloads.
  let project: RawProjectJson | null = null;
  // The two "raw comments" shapes must be tested BEFORE the
  // catch-all `isProjectJson` check, otherwise a comment map is
  // mistaken for a `project.json`-shaped object (both are plain
  // objects) and `iterateProjectComments` skips straight to the
  // empty legacy `project.comments` field.
  if (isCommentArray(comments)) {
    project = { comments };
  } else if (isCommentMap(comments)) {
    project = { comments };
  } else if (isProjectJson(comments)) {
    project = comments;
  }
  for (const text of iterateProjectComments(project)) {
    if (text.indexOf(TWCONFIG_MARKER) < 0) continue;
    // The TurboWarp web editor emits the JSON either before or after
    // the `// _twconfig_` marker (`{json...} // _twconfig_` is the
    // canonical shape saved on the canvas; legacy / hand-written
    // payloads put the marker first as `// _twconfig_\n{json...}`).
    // `parseTwconfigJson` uses `extractFirstJsonObject` to find the
    // JSON wherever it lives in the text, so we just hand it the
    // whole comment.
    return parseTwconfigJson(text);
  }
  return {};
}

function isCommentArray(v: unknown): v is Array<{ text?: string }> {
  return Array.isArray(v);
}

function isProjectJson(v: unknown): v is RawProjectJson {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Returns true when `v` looks like the real-SB3 comment map shape —
 * a plain object whose values are comment-block objects (with a `text`
 * field). We require at least one value to look like a comment block
 * before accepting the shape, otherwise we would mis-detect a
 * `project.json` (which is also a plain object) as a comment map.
 */
function isCommentMap(v: unknown): v is Record<string, { text?: string }> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  // Reject objects that have the canonical `project.json` surface
  // (targets / comments at the top level). These are project-shaped,
  // not comment-map-shaped, and the project handling below already
  // covers the legacy `projectJson.comments` map case.
  if (Array.isArray(obj.targets) || 'targets' in obj) return false;
  let sawCommentBlock = false;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
      sawCommentBlock = true;
      break;
    }
  }
  return sawCommentBlock;
}

export async function readTwconfigFromArrayBuffer(
  buf: ArrayBuffer,
): Promise<Partial<AdvancedSettings>> {
  try {
    // Dynamic import keeps jszip (~100 KB) out of the initial bundle. The
    // function is already async, so this has no measurable UX cost on
    // project load — the import completes long before the asset list is
    // processed.
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(buf);
    const projectJsonEntry = zip.file('project.json');
    if (!projectJsonEntry) return {};
    const projectJsonText = await projectJsonEntry.async('string');
    const projectJson = JSON.parse(projectJsonText) as RawProjectJson;
    return parseTwconfigFromComments(projectJson);
  } catch {
    return {};
  }
}
