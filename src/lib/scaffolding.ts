import type { ScaffoldingInstance } from '@/runtime/scaffolding-types';

let instance: ScaffoldingInstance | null = null;
let setupDone = false;
let appendToContainer: HTMLElement | null = null;
let ctorPromise: Promise<new () => ScaffoldingInstance> | null = null;

export interface ConfigureScaffoldingArgs {
  width: number;
  height: number;
}

async function loadCtor(): Promise<new () => ScaffoldingInstance> {
  if (ctorPromise) return ctorPromise;
  ctorPromise = (async () => {
    // The Scaffolding package ships a UMD bundle. Under Vite (and esbuild's
    // CJS-to-ESM conversion) the bundle's `module.exports = factory()` becomes
    // the module's `default` export, with no automatic named-export
    // promotion. We therefore have to look in two places:
    //   1. `mod.Scaffolding` — when the loader emits named exports directly
    //   2. `mod.default.Scaffolding` — when the module is the CJS default
    //      wrapper around the UMD factory result
    const mod = (await import('@turbowarp/scaffolding')) as unknown as {
      Scaffolding?: new () => ScaffoldingInstance;
      default?: { Scaffolding?: new () => ScaffoldingInstance };
    };
    const Ctor = mod.Scaffolding || mod.default?.Scaffolding;
    if (!Ctor) {
      throw new Error('@turbowarp/scaffolding: Scaffolding constructor not found');
    }
    return Ctor;
  })();
  return ctorPromise;
}

export async function getScaffolding(args: ConfigureScaffoldingArgs): Promise<ScaffoldingInstance> {
  if (instance) return instance;
  const Ctor = await loadCtor();
  instance = new Ctor();
  instance.width = args.width;
  instance.height = args.height;
  return instance;
}

export async function ensureSetup(): Promise<ScaffoldingInstance> {
  if (!instance) {
    throw new Error('Scaffolding instance not created');
  }
  if (!setupDone) {
    instance.setup();
    setupDone = true;
  }
  return instance;
}

export async function appendScaffoldingTo(container: HTMLElement): Promise<ScaffoldingInstance> {
  const sc = await ensureSetup();
  if (appendToContainer !== container) {
    sc.appendTo(container);
    appendToContainer = container;
  }
  return sc;
}

export interface PreSetupConfigInput {
  width: number;
  height: number;
  resizeMode: 'preserve-ratio' | 'dynamic-resize' | 'stretch';
  editableLists: boolean;
  shouldConnectPeripherals: boolean;
  usePackagedRuntime: boolean;
}

export function applyPreSetupConfig(config: PreSetupConfigInput): void {
  if (!instance) return;
  instance.width = config.width;
  instance.height = config.height;
  instance.resizeMode = config.resizeMode;
  instance.editableLists = config.editableLists;
  instance.shouldConnectPeripherals = config.shouldConnectPeripherals;
  instance.usePackagedRuntime = config.usePackagedRuntime;
}

export function getScaffoldingInstance(): ScaffoldingInstance | null {
  return instance;
}

export function setScaffoldingResizeMode(
  mode: 'preserve-ratio' | 'dynamic-resize' | 'stretch',
): void {
  if (!instance) return;
  instance.resizeMode = mode;
  instance.relayout();
}

export function relayoutScaffolding(): void {
  if (!instance) return;
  instance.relayout();
}

export function resetScaffoldingForTesting(): void {
  instance = null;
  setupDone = false;
  appendToContainer = null;
}
