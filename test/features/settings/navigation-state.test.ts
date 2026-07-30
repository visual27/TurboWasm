import { describe, expect, it } from 'vitest';
import {
  canPop,
  createInitialStack,
  currentView,
  popView,
  pushView,
  ROOT_ENTRY,
} from '@/features/settings/navigation-state';
import type { SettingsViewStack } from '@/features/settings/types';

describe('navigation-state (SettingsDialog view stack)', () => {
  it('createInitialStack returns a single root entry', () => {
    const stack = createInitialStack();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toEqual(ROOT_ENTRY);
    expect(stack[0]?.kind).toBe('section');
  });

  it('ROOT_ENTRY is the section kind', () => {
    expect(ROOT_ENTRY.kind).toBe('section');
  });

  it('pushView appends a new entry to the stack', () => {
    const stack = createInitialStack();
    const next = pushView(stack, { kind: 'detailed' });
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ kind: 'detailed' });
    expect(next[0]).toEqual(ROOT_ENTRY);
  });

  it('pushView is a no-op when the top entry already matches the kind (avoid stacking duplicates)', () => {
    const stack: SettingsViewStack = [ROOT_ENTRY, { kind: 'detailed' }];
    const next = pushView(stack, { kind: 'detailed' });
    expect(next).toBe(stack);
    expect(next).toHaveLength(2);
  });

  it('pushView does not mutate the source stack', () => {
    const stack = createInitialStack();
    pushView(stack, { kind: 'detailed' });
    expect(stack).toHaveLength(1);
  });

  it('popView removes the top entry when stack length > 1', () => {
    const stack: SettingsViewStack = [ROOT_ENTRY, { kind: 'detailed' }];
    const next = popView(stack);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(ROOT_ENTRY);
  });

  it('popView is a no-op when the stack only contains the root entry', () => {
    const stack = createInitialStack();
    const next = popView(stack);
    expect(next).toBe(stack);
    expect(next).toHaveLength(1);
  });

  it('popView does not mutate the source stack', () => {
    const stack: SettingsViewStack = [ROOT_ENTRY, { kind: 'detailed' }];
    popView(stack);
    expect(stack).toHaveLength(2);
  });

  it('currentView returns the top entry', () => {
    const stack: SettingsViewStack = [ROOT_ENTRY, { kind: 'detailed' }];
    expect(currentView(stack).kind).toBe('detailed');
  });

  it('currentView falls back to ROOT_ENTRY for an empty stack', () => {
    const stack: SettingsViewStack = [];
    expect(currentView(stack)).toEqual(ROOT_ENTRY);
  });

  it('canPop is false at the root entry', () => {
    const stack = createInitialStack();
    expect(canPop(stack)).toBe(false);
  });

  it('canPop is true once the user has drilled in', () => {
    const stack: SettingsViewStack = [ROOT_ENTRY, { kind: 'detailed' }];
    expect(canPop(stack)).toBe(true);
    const deeper: SettingsViewStack = [ROOT_ENTRY, { kind: 'detailed' }, { kind: 'semantics' }];
    expect(canPop(deeper)).toBe(true);
  });

  it('two-level push/pop round-trip restores the root stack', () => {
    let stack = createInitialStack();
    stack = pushView(stack, { kind: 'detailed' });
    stack = pushView(stack, { kind: 'semantics' });
    expect(currentView(stack).kind).toBe('semantics');
    stack = popView(stack);
    expect(currentView(stack).kind).toBe('detailed');
    stack = popView(stack);
    expect(currentView(stack).kind).toBe('section');
    expect(canPop(stack)).toBe(false);
  });
});