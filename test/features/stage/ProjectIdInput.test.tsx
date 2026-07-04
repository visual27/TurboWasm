import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProjectIdInput } from '@/features/stage/ProjectIdInput';
import { useProjectStore } from '@/stores/useProjectStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useErrorLogStore } from '@/stores/useErrorLogStore';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

const loadByIdMock = vi.fn();
const loadFileMock = vi.fn();

vi.mock('@/features/project-loader/useProjectLoader', () => ({
  useProjectLoader: (): { loadById: typeof loadByIdMock; loadFile: typeof loadFileMock } => ({
    loadById: loadByIdMock,
    loadFile: loadFileMock,
  }),
}));

function renderWithProviders(): ReturnType<typeof render> {
  return render(
    <TooltipProvider delayDuration={0}>
      <ProjectIdInput />
    </TooltipProvider>,
  );
}

function submitForm(): void {
  const form = document.querySelector(
    '[data-testid="project-id-input-form"]',
  ) as HTMLFormElement | null;
  expect(form).not.toBeNull();
  if (form) fireEvent.submit(form);
}

describe('ProjectIdInput', () => {
  beforeEach(() => {
    loadByIdMock.mockReset();
    loadByIdMock.mockResolvedValue(undefined);
    useProjectStore.setState({
      currentId: null,
      metadata: null,
      source: null,
      loadState: 'ready',
    });
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS, stageWidth: 480, stageHeight: 360 },
    });
    useErrorLogStore.setState({ entries: [] });
    localStorage.clear();
  });

  it('submits a bare numeric ID', async () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1197296165' } });
    submitForm();
    await waitFor(() => {
      expect(loadByIdMock).toHaveBeenCalledWith('1197296165');
    });
  });

  it('extracts the ID from a Scratch URL and replaces the input', async () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://scratch.mit.edu/projects/1334154904' },
    });
    submitForm();
    await waitFor(() => {
      expect(loadByIdMock).toHaveBeenCalledWith('1334154904');
    });
    // After a successful submit the field is cleared so the user can
    // queue another ID without overlapping.
    expect(input.value).toBe('');
  });

  it('extracts the ID from a TurboWarp editor URL', async () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        value: 'https://turbowarp.org/1197296165/editor?fps=48&limitless&hqpen&size=480x270',
      },
    });
    submitForm();
    await waitFor(() => {
      expect(loadByIdMock).toHaveBeenCalledWith('1197296165');
    });
  });

  it('clears the input on a successful submit', async () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '111111111' } });
    submitForm();
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('keeps the input value on a failed submit so the user can correct it', async () => {
    loadByIdMock.mockImplementation(() => Promise.reject(new Error('network')));
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999999999' } });
    submitForm();
    await waitFor(() => {
      expect(loadByIdMock).toHaveBeenCalled();
    });
    // Allow the rejected promise to flush so it does not surface as an
    // unhandled rejection.
    await new Promise((r) => setTimeout(r, 0));
    // The field stays populated so the user can retry with the same value.
    expect(input.value).toBe('999999999');
  });

  it('disables the input and the button while loading', () => {
    useProjectStore.setState({ loadState: 'loading' });
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    const button = screen.getByTestId('project-id-input-load') as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it('does not call loadById for empty input', () => {
    renderWithProviders();
    submitForm();
    expect(loadByIdMock).not.toHaveBeenCalled();
  });

  it('the form has noValidate so URLs are not blocked by browser validation', () => {
    renderWithProviders();
    const form = document.querySelector('[data-testid="project-id-input-form"]') as HTMLFormElement;
    expect(form.hasAttribute('noValidate')).toBe(true);
  });
});

describe('ProjectIdInput — debug commands', () => {
  beforeEach(() => {
    loadByIdMock.mockReset();
    loadByIdMock.mockResolvedValue(undefined);
    useProjectStore.setState({
      currentId: null,
      metadata: null,
      source: null,
      loadState: 'ready',
    });
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS, stageWidth: 480, stageHeight: 360 },
    });
    useErrorLogStore.setState({ entries: [] });
    localStorage.clear();
  });

  it('does not invoke loadById when a debug command is entered', () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '!help' } });
    submitForm();
    expect(loadByIdMock).not.toHaveBeenCalled();
  });

  it('clears the input after a debug command', () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '!help' } });
    submitForm();
    expect(input.value).toBe('');
  });

  it('pushes an info log for a known debug command', () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '!help' } });
    submitForm();
    const entries = useErrorLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.severity).toBe('info');
    expect(entries[0]?.message).toMatch(/Debug commands:/);
  });

  it('pushes a warn log for an unknown command', () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '!nope' } });
    submitForm();
    const entries = useErrorLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.severity).toBe('warn');
    expect(entries[0]?.message).toMatch(/Unknown debug command/);
  });

  it('!reset clears the input, logs info, and resets the settings store', () => {
    useSettingsStore.getState().setTheme('dark');
    useSettingsStore.getState().setVolume(0);
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '!reset' } });
    submitForm();
    expect(input.value).toBe('');
    expect(useSettingsStore.getState().theme).toBe('system');
    expect(useSettingsStore.getState().volume).toBe(100);
    const entries = useErrorLogStore.getState().entries;
    expect(entries[0]?.severity).toBe('info');
    expect(entries[0]?.message).toMatch(/Reset all settings/);
  });

  it('the Load button is enabled for debug-command input even though it is not a project ID', () => {
    renderWithProviders();
    const input = screen.getByTestId('project-id-input') as HTMLInputElement;
    const button = screen.getByTestId('project-id-input-load') as HTMLButtonElement;
    fireEvent.change(input, { target: { value: '!help' } });
    expect(button.disabled).toBe(false);
  });
});
