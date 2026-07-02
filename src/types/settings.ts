export type Theme = 'system' | 'dark' | 'light';

export type ScaffoldingResizeMode = 'preserve-ratio' | 'dynamic-resize' | 'stretch';

export interface AdvancedSettings {
  fps: number;
  interpolation: boolean;
  highQualityPen: boolean;
  warpTimer: boolean;
  infiniteClones: boolean;
  removeFencing: boolean;
  removeMiscLimits: boolean;
  turboMode: boolean;
  disableCompiler: boolean;
  stageWidth: number;
  stageHeight: number;
}

export interface UISettings {
  theme: Theme;
  volume: number;
  lastNonMuteVolume: number;
  advanced: AdvancedSettings;
}

export interface SettingsStoreShape {
  theme: Theme;
  volume: number;
  lastNonMuteVolume: number;
  advanced: AdvancedSettings;
}

export interface SettingsStoreSerialized {
  state: SettingsStoreShape;
  version: number;
}