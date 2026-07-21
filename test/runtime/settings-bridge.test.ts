import { describe, expect, it, vi } from 'vitest';
import {
  applyAdvancedSettings,
  asRenderer,
  asVm,
  type ScaffoldingVmLike,
} from '@/runtime/settings-bridge';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

function makeVm(overrides: Partial<ScaffoldingVmLike> = {}): {
  vm: ScaffoldingVmLike;
  setFramerate: ReturnType<typeof vi.fn>;
  setInterpolation: ReturnType<typeof vi.fn>;
  setCompilerOptions: ReturnType<typeof vi.fn>;
  setRuntimeOptions: ReturnType<typeof vi.fn>;
  setTurboMode: ReturnType<typeof vi.fn>;
} {
  const setFramerate = vi.fn();
  const setInterpolation = vi.fn();
  const setCompilerOptions = vi.fn();
  const setRuntimeOptions = vi.fn();
  const setTurboMode = vi.fn();
  const vm: ScaffoldingVmLike = {
    setTurboMode,
    setStageSize: vi.fn(),
    setInterpolation,
    on: vi.fn(),
    runtime: {
      setCompilerOptions,
      setRuntimeOptions,
      frameLoop: { setFramerate, setInterpolation: vi.fn() },
    },
    ...overrides,
  };
  return { vm, setFramerate, setInterpolation, setCompilerOptions, setRuntimeOptions, setTurboMode };
}

function makeScaffolding(vm: ScaffoldingVmLike, renderer?: { setUseHighQualityRender: ReturnType<typeof vi.fn> }) {
  return {
    vm,
    renderer,
  } as unknown as Parameters<typeof applyAdvancedSettings>[0];
}

describe('asVm / asRenderer: null guards', () => {
  it('asVm throws when scaffolding.vm is missing', () => {
    expect(() => asVm(undefined)).toThrow('Scaffolding.vm is not available');
    expect(() => asVm(null)).toThrow('Scaffolding.vm is not available');
    expect(() => asVm('not-an-object')).toThrow('Scaffolding.vm is not available');
  });

  it('asRenderer throws when the renderer is missing', () => {
    expect(() => asRenderer(undefined)).toThrow('Scaffolding.renderer is not available');
    expect(() => asRenderer(null)).toThrow('Scaffolding.renderer is not available');
    expect(() => asRenderer(42)).toThrow('Scaffolding.renderer is not available');
  });
});

