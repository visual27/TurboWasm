import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorLogPanel } from '@/features/error-log/ErrorLogPanel';
import { useErrorLogStore } from '@/stores/useErrorLogStore';

describe('ErrorLogPanel', () => {
  beforeEach(() => {
    useErrorLogStore.setState({ entries: [] });
  });

  it('renders nothing when there are no entries', () => {
    const { container } = render(<ErrorLogPanel />);
    expect(container.querySelector('section')).toBeNull();
  });

  it('renders only error-severity entries (filters out info and warn) when expanded', () => {
    useErrorLogStore.setState({
      entries: [
        { id: 'e1', severity: 'info', message: 'info msg', ts: 1, visible: true },
        { id: 'e2', severity: 'warn', message: 'warn msg', ts: 2, visible: true },
        { id: 'e3', severity: 'error', message: 'error one', ts: 3, visible: true },
        { id: 'e4', severity: 'error', message: 'error two', ts: 4, visible: true },
      ],
    });
    render(<ErrorLogPanel />);
    // Count text appears as "2 errors" because only 2 are errors
    expect(screen.getByText(/2 errors/i)).toBeInTheDocument();
    // Expand to verify error messages are present and info/warn are filtered out.
    fireEvent.click(screen.getByLabelText(/Expand errors/i));
    expect(screen.getByText('error one')).toBeInTheDocument();
    expect(screen.getByText('error two')).toBeInTheDocument();
    expect(screen.queryByText('info msg')).toBeNull();
    expect(screen.queryByText('warn msg')).toBeNull();
  });

  it('uses singular "error" label when there is only one error', () => {
    useErrorLogStore.setState({
      entries: [{ id: 'e1', severity: 'error', message: 'only one', ts: 1, visible: true }],
    });
    render(<ErrorLogPanel />);
    expect(screen.getByText(/^1 error$/i)).toBeInTheDocument();
  });

  it('panel is labelled "Errors"', () => {
    useErrorLogStore.setState({
      entries: [{ id: 'e1', severity: 'error', message: 'err', ts: 1, visible: true }],
    });
    render(<ErrorLogPanel />);
    expect(screen.getByLabelText(/^Errors$/i)).toBeInTheDocument();
  });
});
