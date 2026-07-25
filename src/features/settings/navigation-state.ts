import type { DetailedCategoryId, SettingsViewEntry, SettingsViewStack } from './types';

/**
 * Phase 0 — Foundation. Push/pop state machine for the SettingsDialog
 * view stack. Lives outside React so it can be tested without rendering
 * (and so the SettingsDialog component stays small). The shape mirrors
 * a tiny history stack: a `push` appends, `pop` removes the top, the
 * root entry (`section: turboWasm`) is never removed.
 */
export const ROOT_ENTRY: SettingsViewEntry = { kind: 'section', section: 'turboWasm' };

export function createInitialStack(): SettingsViewStack {
  return [ROOT_ENTRY];
}

export function pushView(stack: SettingsViewStack, entry: SettingsViewEntry): SettingsViewStack {
  if (stack[stack.length - 1]?.kind === entry.kind) {
    // Avoid stacking identical entries on top of each other — keeps
    // back navigation a single-step undo.
    return stack;
  }
  return [...stack, entry];
}

export function popView(stack: SettingsViewStack): SettingsViewStack {
  if (stack.length <= 1) return stack;
  return stack.slice(0, -1);
}

export function currentView(stack: SettingsViewStack): SettingsViewEntry {
  const top = stack[stack.length - 1];
  // The root entry is always present, so `top` is never undefined at
  // runtime. Fall back to the root for the type narrow.
  return top ?? ROOT_ENTRY;
}

export function canPop(stack: SettingsViewStack): boolean {
  return stack.length > 1;
}

/**
 * Convert the view stack into a human-readable breadcrumb. The root
 * entry is rendered as "TurboWasm" so the user always has a stable
 * anchor label, even after a few push/pop round-trips.
 */
export function stackToBreadcrumb(stack: SettingsViewStack): string {
  return stack
    .map((entry) => labelFor(entry))
    .filter((label): label is string => Boolean(label))
    .join(' › ');
}

function labelFor(entry: SettingsViewEntry): string | null {
  switch (entry.kind) {
    case 'section':
      // The root entry is the only `section` we ship in Phase 0.
      // Future sections would add their own case here.
      return 'TurboWasm';
    case 'detailed':
      return 'Detailed Settings';
    case 'detailed-category':
      return categoryLabel(entry.categoryId);
    default:
      return null;
  }
}

function categoryLabel(categoryId: DetailedCategoryId): string {
  switch (categoryId) {
    case 'compat-layer':
      return 'Compatibility Layer';
    case 'edge-detection':
      return 'Edge Detection';
    case 'comparison':
      return 'Comparison';
    case 'data-structures':
      return 'Data Structures';
    case 'compiler':
      return 'Compiler';
    case 'semantics':
      return 'Semantics';
    default:
      return categoryId;
  }
}