describe('applyAdvancedSettings: VM API mapping', () => {
  it('forwards framerate and interpolation to vm APIs', () => {
    const { vm, setFramerate, setInterpolation } = makeVm();
    applyAdvancedSettings(makeScaffolding(vm), { ...DEFAULT_ADVANCED_SETTINGS, fps: 60, interpolation: true });
    expect(setFramerate).toHaveBeenCalledExactlyOnceWith(60);
    expect(setInterpolation).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('uses vm.setInterpolation when present (avoids double _restart)', () => {
    const { vm, setInterpolation } = makeVm();
    applyAdvancedSettings(makeScaffolding(vm), DEFAULT_ADVANCED_SETTINGS);
    expect(setInterpolation).toHaveBeenCalledExactlyOnceWith(false);
    expect(vm.runtime.frameLoop.setInterpolation).not.toHaveBeenCalled();
  });

  it('omits the interpolation call when the VM lacks setInterpolation', () => {
    const setFramerate = vi.fn();
    const setCompilerOptions = vi.fn();
    const setRuntimeOptions = vi.fn();
    const setTurboMode = vi.fn();
    const vm = {
      setTurboMode,
      setStageSize: vi.fn(),
      on: vi.fn(),
      runtime: {
        setCompilerOptions,
        setRuntimeOptions,
        frameLoop: { setFramerate, setInterpolation: vi.fn() },
      },
    } as unknown as ScaffoldingVmLike;
    applyAdvancedSettings(makeScaffolding(vm), DEFAULT_ADVANCED_SETTINGS);
    expect(setFramerate).toHaveBeenCalledExactlyOnceWith(DEFAULT_ADVANCED_SETTINGS.fps);
  });

  it('inverts disableCompiler when calling setCompilerOptions', () => {
    const { vm, setCompilerOptions } = makeVm();
    applyAdvancedSettings(makeScaffolding(vm), { ...DEFAULT_ADVANCED_SETTINGS, disableCompiler: true, warpTimer: true });
    expect(setCompilerOptions).toHaveBeenCalledExactlyOnceWith({ enabled: false, warpTimer: true });
  });

  it('inverts removeMiscLimits / removeFencing and maps infiniteClones', () => {
    const { vm, setRuntimeOptions } = makeVm();
    applyAdvancedSettings(makeScaffolding(vm), {
      ...DEFAULT_ADVANCED_SETTINGS,
      removeMiscLimits: true,
      removeFencing: true,
      infiniteClones: true,
    });
    expect(setRuntimeOptions).toHaveBeenCalledExactlyOnceWith({
      miscLimits: false,
      fencing: false,
      maxClones: Infinity,
    });
  });

  it('clamps infiniteClones=false to 300 (the default)', () => {
    const { vm, setRuntimeOptions } = makeVm();
    applyAdvancedSettings(makeScaffolding(vm), DEFAULT_ADVANCED_SETTINGS);
    expect(setRuntimeOptions).toHaveBeenCalledExactlyOnceWith({
      miscLimits: true,
      fencing: true,
      maxClones: 300,
    });
  });

  it('forwards turboMode to vm.setTurboMode', () => {
    const { vm, setTurboMode } = makeVm();
    applyAdvancedSettings(makeScaffolding(vm), { ...DEFAULT_ADVANCED_SETTINGS, turboMode: true });
    expect(setTurboMode).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('forwards highQualityPen to renderer.setUseHighQualityRender when present', () => {
    const { vm } = makeVm();
    const setUseHighQualityRender = vi.fn();
    applyAdvancedSettings(makeScaffolding(vm, { setUseHighQualityRender }), {
      ...DEFAULT_ADVANCED_SETTINGS,
      highQualityPen: true,
    });
    expect(setUseHighQualityRender).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('skips renderer wiring when no renderer is present', () => {
    const { vm, setFramerate, setCompilerOptions, setRuntimeOptions, setTurboMode, setInterpolation } = makeVm();
    applyAdvancedSettings(makeScaffolding(vm), DEFAULT_ADVANCED_SETTINGS);
    expect(setFramerate).toHaveBeenCalledTimes(1);
    expect(setInterpolation).toHaveBeenCalledTimes(1);
    expect(setCompilerOptions).toHaveBeenCalledTimes(1);
    expect(setRuntimeOptions).toHaveBeenCalledTimes(1);
    expect(setTurboMode).toHaveBeenCalledTimes(1);
  });

  it('skips renderer wiring when renderer lacks setUseHighQualityRender', () => {
    const { vm } = makeVm();
    const renderer: { setUseHighQualityRender?: ReturnType<typeof vi.fn>; unrelated?: ReturnType<typeof vi.fn> } = {
      unrelated: vi.fn(),
    };
    applyAdvancedSettings(makeScaffolding(vm, renderer as unknown as { setUseHighQualityRender: ReturnType<typeof vi.fn> }), DEFAULT_ADVANCED_SETTINGS);
    expect(renderer.unrelated).not.toHaveBeenCalled();
  });

  it('preserves call ordering: framerate -> interpolation -> renderer -> compiler -> runtime -> turbo', () => {
    const order: string[] = [];
    const setFramerate = vi.fn(() => order.push('framerate'));
    const setInterpolation = vi.fn(() => order.push('interpolation'));
    const setCompilerOptions = vi.fn(() => order.push('compiler'));
    const setRuntimeOptions = vi.fn(() => order.push('runtime'));
    const setTurboMode = vi.fn(() => order.push('turbo'));
    const setUseHighQualityRender = vi.fn(() => order.push('renderer'));
    const vm: ScaffoldingVmLike = {
      setTurboMode,
      setStageSize: vi.fn(),
      setInterpolation,
      on: vi.fn(),
      runtime: {
        setCompilerOptions,
        setRuntimeOptions,
        frameLoop: { setFramerate, setInterpolation: vi.fn() },
      },
    };
    applyAdvancedSettings(makeScaffolding(vm, { setUseHighQualityRender }), DEFAULT_ADVANCED_SETTINGS);
    expect(order).toEqual([
      'framerate',
      'interpolation',
      'renderer',
      'compiler',
      'runtime',
      'turbo',
    ]);
  });
});
