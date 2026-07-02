import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useErrorLogStore } from '@/stores/useErrorLogStore';

const loadFileMock = vi.fn();
const loadByIdMock = vi.fn();

vi.mock('@/features/project-loader/useProjectLoader', () => ({
  useProjectLoader: (): { loadFile: typeof loadFileMock; loadById: typeof loadByIdMock } => ({
    loadFile: loadFileMock,
    loadById: loadByIdMock,
  }),
}));

function renderWithProviders(): ReturnType<typeof render> {
  return render(
    <TooltipProvider delayDuration={0}>
      <ThemeToggle />
    </TooltipProvider>,
  );
}

describe('ThemeToggle vertical dropdown', () => {
  beforeEach(() => {
    loadFileMock.mockReset();
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      advanced: {
        fps: 30,
        interpolation: false,
        highQualityPen: false,
        warpTimer: false,
        infiniteClones: false,
        removeFencing: false,
        removeMiscLimits: false,
        turboMode: false,
        disableCompiler: false,
        stageWidth: 480,
        stageHeight: 360,
      },
    });
    useErrorLogStore.setState({ entries: [] });
  });

  it('renders the theme trigger and the upload trigger', () => {
    renderWithProviders();
    expect(screen.getByTestId('theme-toggle-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('upload-trigger')).toBeInTheDocument();
  });

  it('does not show theme options until the dropdown is opened', () => {
    renderWithProviders();
    expect(screen.queryByTestId('theme-option-system')).toBeNull();
    expect(screen.queryByTestId('theme-option-light')).toBeNull();
    expect(screen.queryByTestId('theme-option-dark')).toBeNull();
  });

  it('opens the dropdown and lists all three options vertically', async () => {
    renderWithProviders();
    fireEvent.click(screen.getByTestId('theme-toggle-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('theme-option-system')).toBeInTheDocument();
    });
    expect(screen.getByTestId('theme-option-light')).toBeInTheDocument();
    expect(screen.getByTestId('theme-option-dark')).toBeInTheDocument();
  });

  it('selects a theme by clicking its option', async () => {
    renderWithProviders();
    fireEvent.click(screen.getByTestId('theme-toggle-trigger'));
    await waitFor(() => screen.getByTestId('theme-option-dark'));
    fireEvent.click(screen.getByTestId('theme-option-dark'));
    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('marks the currently active theme with aria-checked', async () => {
    useSettingsStore.setState({ theme: 'light' });
    renderWithProviders();
    fireEvent.click(screen.getByTestId('theme-toggle-trigger'));
    await waitFor(() => screen.getByTestId('theme-option-light'));
    expect(screen.getByTestId('theme-option-light').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('theme-option-dark').getAttribute('aria-checked')).toBe('false');
  });
});

describe('ThemeToggle upload button', () => {
  beforeEach(() => {
    loadFileMock.mockReset();
    useSettingsStore.setState({
      theme: 'system',
      volume: 100,
      advanced: {
        fps: 30,
        interpolation: false,
        highQualityPen: false,
        warpTimer: false,
        infiniteClones: false,
        removeFencing: false,
        removeMiscLimits: false,
        turboMode: false,
        disableCompiler: false,
        stageWidth: 480,
        stageHeight: 360,
      },
    });
    useErrorLogStore.setState({ entries: [] });
  });

  it('clicking the upload button opens a file picker (input.click is called)', () => {
    renderWithProviders();
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('upload-trigger'));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('selecting a valid .sb3 file calls loadFile', async () => {
    renderWithProviders();
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    const file = new File(['test'], 'project.sb3', { type: 'application/octet-stream' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
    await waitFor(() => {
      expect(loadFileMock).toHaveBeenCalledWith(file);
    });
  });

  it('selecting a file with a disallowed extension pushes an error and does not call loadFile', () => {
    renderWithProviders();
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    const file = new File(['test'], 'evil.exe', { type: 'application/octet-stream' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
    expect(loadFileMock).not.toHaveBeenCalled();
    const errors = useErrorLogStore.getState().entries.filter((e) => e.severity === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/not.*\.sb3/);
  });

  it('resets the file input value after each change so the same file can be re-selected', async () => {
    renderWithProviders();
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    const file = new File(['test'], 'project.sb3', { type: 'application/octet-stream' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
    await waitFor(() => {
      expect(loadFileMock).toHaveBeenCalled();
    });
    expect(input.value).toBe('');
  });
});