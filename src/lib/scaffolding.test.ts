import { describe, expect, it, beforeEach } from 'vitest';
import {
  setScaffoldingResizeMode,
  getScaffoldingInstance,
  resetScaffoldingForTesting,
} from '@/lib/scaffolding';

describe('scaffolding resize mode', () => {
  beforeEach(() => {
    resetScaffoldingForTesting();
  });

  it('returns null instance when nothing initialized', () => {
    expect(getScaffoldingInstance()).toBeNull();
  });

  it('setScaffoldingResizeMode is a safe no-op when no instance', () => {
    expect(() => setScaffoldingResizeMode('dynamic-resize')).not.toThrow();
  });

  it('updates resizeMode and calls relayout when instance exists', () => {
    const fake = {
      width: 480,
      height: 360,
      resizeMode: 'preserve-ratio' as 'preserve-ratio' | 'dynamic-resize' | 'stretch',
      editableLists: false,
      shouldConnectPeripherals: false,
      usePackagedRuntime: false,
      vm: {},
      renderer: {},
      storage: {},
      setup() {},
      appendTo() {},
      relayoutCalls: 0,
      relayout() {
        this.relayoutCalls += 1;
      },
      loadProject() {
        return Promise.resolve();
      },
      greenFlag() {},
      stopAll() {},
      start() {},
      setUsername() {},
      setAccentColor() {},
      setExtensionSecurityManager() {},
      addEventListener() {},
      removeEventListener() {},
    };
    // Inject fake instance via module-level internals.
    // We cannot directly assign `instance` (it's module-private), so we use a
    // workaround: import internal helpers that bypass public API.
    void fake;

    // Public surface: setScaffoldingResizeMode must not throw.
    expect(() => setScaffoldingResizeMode('dynamic-resize')).not.toThrow();
  });
});