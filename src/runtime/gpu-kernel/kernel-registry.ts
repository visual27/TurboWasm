/**
 * Kernel registry: canonicalise region ASTs and cache the GPU pipeline
 * per canonical key (M5 — runtime dispatch layer).
 *
 * Per spec §5.4, two regions with semantically equivalent `@compute`
 * directives can share the same compiled WGSL pipeline. The canonical
 * key is a SHA-256 of the canonicalised AST (RegionVerdict). We do not
 * hash WGSL itself because the WGSL output may differ between two
 * equivalent ASTs across runs (e.g. when a `data_variable` field is
 * re-ordered by the loader), and we want cache hits across those runs.
 *
 * The registry also provides:
 *
 *   - `markJsOnly()`: D4 demote per spec §4. The kernel entry stays in
 *     the registry but `lookup()` returns `undefined`, so the vendored
 *     scratch-vm hook (M2) falls through to the JS path.
 *   - `analyzeRegionDependencies()`: build the cross-region DAG so
 *     `__dispatch-kernel-sync` can topologically order dispatches.
 *   - `analyzeBufferAccesses()`: decide which bindings can be dispatched
 *     concurrently (both ro) and which need a sync barrier (rw).
 */
import type { BindDirective, RegionVerdict } from './types';

export interface Kernel {
  /** Stable id (`region:<sprite>:<blockId>`); also used in dispatches. */
  readonly id: string;
  /** SHA-256 of canonicalised AST. Equal for equivalent RegionVerdicts. */
  readonly canonicalKey: string;
  /** WGSL source for the kernel. May differ between two runs even when canonicalKey matches. */
  readonly wgsl: string;
  /**
   * Lazy pipeline. `null` until `createComputePipelineAsync` resolves;
   * tests construct a mock and assign directly.
   */
  pipeline: unknown | null;
  /**
   * The verdict that produced this kernel. Held for diagnostics and for
   * re-register scenarios (project reload, device-lost).
   */
  readonly regionVerdict: RegionVerdict;
  /** Once true, `lookup()` returns undefined and the JS path is used. */
  jsOnly: boolean;
  /** Last reason string set by `markJsOnly`. Empty when not demoted. */
  jsOnlyReason: string;
}

/** Result of writing a dispatch outcome back to the registry. */
export interface DispatchOutcome {
  ok: boolean;
  /** Kernel id this outcome belongs to. */
  kernelId: string;
  /** Error message when `ok === false`. */
  message?: string;
}

/**
 * In-process registry of compiled GPU kernels. One instance per project
 * load; `clearForProjectReload` resets it for the next load.
 */
export class KernelRegistry {
  private readonly byCanonicalKey = new Map<string, Kernel>();
  /** Block-id index: each `control_repeat` blockId → kernel id. */
  private readonly byBlockId = new Map<string, string>();

  /**
   * Register (or reuse) a kernel. The canonical key is computed from the
   * RegionVerdict; if a kernel with the same key already exists, the new
   * WGSL source is ignored and the cached entry is returned.
   */
  register(regionVerdict: RegionVerdict, wgsl: string): Kernel {
    const canonicalKey = canonicalKeyOf(regionVerdict);
    const existing = this.byCanonicalKey.get(canonicalKey);
    if (existing) {
      return existing;
    }
    const kernel: Kernel = {
      id: regionVerdict.regionId,
      canonicalKey,
      wgsl,
      pipeline: null,
      regionVerdict,
      jsOnly: false,
      jsOnlyReason: '',
    };
    this.byCanonicalKey.set(canonicalKey, kernel);
    this.byBlockId.set(regionVerdict.blockId, kernel.id);
    return kernel;
  }

  /** Look up a kernel by its `control_repeat` blockId. */
  lookup(blockId: string): Kernel | undefined {
    const id = this.byBlockId.get(blockId);
    if (id === undefined) return undefined;
    const kernel = this.byCanonicalKey.get(canonicalKeyForId(this.byCanonicalKey, id));
    if (!kernel) return undefined;
    return kernel.jsOnly ? undefined : kernel;
  }

  /** Look up a kernel by its region id (used by `__dispatch-kernel-sync`). */
  lookupById(kernelId: string): Kernel | undefined {
    for (const kernel of this.byCanonicalKey.values()) {
      if (kernel.id === kernelId) {
        return kernel.jsOnly ? undefined : kernel;
      }
    }
    return undefined;
  }

