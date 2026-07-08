/**
 * Type declarations for scripts/apply-vendored-patches.mjs.
 *
 * The implementation is plain ESM JavaScript (Node.js cannot run
 * TypeScript-syntax `.mjs` files), but vitest consumers want typed
 * access to `applyPatches()` for assertion purposes. This shim
 * re-exports the same names with their real signatures; the runtime
 * module is the source of truth.
 */

export type ApplyPatchesResult =
  | { status: 'ok'; applied: string[]; alreadyApplied: string[] }
  | { status: 'skipped'; reason: 'env' | 'no-render' }
  | { status: 'failed'; failures: { patch: string; reason: string }[] };

export interface ApplyPatchesOptions {
  exitOnComplete?: boolean;
  verbose?: boolean;
}

export declare function applyPatches(
  options?: ApplyPatchesOptions,
): ApplyPatchesResult;
