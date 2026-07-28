import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorLogPanel } from '@/features/error-log/ErrorLogPanel';
import {
  __resetErrorLogOnceForTesting,
  useErrorLogStore,
} from '@/stores/useErrorLogStore';

describe('ErrorLogPanel', () => {
  beforeEach(() => {
    useErrorLogStore.setState({ entries: [] });
    __resetErrorLogOnceForTesting();
  });

  it('renders nothing when there are no entries', () => {
    const { container } = render(<ErrorLogPanel />);
    expect(container.querySelector('section')).toBeNull();
  });

  it('renders both error and warn entries (§Phase 7: warns are surfaced)', () => {
    useErrorLogStore.setState({
      entries: [
        { id: 'e1', severity: 'info', message: 'info msg', ts: 1, visible: true },
        { id: 'e2', severity: 'warn', message: 'warn msg', ts: 2, visible: true },
        { id: 'e3', severity: 'error', message: 'error one', ts: 3, visible: true },
        { id: 'e4', severity: 'error', message: 'error two', ts: 4, visible: true },
      ],
    });
    render(<ErrorLogPanel />);
    // 2 errors + 1 warning surfaced.
    expect(screen.getByText(/2 errors/i)).toBeInTheDocument();
    expect(screen.getByText(/1 warning/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Expand errors/i));
    expect(screen.getByText('error one')).toBeInTheDocument();
    expect(screen.getByText('error two')).toBeInTheDocument();
    expect(screen.getByText('warn msg')).toBeInTheDocument();
    // info still filtered out.
    expect(screen.queryByText('info msg')).toBeNull();
  });

  it('uses singular labels when only one entry of each severity is present', () => {
    useErrorLogStore.setState({
      entries: [
        { id: 'e1', severity: 'error', message: 'only one', ts: 1, visible: true },
        { id: 'e2', severity: 'warn', message: 'only warning', ts: 2, visible: true },
      ],
    });
    render(<ErrorLogPanel />);
    // The summary combines both counts into one line (= "1 error · 1
    // warning"). The panel deliberately merges them so the user can
    // see the full state in one glance.
    expect(screen.getByText(/1 error.*1 warning/i)).toBeInTheDocument();
  });

  it('uses singular "warning" label when there is only one warning and no errors', () => {
    useErrorLogStore.setState({
      entries: [
        { id: 'e1', severity: 'warn', message: 'only warning', ts: 1, visible: true },
      ],
    });
    render(<ErrorLogPanel />);
    expect(screen.getByText(/^1 warning$/i)).toBeInTheDocument();
  });

  it('panel is labelled "Errors"', () => {
    useErrorLogStore.setState({
      entries: [{ id: 'e1', severity: 'error', message: 'err', ts: 1, visible: true }],
    });
    render(<ErrorLogPanel />);
    expect(screen.getByLabelText(/^Errors$/i)).toBeInTheDocument();
  });
});

describe('useErrorLogStore — pushOnce (§Phase 7)', () => {
  beforeEach(() => {
    useErrorLogStore.setState({ entries: [] });
    __resetErrorLogOnceForTesting();
  });

  it('pushOnce inserts the entry the first time', () => {
    useErrorLogStore.getState().pushOnce('warn', '[semantics] preset-applied', 'preset.full-js');
    const entries = useErrorLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe('[semantics] preset-applied');
    expect(entries[0]?.severity).toBe('warn');
  });

  it('pushOnce is a no-op for repeat calls with the same dedupKey', () => {
    useErrorLogStore.getState().pushOnce('warn', '[semantics] preset-applied', 'preset.full-js');
    useErrorLogStore.getState().pushOnce('warn', '[semantics] preset-applied', 'preset.full-js');
    expect(useErrorLogStore.getState().entries).toHaveLength(1);
  });

  it('pushOnce re-warns after the dedup bucket is reset', () => {
    useErrorLogStore.getState().pushOnce('warn', 'first', 'preset.full-js');
    __resetErrorLogOnceForTesting();
    useErrorLogStore.getState().pushOnce('warn', 'second', 'preset.full-js');
    expect(useErrorLogStore.getState().entries).toHaveLength(2);
  });

  it('pushOnce with different dedupKeys tracks each independently', () => {
    useErrorLogStore.getState().pushOnce('warn', 'first', 'preset.full-js');
    useErrorLogStore.getState().pushOnce('warn', 'second', 'preset.low-risk-js');
    expect(useErrorLogStore.getState().entries).toHaveLength(2);
  });
});
