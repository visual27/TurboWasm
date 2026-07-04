/**
 * Extract a numeric Scratch / TurboWarp project ID from arbitrary input.
 *
 * Accepts:
 *  - A bare numeric ID, e.g. "1197296165"
 *  - Scratch URLs, e.g. "https://scratch.mit.edu/projects/1334154904"
 *  - Scratch URLs with trailing path/query/fragment, e.g.
 *    "https://scratch.mit.edu/projects/1334154904/#player"
 *  - TurboWarp editor URLs, e.g.
 *    "https://turbowarp.org/1197296165/editor?fps=48&limitless&hqpen&size=480x270"
 *  - TurboWarp hash URLs, e.g. "https://turbowarp.org/#1197296165"
 *  - TurboWarp embed URLs, e.g.
 *    "https://turbowarp.org/embed.html?id=1197296165"
 *
 * Returns null if no 4–20 digit ID is present.
 *
 * Strategy: scan the input for the first run of 4–20 consecutive digits. We
 * deliberately ignore the URL scheme / host and any leading or trailing
 * non-digit characters. This avoids brittle per-URL parsing and naturally
 * covers future URL shapes.
 */
const ID_PATTERN = /(\d{4,20})/;

export function extractProjectId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = ID_PATTERN.exec(trimmed);
  if (!match) return null;
  const id = match[1];
  return id ?? null;
}
