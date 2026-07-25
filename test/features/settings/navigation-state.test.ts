import { describe, expect, it } from 'vitest';
import {
  canPop,
  createInitialStack,
  currentView,
  popView,
  pushView,
  ROOT_ENTRY,
  stackToBreadcrumb,
} from '@/features/settings/navigation-state';
import type { SettingsViewStack } from '@/features/settings/types';

describe('navigation-state (Phase 0)', () => {
  it('createInitialStack seeds the root entry', () => {
    const stack = createInitialStack();
    expect(stack).toEqual([ROOT_ENTRY]);
    expect(currentView(stack)).toEqual(ROOT_ENTRY);
    expect(canPop(stack)).toBe(false);
  });

  it('pushView appends a new entry and exposes it as the current view', () => {
    const stack = createInitialStack();
    const next = pushView(stack, { kind: 'detailed' });
    expect(next).toHaveLength(2);
    expect(currentView(next)).toEqual({ kind: 'detailed' });
    expect(canPop(next)).toBe(true);
  });

  it('pushView is a no-op when stacking the same entry kind twice', () => {
    const stack = pushView(createInitialStack(), { kind: 'detailed' });
    const next = pushView(stack, { kind: 'detailed' });
    expect(next).toBe(stack);
  });

  it('popView removes the top entry but preserves the root', () => {
    const stack = pushView(createInitialStack(), { kind: 'detailed' });
    const popped = popView(stack);
    expect(popped).toEqual([ROOT_ENTRY]);
    expect(canPop(popped)).toBe(false);
  });

  it('popView on the root is a no-op', () => {
    const stack = createInitialStack();
    expect(popView(stack)).toBe(stack);
  });

  it('stackToBreadcrumb formats a multi-entry trail', () => {
    const stack: SettingsViewStack = [
      ROOT_ENTRY,
      { kind: 'detailed' },
      { kind: 'detailed-category', categoryId: 'comparison' },
    ];
    expect(stackToBreadcrumb(stack)).toBe('TurboWasm › Detailed Settings › Comparison');
  });

  it('stackToBreadcrumb falls back to the root label for the root stack', () => {
    expect(stackToBreadcrumb(createInitialStack())).toBe('TurboWasm');
  });
});