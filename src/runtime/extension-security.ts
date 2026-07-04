import type { AdvancedSettings, ExtensionSandboxMode } from '@/types/settings';

/**
 * The shape that `scaffolding.setExtensionSecurityManager` accepts. The
 * upstream scratch-vm SecurityManager class exposes additional methods
 * (`canFetch`, `canOpenWindow`, etc.) but the viewer only customizes the
 * two that gate project-embedded extensions; all other policies fall
 * back to upstream defaults.
 *
 * Values can be either a boolean (for synchronous checks) or a Promise of
 * a boolean (for async checks). Upstream accepts both.
 */
export interface ExtensionSecurityManager {
  canLoadExtensionFromProject: (extensionURL: string) => boolean | Promise<boolean>;
  getSandboxMode: (extensionURL: string) => ExtensionSandboxMode | Promise<ExtensionSandboxMode>;
}

/**
 * Per-session deny list of extension URLs the user has explicitly rejected
 * for the current page load. Persists across dialog re-opens within the
 * same tab but is reset on full page reload — keeping "deny" sticky would
 * be more surprising than useful, since the safe default is to deny
 * anyway.
 *
 * Module-level state because the security manager closure is constructed
 * once and re-read on every policy check; both reads and writes go
 * through the same Set.
 */
const sessionDeniedUrls: Set<string> = new Set();

/**
 * Test-only: reset the in-memory session deny list. Not used in app code
 * because the deny list resets naturally on every page reload.
 */
export function __resetSessionDeniedUrlsForTesting(): void {
  sessionDeniedUrls.clear();
}

/**
 * Add a URL to the in-memory session deny list. The security manager
 * consults this on every policy check, so future calls for the same URL
 * immediately resolve to `false`.
 */
export function addSessionDeniedExtensionUrl(url: string): void {
  const trimmed = url.trim();
  if (trimmed.length === 0) return;
  sessionDeniedUrls.add(trimmed);
}

/**
 * Remove a URL from the in-memory session deny list. Primarily useful if
 * a future UI exposes a "re-prompt" affordance; the prompt path itself
 * never needs to call this.
 */
export function removeSessionDeniedExtensionUrl(url: string): boolean {
  return sessionDeniedUrls.delete(url.trim());
}

/**
 * Clear every URL from the in-memory session deny list. Used by the
 * debug-command `!reset` so a user can start a fresh session without
 * reloading the page.
 */
export function clearSessionDeniedExtensionUrls(): void {
  sessionDeniedUrls.clear();
}

/**
 * Build a security manager that consults two lists:
 *
 *  - The persistent `allowedExtensionUrls` snapshot the user has approved
 *    in a previous session. These resolve to `true` without prompting.
 *  - The session-only `sessionDeniedUrls` set. These resolve to `false`
 *    immediately without prompting.
 *  - Anything else resolves to `false`, which causes the upstream VM to
 *    throw "Permission to load extension denied". The viewer catches the
 *    throw *before* the VM sees it (in `loadProjectFromArrayBuffer`) and
 *    instead pops the Extension Permission dialog.
 *
 * @param getSettings Function returning the current advanced settings.
 *   Receives a function so the manager reads fresh values on every
 *   check (settings can change while the VM is running).
 *
 * @param getAllowedUrls Function returning the current persistent
 *   allow-list snapshot. Also re-read on every policy check so the
 *   prompt's resolution is visible without rebuilding the manager.
 */
export function createExtensionSecurityManager(
  getSettings: () => AdvancedSettings,
  getAllowedUrls: () => readonly string[],
): ExtensionSecurityManager {
  return {
    canLoadExtensionFromProject: (extensionURL: string): boolean => {
      const url = extensionURL.trim();
      if (url.length === 0) return false;
      // Global kill-switch: when the user picks `disabled` from the
      // sandbox-mode radio in the Extension Permission dialog, every
      // extension request is denied regardless of allow-list membership.
      // The viewer also strips `extensions` / `extensionURLs` from
      // `project.json` before the VM sees the buffer, so this branch is
      // mostly a defensive backstop in case the strip is bypassed.
      if (getSettings().extensionSandboxMode === 'disabled') return false;
      // Persistent allow-list always wins: a user who previously approved
      // an extension should never be re-prompted for it.
      if (getAllowedUrls().includes(url)) return true;
      // Session deny list is consulted after the allow-list so a user
      // who approves a URL later in the session can immediately load it
      // even if they had denied it earlier.
      if (sessionDeniedUrls.has(url)) return false;
      // Default-deny. The caller (player.ts) is responsible for catching
      // the resulting "Permission to load extension denied" error from
      // the VM and surfacing the Extension Permission dialog. Returning
      // `false` here keeps the security manager policy itself synchronous
      // and side-effect free.
      return false;
    },
    getSandboxMode: (_extensionURL: string): ExtensionSandboxMode => {
      const mode = getSettings().extensionSandboxMode;
      // Defensive: if the stored value is somehow not one of the known
      // four strings, fall back to the safe default.
      return mode === 'worker' ||
        mode === 'iframe' ||
        mode === 'unsandboxed' ||
        mode === 'disabled'
        ? mode
        : 'worker';
    },
  };
}

/**
 * Apply the current advanced settings to the scaffolding's extension
 * security manager. Safe to call repeatedly; each call replaces the
 * previously installed manager.
 */
export function applyExtensionSecurityManager(
  scaffolding: { setExtensionSecurityManager: (m: Record<string, unknown>) => void },
  getSettings: () => AdvancedSettings,
  getAllowedUrls: () => readonly string[],
): void {
  scaffolding.setExtensionSecurityManager(
    createExtensionSecurityManager(getSettings, getAllowedUrls) as unknown as Record<
      string,
      unknown
    >,
  );
}
