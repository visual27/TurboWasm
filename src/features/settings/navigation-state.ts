import type { SettingsViewEntry, SettingsViewStack } from './types';

/**
 * Phase 14 (revised) — SettingsDialog view stack. Push/pop state
 * machine for the dialog's drill-down navigation. Lives outside React
 * so it can be unit-tested without rendering (= the SettingsDialog
 * component stays small). The shape mirrors a tiny history stack:
 * `push` appends, `pop` removes the top, the root entry is never
 * removed.
 */
export const ROOT_ENTRY: SettingsViewEntry = { kind: 'section' };

export function createInitialStack(): SettingsViewStack {
  return [ROOT_ENTRY];
}

export function pushView(stack: SettingsViewStack, entry: SettingsViewEntry): SettingsViewStack {
  if (stack[stack.length - 1]?.kind === entry.kind) {
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
  return top ?? ROOT_ENTRY;
}

export function canPop(stack: SettingsViewStack): boolean {
  return stack.length > 1;
}