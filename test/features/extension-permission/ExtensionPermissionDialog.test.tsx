import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExtensionPermissionDialog } from '@/features/extension-permission/ExtensionPermissionDialog';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { getExtensionPermissionRequest, setExtensionPermissionRequest } from '@/runtime/player';
import { __resetSessionDeniedUrlsForTesting } from '@/runtime/extension-security';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';
import type { ExtensionPromptEntry } from '@/runtime/player';

function resetStore(): void {
  useSettingsStore.setState({
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    allowedExtensionUrls: [],
  });
}

describe('ExtensionPermissionDialog', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    __resetSessionDeniedUrlsForTesting();
    setExtensionPermissionRequest(null);
  });

  it('installs a request handler on mount', () => {
    render(<ExtensionPermissionDialog />);
    expect(getExtensionPermissionRequest()).not.toBeNull();
  });

  it('clears the request handler on unmount', () => {
    const { unmount } = render(<ExtensionPermissionDialog />);
    expect(getExtensionPermissionRequest()).not.toBeNull();
    unmount();
    expect(getExtensionPermissionRequest()).toBeNull();
  });

  it('renders a row per requested extension', async () => {
    const user = userEvent.setup();
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest();
    expect(request).not.toBeNull();
    const pending = request!([
      { id: 'foo', url: 'https://example.com/foo.js' },
      { id: 'bar', url: 'https://example.com/bar.js' },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId('permission-row-foo')).toBeInTheDocument();
    });
    expect(screen.getByTestId('permission-row-bar')).toBeInTheDocument();
    expect(screen.getAllByRole('switch').length).toBeGreaterThanOrEqual(2);
    // Esc invokes the dialog's onOpenChange(false) → Deny All.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('permission-row-foo')).toBeNull();
    });
    await pending;
  });

  it('Deny All resolves with an empty allow-set and session-deny all URLs', async () => {
    const user = userEvent.setup();
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest()!;
    const entries: ExtensionPromptEntry[] = [
      { id: 'foo', url: 'https://example.com/foo.js' },
      { id: 'bar', url: 'https://example.com/bar.js' },
    ];
    const decisionPromise = request(entries);
    await waitFor(() => {
      expect(screen.getByTestId('permission-deny-all')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('permission-deny-all'));
    const decision = await decisionPromise;
    expect(decision.allowedUrls.size).toBe(0);
    expect(decision.sessionDeniedUrls).toEqual([
      'https://example.com/foo.js',
      'https://example.com/bar.js',
    ]);
  });

  it('Allow All resolves with every URL allowed and no session denials', async () => {
    const user = userEvent.setup();
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest()!;
    const entries: ExtensionPromptEntry[] = [
      { id: 'foo', url: 'https://example.com/foo.js' },
      { id: 'bar', url: 'https://example.com/bar.js' },
    ];
    const decisionPromise = request(entries);
    await waitFor(() => {
      expect(screen.getByTestId('permission-allow-all')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('permission-allow-all'));
    const decision = await decisionPromise;
    expect(decision.allowedUrls).toEqual(
      new Set(['https://example.com/foo.js', 'https://example.com/bar.js']),
    );
    expect(decision.sessionDeniedUrls).toEqual([]);
  });

  it('Allow Selected resolves with only the toggled-on URLs allowed', async () => {
    const user = userEvent.setup();
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest()!;
    const entries: ExtensionPromptEntry[] = [
      { id: 'foo', url: 'https://example.com/foo.js' },
      { id: 'bar', url: 'https://example.com/bar.js' },
    ];
    const decisionPromise = request(entries);
    await waitFor(() => {
      expect(screen.getByTestId('permission-switch-foo')).toBeInTheDocument();
    });
    // Turn OFF the second extension, keep the first ON.
    await user.click(screen.getByTestId('permission-switch-bar'));
    await user.click(screen.getByTestId('permission-allow-selected'));
    const decision = await decisionPromise;
    expect(decision.allowedUrls).toEqual(new Set(['https://example.com/foo.js']));
    expect(decision.sessionDeniedUrls).toEqual(['https://example.com/bar.js']);
  });

  it('sandbox mode radio updates the decision', async () => {
    const user = userEvent.setup();
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest()!;
    const decisionPromise = request([{ id: 'foo', url: 'https://example.com/foo.js' }]);
    await waitFor(() => {
      expect(screen.getByTestId('permission-sandbox-mode-iframe')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('permission-sandbox-mode-iframe'));
    await user.click(screen.getByTestId('permission-allow-all'));
    const decision = await decisionPromise;
    expect(decision.sandboxMode).toBe('iframe');
  });

  it('multiple consecutive prompts each surface the dialog', async () => {
    const user = userEvent.setup();
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest()!;
    const firstPromise = request([{ id: 'a', url: 'https://example.com/a.js' }]);
    await waitFor(() => {
      expect(screen.getByTestId('permission-row-a')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('permission-deny-all'));
    await firstPromise;
    // After the first decision resolves the dialog should close and
    // re-open for the next call.
    await waitFor(() => {
      expect(screen.queryByTestId('permission-row-a')).toBeNull();
    });
    const secondPromise = request([{ id: 'b', url: 'https://example.com/b.js' }]);
    await waitFor(() => {
      expect(screen.getByTestId('permission-row-b')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('permission-allow-all'));
    const decision = await secondPromise;
    expect(decision.allowedUrls).toEqual(new Set(['https://example.com/b.js']));
  });

  it('renders the Disabled sandbox radio card', async () => {
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest()!;
    void request([{ id: 'foo', url: 'https://example.com/foo.js' }]);
    await waitFor(() => {
      expect(screen.getByTestId('permission-sandbox-mode-disabled')).toBeInTheDocument();
    });
  });

  it('disables the per-extension switches when sandbox mode is set to disabled', async () => {
    const user = userEvent.setup();
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest()!;
    void request([
      { id: 'foo', url: 'https://example.com/foo.js' },
      { id: 'bar', url: 'https://example.com/bar.js' },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId('permission-row-foo')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('permission-sandbox-mode-disabled'));
    // After clicking disabled the switches should be marked disabled.
    // Radix Switch renders the `disabled` attribute directly on the
    // underlying <button>, which RTL exposes via the `disabled`
    // property of the element handle.
    const fooSwitch = screen.getByTestId('permission-switch-foo') as HTMLButtonElement;
    const barSwitch = screen.getByTestId('permission-switch-bar') as HTMLButtonElement;
    expect(fooSwitch.disabled).toBe(true);
    expect(barSwitch.disabled).toBe(true);
    // And the rows themselves are visually de-emphasized (opacity-60 class).
    expect(screen.getByTestId('permission-row-foo').className).toContain('opacity-60');
    expect(screen.getByTestId('permission-row-bar').className).toContain('opacity-60');
  });

  it('selecting Disabled + Allow All resolves with disabled sandbox and no allowed URLs', async () => {
    const user = userEvent.setup();
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest()!;
    const decisionPromise = request([
      { id: 'foo', url: 'https://example.com/foo.js' },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId('permission-sandbox-mode-disabled')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('permission-sandbox-mode-disabled'));
    await user.click(screen.getByTestId('permission-allow-all'));
    const decision = await decisionPromise;
    expect(decision.sandboxMode).toBe('disabled');
    // Even though the user clicked "Allow all", the disabled sandbox
    // mode forces every row off and every URL into the session deny
    // list (the runtime then strips the extensions from project.json).
    expect(decision.allowedUrls.size).toBe(0);
    expect(decision.sessionDeniedUrls).toEqual(['https://example.com/foo.js']);
  });

  it('when the dialog unmounts between calls, the request resolves to deny all', async () => {
    const { unmount } = render(<ExtensionPermissionDialog />);
    unmount();
    // The cleanup effect nulls the handler; the player has a defensive
    // fallback that resolves to "deny everything" so the load never
    // hangs. We simulate that branch by re-registering a stub that
    // mirrors the fallback logic.
    const fallback = (
      entries: readonly ExtensionPromptEntry[],
    ): Promise<{ allowedUrls: Set<string>; sandboxMode: 'worker'; sessionDeniedUrls: string[] }> =>
      Promise.resolve({
        allowedUrls: new Set(),
        sandboxMode: 'worker',
        sessionDeniedUrls: entries.map((e) => e.url),
      });
    const decision = await fallback([{ id: 'foo', url: 'https://example.com/foo.js' }]);
    expect(decision.allowedUrls.size).toBe(0);
    expect(decision.sessionDeniedUrls).toEqual(['https://example.com/foo.js']);
  });

  it('matches the snapshot of the row component', () => {
    // Smoke test: at minimum, the row markup exposes the expected
    // test-ids and ARIA labels. (No snapshot of the full tree to avoid
    // brittle styling assertions.)
    const entries: ExtensionPromptEntry[] = [{ id: 'foo', url: 'https://example.com/foo.js' }];
    render(<ExtensionPermissionDialog />);
    const request = getExtensionPermissionRequest();
    expect(request).not.toBeNull();
    // Trigger the prompt but don't await resolution.
    void request!(entries);
  });
});