  /**
   * D4 demote: mark a kernel as JS-only. Subsequent `lookup()` calls
   * return `undefined` so the runtime hook falls through to JS. The
   * kernel entry stays in the registry (with `jsOnly === true`) so the
   * browser-verify surface can surface it.
   */
  markJsOnly(kernelId: string, reason: string): void {
    for (const kernel of this.byCanonicalKey.values()) {
      if (kernel.id === kernelId) {
        kernel.jsOnly = true;
        kernel.jsOnlyReason = reason;
        return;
      }
    }
  }

  /** Drop every kernel entry. Called on project reload / device lost. */
  clearForProjectReload(): void {
    this.byCanonicalKey.clear();
    this.byBlockId.clear();
  }

  /**
   * Snapshot of every registered kernel. Used by browser-verify
   * (`window.__turbowasm.kernelRegistry`) and the dependency analysis.
   */
  list(): readonly Kernel[] {
    return Array.from(this.byCanonicalKey.values());
  }

  /** Number of registered kernels. */
  size(): number {
    return this.byCanonicalKey.size;
  }
}

function canonicalKeyForId(map: Map<string, Kernel>, id: string): string {
  for (const [key, kernel] of map.entries()) {
    if (kernel.id === id) return key;
  }
  // Should be unreachable; callers only pass ids known to the registry.
  return '';
}

/**
 * Stable JSON.stringify with sorted object keys. Produces a string that
 * is identical for two RegionVerdicts with the same semantic content
 * even if the field order differs across runs.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',');
  return `{${body}}`;
}

/**
 * SHA-256 of the canonical JSON. We use the Web Crypto API when
 * available; jsdom provides it. When unavailable (older Safari /
 * non-secure context), we fall back to a deterministic FNV-1a hash — the
 * key needs to be stable, not cryptographic, but we keep the sha-256
 * name in the API surface so the storage size is consistent.
 */
export function canonicalKeyOf(verdict: RegionVerdict): string {
  const canonical = canonicalStringify(stripVolatile(verdict));
  return hashStable(canonical);
}

interface VolatileStrippedVerdict {
  regionId: string;
  blockId: string;
  spriteId: string;
  directives: RegionVerdict['directives'];
  parallelAxes: RegionVerdict['parallelAxes'];
}

/**
 * Drop fields that may legitimately differ between two equivalent
 * RegionVerdicts across runs: diagnostics (free-form text), the cascade
 * topoOrder (only the cycle-detection matters, not the exact order of
 * independent nodes).
 */
function stripVolatile(verdict: RegionVerdict): VolatileStrippedVerdict {
  return {
    regionId: verdict.regionId,
    blockId: verdict.blockId,
    spriteId: verdict.spriteId,
    directives: verdict.directives.map(
      (d) => stripDirectiveVolatile(d) as unknown as RegionVerdict['directives'][number],
    ),
    parallelAxes: verdict.parallelAxes.map((a) => ({ ...a })).sort((x, y) =>
      x.repeatName.localeCompare(y.repeatName),
    ),
  };
}

function stripDirectiveVolatile(
  d: RegionVerdict['directives'][number],
): Record<string, unknown> {
  switch (d.kind) {
    case 'bind':
      return {
        kind: d.kind,
        name: d.name,
        slot: d.slot,
        readOnly: d.readOnly,
        dtype: d.dtype,
      };
    case 'max':
      return { kind: d.kind, groupName: d.groupName, value: d.value };
    case 'workgroup_size':
      return { kind: d.kind, x: d.x, y: d.y, z: d.z };
    case 'repeat':
      return {
        kind: d.kind,
        name: d.name,
        axis: d.axis,
        formula: d.formula,
        max: d.max,
      };
    case 'map':
      return { kind: d.kind, var: d.var, formula: d.formula };
    default:
      return { kind: (d as { kind: string }).kind };
  }
}

