import { describe, expect, it, beforeEach } from 'vitest';
import {
  addSessionDeniedExtensionUrl,
  applyExtensionSecurityManager,
  createExtensionSecurityManager,
  removeSessionDeniedExtensionUrl,
  __resetSessionDeniedUrlsForTesting,
} from '@/runtime/extension-security';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';
import type { AdvancedSettings } from '@/types/settings';

const URL_A = 'https://example.com/a.js';
const URL_B = 'https://example.com/b.js';

function withOverrides(overrides: Partial<AdvancedSettings>): AdvancedSettings {
  return { ...DEFAULT_ADVANCED_SETTINGS, ...overrides };
}

describe('createExtensionSecurityManager', () => {
  beforeEach(() => {
    __resetSessionDeniedUrlsForTesting();
  });

  it('refuses unknown URLs by default', () => {
    const manager = createExtensionSecurityManager(
      () => DEFAULT_ADVANCED_SETTINGS,
      () => [],
    );
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(false);
  });

  it('allows URLs that are in the persistent allow-list', () => {
    const manager = createExtensionSecurityManager(
      () => DEFAULT_ADVANCED_SETTINGS,
      () => [URL_A],
    );
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(true);
    // Different URL still denied.
    expect(manager.canLoadExtensionFromProject(URL_B)).toBe(false);
  });

  it('re-checks the persistent allow-list on every call', () => {
    let allowList: readonly string[] = [];
    const manager = createExtensionSecurityManager(
      () => DEFAULT_ADVANCED_SETTINGS,
      () => allowList,
    );
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(false);
    allowList = [URL_A];
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(true);
    allowList = [];
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(false);
  });

  it('persistent allow-list wins over session-deny for previously-approved URLs', () => {
    const manager = createExtensionSecurityManager(
      () => DEFAULT_ADVANCED_SETTINGS,
      () => [URL_A],
    );
    // Even after a session-deny is recorded for the URL, the
    // persistent allow-list still wins. Rationale: the user explicitly
    // approved the URL once; one transient deny within a single page
    // load does not revoke that approval. To revoke a persistent
    // approval, the user clears the allow-list from Settings.
    addSessionDeniedExtensionUrl(URL_A);
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(true);
    // Removing the session deny is a no-op for this URL, but still
    // returns true because the deny was actually present.
    expect(removeSessionDeniedExtensionUrl(URL_A)).toBe(true);
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(true);
  });

  it('denies empty / whitespace-only URLs', () => {
    const manager = createExtensionSecurityManager(
      () => DEFAULT_ADVANCED_SETTINGS,
      () => [],
    );
    expect(manager.canLoadExtensionFromProject('')).toBe(false);
    expect(manager.canLoadExtensionFromProject('   ')).toBe(false);
  });

  it('trims whitespace before consulting the allow-list', () => {
    const manager = createExtensionSecurityManager(
      () => DEFAULT_ADVANCED_SETTINGS,
      () => [URL_A],
    );
    expect(manager.canLoadExtensionFromProject(`  ${URL_A}  `)).toBe(true);
  });

  it('reads the sandbox mode from the latest settings snapshot', () => {
    let settings = withOverrides({ extensionSandboxMode: 'iframe' });
    const manager = createExtensionSecurityManager(
      () => settings,
      () => [],
    );
    expect(manager.getSandboxMode(URL_A)).toBe('iframe');
    settings = withOverrides({ extensionSandboxMode: 'unsandboxed' });
    expect(manager.getSandboxMode(URL_A)).toBe('unsandboxed');
  });

  it('falls back to worker sandbox when the stored value is invalid', () => {
    const settings = {
      ...DEFAULT_ADVANCED_SETTINGS,
      extensionSandboxMode: 'nonsense' as unknown as 'worker',
    };
    const manager = createExtensionSecurityManager(
      () => settings,
      () => [],
    );
    expect(manager.getSandboxMode(URL_A)).toBe('worker');
  });

  it('returns the disabled sandbox mode when the user picked it', () => {
    const settings = withOverrides({ extensionSandboxMode: 'disabled' });
    const manager = createExtensionSecurityManager(() => settings, () => []);
    expect(manager.getSandboxMode(URL_A)).toBe('disabled');
  });

  it('denies every URL when sandbox mode is disabled (including allow-listed)', () => {
    const settings = withOverrides({ extensionSandboxMode: 'disabled' });
    const manager = createExtensionSecurityManager(() => settings, () => [URL_A, URL_B]);
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(false);
    expect(manager.canLoadExtensionFromProject(URL_B)).toBe(false);
    // Even URLs that were previously approved are denied: `disabled` is
    // the global kill-switch and overrides the persistent allow-list.
  });

  it('re-enables extensions when sandbox mode switches back from disabled', () => {
    let settings = withOverrides({ extensionSandboxMode: 'disabled' });
    const manager = createExtensionSecurityManager(() => settings, () => [URL_A]);
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(false);
    settings = withOverrides({ extensionSandboxMode: 'worker' });
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(true);
  });

  it('returns synchronous booleans (no Promise)', () => {
    const manager = createExtensionSecurityManager(
      () => DEFAULT_ADVANCED_SETTINGS,
      () => [URL_A],
    );
    // Upstream accepts both; ensure we don't accidentally always return a Promise.
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(true);
  });
});

describe('addSessionDeniedExtensionUrl', () => {
  beforeEach(() => {
    __resetSessionDeniedUrlsForTesting();
  });

  it('ignores empty / whitespace URLs', () => {
    const manager = createExtensionSecurityManager(
      () => DEFAULT_ADVANCED_SETTINGS,
      () => [],
    );
    addSessionDeniedExtensionUrl('');
    addSessionDeniedExtensionUrl('   ');
    expect(manager.canLoadExtensionFromProject(URL_A)).toBe(false);
  });
});

describe('applyExtensionSecurityManager', () => {
  beforeEach(() => {
    __resetSessionDeniedUrlsForTesting();
  });

  it('calls setExtensionSecurityManager with the manager object', () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeScaffolding = {
      setExtensionSecurityManager(manager: Record<string, unknown>) {
        calls.push(manager);
      },
    };
    applyExtensionSecurityManager(
      fakeScaffolding,
      () => withOverrides({ extensionSandboxMode: 'iframe' }),
      () => [URL_A],
    );
    expect(calls.length).toBe(1);
    const installed = calls[0];
    expect(typeof installed?.canLoadExtensionFromProject).toBe('function');
    expect(typeof installed?.getSandboxMode).toBe('function');
    if (typeof installed?.canLoadExtensionFromProject === 'function') {
      expect(installed.canLoadExtensionFromProject(URL_A)).toBe(true);
    }
    if (typeof installed?.getSandboxMode === 'function') {
      expect(installed.getSandboxMode('any-url')).toBe('iframe');
    }
  });

  it('can be called repeatedly to replace the previous manager', () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeScaffolding = {
      setExtensionSecurityManager(manager: Record<string, unknown>) {
        calls.push(manager);
      },
    };
    let allowList: readonly string[] = [URL_A];
    applyExtensionSecurityManager(
      fakeScaffolding,
      () => DEFAULT_ADVANCED_SETTINGS,
      () => allowList,
    );
    allowList = [];
    applyExtensionSecurityManager(
      fakeScaffolding,
      () => DEFAULT_ADVANCED_SETTINGS,
      () => allowList,
    );
    expect(calls.length).toBe(2);
    const second = calls[1];
    if (typeof second?.canLoadExtensionFromProject === 'function') {
      expect(second.canLoadExtensionFromProject(URL_A)).toBe(false);
    }
  });
});
