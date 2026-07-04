import type { ScaffoldingInstance, ScratchStorageLike } from '@/runtime/scaffolding-types';

let webStoreRegistered = false;

/**
 * Register Scratch's official asset CDN as the source for costume / sound
 * assets. Scaffolding does NOT do this for us (see Scaffolding README).
 *
 * Without this, projects loaded via Project ID will fail to fetch their
 * assets because scratch-storage has no URL resolver for them.
 *
 * Safe to call multiple times — the registration is idempotent.
 */
export function setupScratchAssetStore(scaffolding: ScaffoldingInstance): boolean {
  const storage = scaffolding.storage as ScratchStorageLike | null | undefined;
  if (!storage) return false;
  if (typeof storage.addWebStore !== 'function') return false;
  if (webStoreRegistered) return true;

  const { ImageVector, ImageBitmap, Sound } = storage.AssetType ?? {};
  const types = [ImageVector, ImageBitmap, Sound].filter((t) => t !== undefined);
  if (types.length === 0) return false;

  storage.addWebStore(types, (asset) => {
    const assetId = encodeURIComponent(asset.assetId);
    const dataFormat = encodeURIComponent(asset.dataFormat);
    return `https://assets.scratch.mit.edu/internalapi/asset/${assetId}.${dataFormat}/get/`;
  });

  webStoreRegistered = true;
  return true;
}

export function resetScratchAssetStoreForTesting(): void {
  webStoreRegistered = false;
}
