import { describe, expect, it } from 'vitest';
import { buildPreSetupConfig } from '@/runtime/pre-setup';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

describe('pre-setup config builder', () => {
  it('forwards stage size and disables editor-only features', () => {
    const cfg = buildPreSetupConfig({
      ...DEFAULT_ADVANCED_SETTINGS,
      stageWidth: 800,
      stageHeight: 600,
    });
    expect(cfg.width).toBe(800);
    expect(cfg.height).toBe(600);
    expect(cfg.resizeMode).toBe('preserve-ratio');
    expect(cfg.editableLists).toBe(false);
    expect(cfg.shouldConnectPeripherals).toBe(false);
    expect(cfg.usePackagedRuntime).toBe(false);
  });
});
