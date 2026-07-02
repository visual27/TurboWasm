import { beforeEach, describe, expect, it } from 'vitest';
import { useErrorLogStore } from '@/stores/useErrorLogStore';

describe('useErrorLogStore', () => {
  beforeEach(() => {
    useErrorLogStore.setState({ entries: [] });
  });

  it('pushes an entry with timestamp', () => {
    useErrorLogStore.getState().push('info', 'hello');
    const entries = useErrorLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe('hello');
    expect(entries[0]?.severity).toBe('info');
    expect(typeof entries[0]?.ts).toBe('number');
  });

  it('caps at 20 entries', () => {
    for (let i = 0; i < 30; i++) {
      useErrorLogStore.getState().push('info', `msg-${i}`);
    }
    expect(useErrorLogStore.getState().entries).toHaveLength(20);
    expect(useErrorLogStore.getState().entries.at(-1)?.message).toBe('msg-29');
  });

  it('dismisses a single entry', () => {
    useErrorLogStore.getState().push('error', 'a');
    useErrorLogStore.getState().push('error', 'b');
    const firstId = useErrorLogStore.getState().entries[0]?.id as string;
    useErrorLogStore.getState().dismiss(firstId);
    expect(useErrorLogStore.getState().entries).toHaveLength(1);
    expect(useErrorLogStore.getState().entries[0]?.message).toBe('b');
  });

  it('clear empties the log', () => {
    useErrorLogStore.getState().push('warn', 'x');
    useErrorLogStore.getState().clear();
    expect(useErrorLogStore.getState().entries).toHaveLength(0);
  });
});