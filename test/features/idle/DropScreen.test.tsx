import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DropScreen } from '@/features/idle/DropScreen';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { useProjectStore } from '@/stores/useProjectStore';

const loadByIdMock = vi.fn();
const loadFileMock = vi.fn();

vi.mock('@/features/project-loader/useProjectLoader', () => ({
  useProjectLoader: (): { loadById: typeof loadByIdMock; loadFile: typeof loadFileMock } => ({
    loadById: loadByIdMock,
    loadFile: loadFileMock,
  }),
}));

function setProjectIdValue(value: string): void {
  const input = screen.getByLabelText('Project ID') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

function submitForm(): void {
  const form = document.querySelector('form');
  expect(form).not.toBeNull();
  if (form) fireEvent.submit(form);
}

describe('DropScreen project ID URL extraction', () => {
  beforeEach(() => {
    loadByIdMock.mockReset();
    loadFileMock.mockReset();
    useErrorLogStore.setState({ entries: [] });
    useProjectStore.setState({
      currentId: null,
      metadata: null,
      source: null,
      loadState: 'idle',
    });
  });

  it('submits a bare numeric ID as-is', async () => {
    render(<DropScreen />);
    setProjectIdValue('1197296165');
    submitForm();
    await waitFor(() => {
      expect(loadByIdMock).toHaveBeenCalledWith('1197296165');
    });
  });

  it('extracts the ID from a Scratch URL and replaces the input', async () => {
    render(<DropScreen />);
    setProjectIdValue('https://scratch.mit.edu/projects/1334154904');
    submitForm();
    await waitFor(() => {
      expect(loadByIdMock).toHaveBeenCalledWith('1334154904');
    });
    const input = screen.getByLabelText('Project ID') as HTMLInputElement;
    expect(input.value).toBe('1334154904');
  });

  it('extracts the ID from a TurboWarp editor URL and replaces the input', async () => {
    render(<DropScreen />);
    setProjectIdValue(
      'https://turbowarp.org/1197296165/editor?fps=48&limitless&hqpen&size=480x270',
    );
    submitForm();
    await waitFor(() => {
      expect(loadByIdMock).toHaveBeenCalledWith('1197296165');
    });
    const input = screen.getByLabelText('Project ID') as HTMLInputElement;
    expect(input.value).toBe('1197296165');
  });

  it('extracts the ID from a TurboWarp hash URL', async () => {
    render(<DropScreen />);
    setProjectIdValue('https://turbowarp.org/#1197296165');
    submitForm();
    await waitFor(() => {
      expect(loadByIdMock).toHaveBeenCalledWith('1197296165');
    });
  });

  it('does not call loadById for empty input', () => {
    render(<DropScreen />);
    submitForm();
    expect(loadByIdMock).not.toHaveBeenCalled();
  });

  it('shows an error for non-numeric / non-URL input', () => {
    render(<DropScreen />);
    setProjectIdValue('hello world');
    submitForm();
    expect(loadByIdMock).not.toHaveBeenCalled();
    const errors = useErrorLogStore.getState().entries.filter((e) => e.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toMatch(/numeric|URL/i);
  });

  it('the form has noValidate so pasting a URL does not trigger a browser popup', () => {
    render(<DropScreen />);
    const form = document.querySelector('form');
    expect(form?.hasAttribute('noValidate')).toBe(true);
  });

  it('the project id input has no pattern attribute (so URLs are not blocked by browser validation)', () => {
    render(<DropScreen />);
    const input = screen.getByLabelText('Project ID') as HTMLInputElement;
    expect(input.getAttribute('pattern')).toBeNull();
  });
});
