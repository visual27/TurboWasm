/**
 * Type definitions shared with `apply-gpu-kernels.ts`.
 *
 * We split this from the implementation module so callers can declare
 * `ApplyGpuKernelsOptions` without pulling the runtime bridge code
 * into their bundle.
 */

import type { Kernel, KernelRegistry } from './kernel-registry';
import type { ListBufferPool } from './list-buffer-binding';
import type { GpuLikeDispatchDevice, RuntimeAdapter } from './__dispatch-kernel-sync';

export interface ApplyGpuKernelsOptions {
  enabled: boolean;
  enableWasm: boolean;
  registry: KernelRegistry;
  pool: ListBufferPool;
  device: GpuLikeDispatchDevice | null;
  /**
   * Pre-built pipeline cache. Production passes a long-lived
   * `Map<canonicalKey, GPipeline>` so kernel pipelines survive across
   * dispatches within the same project. Tests inject an empty map.
   */
  pipelines?: Map<string, unknown>;
  /**
   * Runtime adapter the dispatcher uses to read/write host lists and
   * scalars. Production wires this to the vendored runtime's
   * `__getListBuffer` / `__setListBuffer` hooks. Tests inject stubs.
   */
  runtime?: RuntimeAdapter;
}

export interface ApplyGpuKernelsResult {
  installed: boolean;
  reason?: string;
}

export type LookupFn = (blockId: string) => Kernel | undefined;
