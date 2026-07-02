import { describe, expect, it, beforeEach } from 'vitest';
import {
  setupScratchAssetStore,
  resetScratchAssetStoreForTesting,
} from '@/runtime/asset-store';
import type {
  ScaffoldingInstance,
  ScratchStorageLike,
} from '@/runtime/scaffolding-types';

function makeScaffolding(storage: ScratchStorageLike | null): ScaffoldingInstance {
  return {
    width: 480,
    height: 360,
    resizeMode: 'preserve-ratio',
    editableLists: false,
    shouldConnectPeripherals: false,
    usePackagedRuntime: false,
    vm: {},
    renderer: {},
    storage,
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

describe('scratch asset store', () => {
  beforeEach(() => {
    resetScratchAssetStoreForTesting();
  });

  it('returns false when storage is missing', () => {
    expect(setupScratchAssetStore(makeScaffolding(null))).toBe(false);
  });

  it('returns false when addWebStore is missing', () => {
    const storage = { AssetType: { ImageVector: 1, ImageBitmap: 2, Sound: 3 } } as unknown as ScratchStorageLike;
    expect(setupScratchAssetStore(makeScaffolding(storage))).toBe(false);
  });

  it('returns false when AssetType entries are missing', () => {
    const storage = {
      AssetType: {},
      addWebStore: () => undefined,
    } as unknown as ScratchStorageLike;
    expect(setupScratchAssetStore(makeScaffolding(storage))).toBe(false);
  });

  it('registers web store with the correct asset URL pattern', () => {
    const calls: { types: unknown[]; fn: (a: { assetId: string; dataFormat: string }) => string }[] = [];
    const storage: ScratchStorageLike = {
      AssetType: { ImageVector: 'iv', ImageBitmap: 'ib', Sound: 's' },
      addWebStore(types, fn) {
        calls.push({ types, fn });
      },
    };
    const ok = setupScratchAssetStore(makeScaffolding(storage));
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.types).toEqual(['iv', 'ib', 's']);

    const url = calls[0]!.fn({ assetId: 'abc/123', dataFormat: 'svg' });
    expect(url).toBe(
      'https://assets.scratch.mit.edu/internalapi/asset/abc%2F123.svg/get/',
    );
  });

  it('is idempotent (does not register twice)', () => {
    let count = 0;
    const storage: ScratchStorageLike = {
      AssetType: { ImageVector: 1, ImageBitmap: 2, Sound: 3 },
      addWebStore() {
        count += 1;
      },
    };
    setupScratchAssetStore(makeScaffolding(storage));
    setupScratchAssetStore(makeScaffolding(storage));
    setupScratchAssetStore(makeScaffolding(storage));
    expect(count).toBe(1);
  });
});