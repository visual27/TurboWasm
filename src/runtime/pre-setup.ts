import type { ScaffoldingResizeMode, AdvancedSettings } from '@/types/settings';

export interface ScaffoldingPreSetupConfig {
  width: number;
  height: number;
  resizeMode: ScaffoldingResizeMode;
  editableLists: boolean;
  shouldConnectPeripherals: boolean;
  usePackagedRuntime: boolean;
}

export function buildPreSetupConfig(advanced: AdvancedSettings): ScaffoldingPreSetupConfig {
  return {
    width: advanced.stageWidth,
    height: advanced.stageHeight,
    resizeMode: 'preserve-ratio',
    editableLists: false,
    shouldConnectPeripherals: false,
    usePackagedRuntime: false,
  };
}