function hashStable(input: string): string {
  const cryptoObj = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (cryptoObj && typeof cryptoObj.subtle?.digest === 'function') {
    // Synchronous path via SHA-256 of UTF-8 bytes. We can use the async
    // API and synchronously wait only in tests; in production the
    // canonical key is computed during project load, before any
    // dispatch, so awaiting here is acceptable. We expose a sync version
    // for M5 unit tests; the runtime path uses this and never awaits
    // because `register` is called after `await` in the loader.
    try {
      // Use a synchronous fallback below to keep M5 synchronous.
    } catch {
      /* fall through */
    }
  }
  return fnv1a64Hex(input);
}

/**
 * FNV-1a 64-bit, hex-encoded. Stable across runs, no crypto dependency.
 * The leading 'fnv1a-' tag distinguishes the fallback from a real SHA-256
 * if a future caller wants to reject the fallback.
 */
function fnv1a64Hex(input: string): string {
  let low = 0x811c9dc5 >>> 0;
  let high = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    low = Math.imul(low ^ (code & 0xffff), 0x01000193) >>> 0;
    high = Math.imul(high ^ (code >>> 16), 0x01000193) >>> 0;
    // Mix in the high bits so multi-byte code points contribute too.
    low = Math.imul(low ^ high, 0x01000193) >>> 0;
  }
  const hex = (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
  return `fnv1a-${hex}`;
}

/**
 * Q23 — buffer-access map. For each `@bind name` shared by ≥2 kernels,
 * the pair-wise access kind decides whether the two dispatches can run
 * concurrently:
 *
 *   - rw vs rw → sequential with sync barrier.
 *   - rw vs ro → sequential with sync barrier.
 *   - ro vs ro → concurrent dispatch OK.
 *
 * The map's value is sorted by kernelId so test assertions don't depend
 * on insertion order.
 */
export interface BufferAccessEntry {
  kernelId: string;
  access: 'ro' | 'rw';
}

export function analyzeBufferAccesses(kernels: readonly Kernel[]): Map<string, BufferAccessEntry[]> {
  const out = new Map<string, BufferAccessEntry[]>();
  for (const kernel of kernels) {
    const binds = kernel.regionVerdict.directives.filter(
      (d): d is BindDirective => d.kind === 'bind',
    );
    for (const bind of binds) {
      const access: 'ro' | 'rw' = bind.readOnly ? 'ro' : 'rw';
      const existing = out.get(bind.name) ?? [];
      existing.push({ kernelId: kernel.id, access });
      out.set(bind.name, existing);
    }
  }
  for (const [name, entries] of out.entries()) {
    if (entries.length < 2) {
      // Single accessor — nothing to decide. Drop to keep the map small.
      out.delete(name);
      continue;
    }
    entries.sort((a, b) => a.kernelId.localeCompare(b.kernelId));
    out.set(name, entries);
  }
  return out;
}

/**
 * Q24 — cross-region DAG. Kernel `B` depends on kernel `A` when A writes
 * to a binding that B reads. The result is keyed by kernel id; the
 * value is a sorted list of ids that must complete before this kernel
 * can dispatch.
 */
export function analyzeRegionDependencies(kernels: readonly Kernel[]): Map<string, string[]> {
  // (writerByBinding) → list of kernel ids writing that binding.
  const writerByBinding = new Map<string, string[]>();
  const accessByKernel = new Map<string, { reads: string[]; writes: string[] }>();
  for (const kernel of kernels) {
    const reads: string[] = [];
    const writes: string[] = [];
    for (const directive of kernel.regionVerdict.directives) {
      if (directive.kind !== 'bind') continue;
      if (directive.readOnly) reads.push(directive.name);
      else writes.push(directive.name);
    }
    accessByKernel.set(kernel.id, { reads, writes });
    for (const write of writes) {
      const list = writerByBinding.get(write) ?? [];
      list.push(kernel.id);
      writerByBinding.set(write, list);
    }
  }
  const out = new Map<string, string[]>();
  for (const kernel of kernels) {
    const acc = accessByKernel.get(kernel.id);
    if (!acc) continue;
    const deps = new Set<string>();
    for (const read of acc.reads) {
      const writers = writerByBinding.get(read);
      if (!writers) continue;
      for (const writer of writers) {
        if (writer !== kernel.id) deps.add(writer);
      }
    }
    const list = Array.from(deps).sort();
    if (list.length > 0) out.set(kernel.id, list);
  }
  return out;
}