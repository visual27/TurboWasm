/**
 * Lightweight inspection of an sb3 archive for the URLs of any custom
 * extensions the project embeds. Used by `loadProjectFromArrayBuffer`
 * to decide whether the Extension Permission dialog needs to open
 * BEFORE the VM is asked to load the project (the VM's per-URL
 * `canLoadExtensionFromProject` hook fail-fasts on the first denial).
 *
 * Mirrors the structure of `readTwconfigFromArrayBuffer`:
 *  - Dynamic-import jszip so the ~100 KB cost is not paid by the
 *    initial bundle.
 *  - Open `project.json` from the archive root.
 *  - Read the `extensionURLs` map (id → url) and return its entries.
 *  - Swallow every error path so a corrupt / missing archive produces
 *    an empty list, never throws.
 */

export interface ProjectExtensionUrl {
  /** Extension ID as recorded in `project.json#extensionURLs`. */
  id: string;
  /** URL of the extension JavaScript bundle. */
  url: string;
}

interface RawProjectJson {
  extensionURLs?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Mirror of scratch-vm's `_isValidExtensionURL` — see
 * `vendored/scaffolding/node_modules/scratch-vm/src/extension-support/extension-manager.js`.
 * Returns true for `https:`, `http:`, `data:`, and `file:` URLs only.
 */
function isValidExtensionUrl(extensionURL: string): boolean {
  try {
    const parsed = new URL(extensionURL);
    return (
      parsed.protocol === 'https:' ||
      parsed.protocol === 'http:' ||
      parsed.protocol === 'data:' ||
      parsed.protocol === 'file:'
    );
  } catch {
    return false;
  }
}

function normalizeEntries(input: unknown): ProjectExtensionUrl[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  const out: ProjectExtensionUrl[] = [];
  const seen = new Set<string>();
  for (const [id, url] of Object.entries(obj)) {
    if (!isString(id) || !isString(url)) continue;
    // Drop malformed URLs (anything that isn't http(s)/data/file). The
    // upstream scratch-vm rejects these anyway; we filter early so the
    // dialog doesn't show entries that would always fail to load.
    if (!isValidExtensionUrl(url)) continue;
    // De-duplicate by URL — a single extension may be aliased to multiple
    // ids in malformed projects, and the dialog only needs one row per URL.
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ id, url });
  }
  return out;
}

/**
 * Read the `extensionURLs` map from `project.json` of an sb3 archive.
 *
 * @param buf Raw sb3 bytes. The buffer is consumed (cloned internally by
 *   JSZip) so callers can pass either an `ArrayBuffer` or a view.
 * @returns Zero or more `{ id, url }` entries. Returns `[]` on any
 *   failure path (zip parse error, missing `project.json`, missing /
 *   malformed `extensionURLs`).
 */
export async function readExtensionURLsFromArrayBuffer(
  buf: ArrayBuffer,
): Promise<ProjectExtensionUrl[]> {
  try {
    // Dynamic import keeps jszip out of the initial bundle. Same pattern
    // as `readTwconfigFromArrayBuffer` in `@/runtime/twconfig`.
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(buf);
    const projectJsonEntry = zip.file('project.json');
    if (!projectJsonEntry) return [];
    const projectJsonText = await projectJsonEntry.async('string');
    const projectJson = JSON.parse(projectJsonText) as RawProjectJson;
    return normalizeEntries(projectJson.extensionURLs);
  } catch {
    return [];
  }
}

interface MutableProjectJson extends RawProjectJson {
  extensions?: unknown;
}

/**
 * Return a copy of the sb3 archive with `extensions` and `extensionURLs`
 * removed from `project.json`. Used by the runtime when the user picks
 * the `disabled` sandbox mode in the Extension Permission dialog: the
 * VM's per-extension permission check throws on the first denial, so
 * the only way to load the project without extensions is to hide them
 * from the VM entirely.
 *
 * Returns `null` on any failure path (zip parse error, missing
 * `project.json`, malformed JSON, missing JSZip). The caller is
 * expected to fall back to the original buffer in that case — the
 * downstream VM will then surface the normal "Permission to load
 * extension denied" error in the error log, which is still a useful
 * user-visible signal.
 */
export async function stripProjectExtensions(
  buf: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(buf);
    const projectJsonEntry = zip.file('project.json');
    if (!projectJsonEntry) return null;
    const projectJsonText = await projectJsonEntry.async('string');
    const projectJson = JSON.parse(projectJsonText) as MutableProjectJson;
    // Drop the two fields the VM consults when loading extensions.
    // We leave everything else (targets, blocks, monitors, etc.)
    // untouched so the project loads with its native blocks intact.
    if ('extensionURLs' in projectJson) delete projectJson.extensionURLs;
    if ('extensions' in projectJson) delete projectJson.extensions;
    zip.file('project.json', JSON.stringify(projectJson));
    return await zip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
    });
  } catch {
    return null;
  }
}
