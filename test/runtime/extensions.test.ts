import { describe, expect, it } from 'vitest';
import {
  addExtensionRegistrar,
  applyExtensions,
  listExtensionRegistrars,
} from '@/runtime/extensions';
import type { ExtensionRegistrar } from '@/runtime/extensions';
import type { ScaffoldingInstance } from '@/runtime/scaffolding-types';

function makeFakeScaffolding(): ScaffoldingInstance {
  return {
    width: 480,
    height: 360,
    resizeMode: 'preserve-ratio',
    editableLists: false,
    shouldConnectPeripherals: false,
    usePackagedRuntime: false,
    vm: {},
    renderer: {},
    storage: {},
    setup() {},
    appendTo() {},
    relayout() {},
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
}

describe('extension registrar interface', () => {
  it('starts with empty registrar list', () => {
    expect(listExtensionRegistrars().length).toBe(0);
  });

  it('applies registered extensions in order', () => {
    const calls: string[] = [];
    const regA: ExtensionRegistrar = {
      id: 'a',
      register() {
        calls.push('a');
      },
    };
    const regB: ExtensionRegistrar = {
      id: 'b',
      register() {
        calls.push('b');
      },
    };
    addExtensionRegistrar(regA);
    addExtensionRegistrar(regB);
    applyExtensions(makeFakeScaffolding());
    expect(calls).toEqual(['a', 'b']);
  });

  it('continues applying after a registrar throws', () => {
    const calls: string[] = [];
    addExtensionRegistrar({
      id: 'broken',
      register() {
        throw new Error('boom');
      },
    });
    addExtensionRegistrar({
      id: 'good',
      register() {
        calls.push('good');
      },
    });
    applyExtensions(makeFakeScaffolding());
    expect(calls).toEqual(['good']);
  });
});
