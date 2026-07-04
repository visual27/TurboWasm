import * as ScaffoldingModule from '@turbowarp/scaffolding';

export type ScaffoldingInstance = {
  width: number;
  height: number;
  resizeMode: 'preserve-ratio' | 'dynamic-resize' | 'stretch';
  editableLists: boolean;
  shouldConnectPeripherals: boolean;
  usePackagedRuntime: boolean;
  vm: unknown;
  renderer: unknown;
  storage: unknown;
  audioEngine?: unknown;
  cloudManager?: unknown;
  setup(): void;
  appendTo(element: HTMLElement): void;
  relayout(): void;
  loadProject(data: ArrayBuffer | Uint8Array): Promise<void>;
  greenFlag(): void;
  stopAll(): void;
  start(): void;
  setUsername(username: string): void;
  setAccentColor(color: string): void;
  setExtensionSecurityManager(manager: Record<string, unknown>): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};

export interface ScaffoldingNamespace {
  Scaffolding: new () => ScaffoldingInstance;
}

export function loadScaffoldingConstructor(): new () => ScaffoldingInstance {
  const ns = ScaffoldingModule as unknown as ScaffoldingNamespace;
  if (!ns || typeof ns.Scaffolding !== 'function') {
    throw new Error('@turbowarp/scaffolding: Scaffolding constructor not found');
  }
  return ns.Scaffolding;
}

/**
 * Minimal scratch-storage surface used by this app. Scaffolding exposes the
 * Storage instance via `scaffolding.storage`. We only need the bits required
 * to register the scratch.mit.edu asset CDN as a fetch source.
 */
export interface ScratchStorageLike {
  AssetType: {
    ImageVector: unknown;
    ImageBitmap: unknown;
    Sound: unknown;
  };
  addWebStore(
    types: unknown[],
    urlFunction: (asset: { assetId: string; dataFormat: string }) => string,
  ): void;
}

export interface ScratchAsset {
  assetId: string;
  dataFormat: string;
}
