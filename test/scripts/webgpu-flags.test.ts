/**
 * Unit test for the shared Chromium launch flags helper used by the
 * WebGPU browser verification harness.
 *
 * The helper is consumed by `scripts/verify-gpu-kernel.mjs`,
 * `scripts/bench-gpu-kernel-init.mjs`, and `scripts/chrome-devtools-mcp-verify.mjs`.
 * These tests pin the wire format so a regression in either the flag
 * array or the opt-out env var name is caught before the harness breaks
 * on CI.
 *
 * The test file mirrors the `test/scripts/*.test.ts` convention used by
 * other generator-script tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- webgpu-flags.mjs is JS without a sidecar .d.ts
import * as WebgpuFlags from '../../scripts/webgpu-flags.mjs';

const {
  WEBGPU_LAUNCH_FLAGS,
  getWebgpuLaunchOptions,
  isWebgpuOptedOut,
} = WebgpuFlags as unknown as {
  WEBGPU_LAUNCH_FLAGS: readonly string[];
  getWebgpuLaunchOptions: (overrides?: { headless?: boolean | 'new' }) => {
    headless: boolean | 'new';
    args: string[];
  };
  isWebgpuOptedOut: () => boolean;
};

describe('webgpu-flags', () => {
  const ORIGINAL_ENV = process.env.TURBOWASM_DISABLE_WEBGPU;

  beforeEach(() => {
    delete process.env.TURBOWASM_DISABLE_WEBGPU;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.TURBOWASM_DISABLE_WEBGPU;
    } else {
      process.env.TURBOWASM_DISABLE_WEBGPU = ORIGINAL_ENV;
    }
  });

  describe('WEBGPU_LAUNCH_FLAGS', () => {
    it('contains the four required Chromium WebGPU flags', () => {
      expect(WEBGPU_LAUNCH_FLAGS).toEqual([
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,WebGPU',
        '--use-vulkan=swiftshader',
        '--enable-webgpu-developer-features',
      ]);
    });

    it('is a non-empty readonly array of strings', () => {
      expect(Array.isArray(WEBGPU_LAUNCH_FLAGS)).toBe(true);
      expect(WEBGPU_LAUNCH_FLAGS.length).toBeGreaterThan(0);
      for (const flag of WEBGPU_LAUNCH_FLAGS) {
        expect(typeof flag).toBe('string');
        expect(flag.startsWith('--')).toBe(true);
      }
    });
  });

  describe('isWebgpuOptedOut', () => {
    it('returns false when the env var is unset', () => {
      delete process.env.TURBOWASM_DISABLE_WEBGPU;
      expect(isWebgpuOptedOut()).toBe(false);
    });

    it('returns false when the env var is "0"', () => {
      process.env.TURBOWASM_DISABLE_WEBGPU = '0';
      expect(isWebgpuOptedOut()).toBe(false);
    });

    it('returns true only when the env var is "1"', () => {
      process.env.TURBOWASM_DISABLE_WEBGPU = '1';
      expect(isWebgpuOptedOut()).toBe(true);
    });
  });

  describe('getWebgpuLaunchOptions', () => {
    it('attaches the WebGPU flag array by default', () => {
      const opts = getWebgpuLaunchOptions();
      expect(opts.headless).toBe(true);
      expect(opts.args).toEqual(expect.arrayContaining([...WEBGPU_LAUNCH_FLAGS]));
      expect(opts.args).toHaveLength(WEBGPU_LAUNCH_FLAGS.length);
    });

    it('emits an empty args array when the opt-out env var is set', () => {
      process.env.TURBOWASM_DISABLE_WEBGPU = '1';
      const opts = getWebgpuLaunchOptions();
      expect(opts.headless).toBe(true);
      expect(opts.args).toEqual([]);
    });

    it('respects the headless override', () => {
      const opts = getWebgpuLaunchOptions({ headless: 'new' });
      expect(opts.headless).toBe('new');
    });

    it('does not silently mutate the WEBGPU_LAUNCH_FLAGS constant', () => {
      const before = [...WEBGPU_LAUNCH_FLAGS];
      getWebgpuLaunchOptions();
      expect([...WEBGPU_LAUNCH_FLAGS]).toEqual(before);
    });
  });
});
