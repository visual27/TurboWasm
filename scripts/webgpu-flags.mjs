#!/usr/bin/env node
/**
 * Shared Chromium launch flags for WebGPU-enabled browser verification
 * harnesses.
 *
 * The TurboWasm GPU compute kernel pipeline (M1-M7) requires a real
 * WebGPU adapter (`navigator.gpu.requestAdapter()` returns a non-null
 * `GPUAdapter`). Headless Chromium hides WebGPU behind two gates:
 *
 *   1. `--enable-unsafe-webgpu` — opts the build into the WebGPU
 *      JavaScript API surface (otherwise undefined in release builds).
 *   2. `--enable-features=Vulkan,WebGPU` — flips the runtime features
 *      on. Without these the API exists but `requestAdapter()` returns
 *      `null` even on machines with a real GPU.
 *
 * On hosts without a discrete GPU we still want the pipeline to drive
 * through M3-M5 (WGSL emission, registry write, dispatcher wiring) so
 * `--use-vulkan=swiftshader` provides a software Vulkan implementation
 * as the adapter's backing device. Performance is poor but pixel
 * correctness is identical to a hardware path, which is what
 * `verify-gpu-kernel.mjs` validates.
 *
 * `--enable-webgpu-developer-features` exposes the `chrome://gpu`
 * internals and `console.error` traces for adapter/device creation,
 * which the AGENTS.md "GPU Kernels (M7)" verification step relies on.
 *
 * `--no-sandbox` is appended by `getWebgpuLaunchOptions()` only when
 * the caller is root in CI containers. Local dev runs keep the sandbox
 * on so the rest of `chrome-devtools-mcp`'s threat model still holds.
 *
 * Usage:
 *   import { WEBGPU_LAUNCH_FLAGS, getWebgpuLaunchOptions } from './webgpu-flags.mjs';
 *   await chromium.launch(getWebgpuLaunchOptions());
 *   // or, to opt out for CI:
 *   await chromium.launch({ headless: true, args: WEBGPU_LAUNCH_FLAGS.filter(a => a !== '--enable-unsafe-webgpu') });
 */

export const WEBGPU_LAUNCH_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--use-vulkan=swiftshader',
  '--enable-webgpu-developer-features',
];

const WEBGPU_OPT_OUT_ENV = 'TURBOWASM_DISABLE_WEBGPU';

/**
 * Build a Playwright `chromium.launch(...)` options object with WebGPU
 * flags attached. Set `TURBOWASM_DISABLE_WEBGPU=1` to omit the flags
 * (used on CI runners where SwiftShader crashes or is unavailable —
 * the harness must still exit 0).
 *
 * @param {{ headless?: boolean | 'new' }} [overrides]
 * @returns {{ headless: boolean | 'new', args: string[] }}
 */
export function getWebgpuLaunchOptions(overrides = {}) {
  const disabled = process.env[WEBGPU_OPT_OUT_ENV] === '1';
  const args = disabled ? [] : [...WEBGPU_LAUNCH_FLAGS];
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot && !disabled && !args.includes('--no-sandbox')) args.push('--no-sandbox');
  return {
    headless: overrides.headless ?? true,
    args,
  };
}

/**
 * Returns `true` when the caller has explicitly opted out of WebGPU
 * via the `TURBOWASM_DISABLE_WEBGPU=1` env var. The MCP verify harness
 * records this in its `webgpu_state` scenario so the log shows why
 * the GPU pass ran with software stubs.
 *
 * @returns {boolean}
 */
export function isWebgpuOptedOut() {
  return process.env[WEBGPU_OPT_OUT_ENV] === '1';
}
