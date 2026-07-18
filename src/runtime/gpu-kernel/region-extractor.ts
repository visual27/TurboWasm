/**
 * Walk an SB3 `project.json`-shaped tree and find the regions defined by
 * `@compute` block comments on `control_repeat` blocks.
 *
 * Region definition (spec §3.1):
 *
 *   region entrance:
 *     a `control_repeat` block whose `inputs.SUBSTACK` points at a
 *     substack; the *first* substack block carries a comment whose text
 *     starts with `@compute`.
 *   region body:
 *     every block reachable from that first substack via `next` traversal,
 *     including sub-repeats inside it.
 *
 * Repeat-until / while / forever are NOT allowed as region entrances
 * (§4.6). We extract them anyway (so the block-subsetter can D1-demote
 * them), but we never call their substack a region body.
 *
 * §Phase 0 (nested-parallelization-01-phase0 §3.7): the candidate
 * (`@compute`-marked `control_repeat`) and the kernel container are
 * distinguished. The kernel container is the candidate's *nearest
 * ancestor* `control_repeat` — or the candidate itself when no ancestor
 * exists (= legacy outer-only layout). This lets `fn expo` style
 * nested layouts carry their `@compute` marker on the deepest
 * `control_repeat` while still emitting WGSL over the surrounding loop.
 */

import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import type {
  Diagnostic,
  ExtractedRegion,
  ParsedProject,
  RawBlock,
} from './types';

export interface RegionExtractionResult {
  regions: ExtractedRegion[];
  diagnostics: Diagnostic[];
}

/**
 * Public entry point. Pure — does not mutate the parsed project.
 */
export function extractRegions(project: ParsedProject): RegionExtractionResult {
  const regions: ExtractedRegion[] = [];
  const diagnostics: Diagnostic[] = [];

  // Per spec §3.1: the `@compute` comment lives on the first substack
  // block, not on the `control_repeat` itself. Index comments by their
  // owning blockId so we can look up "what comment does block X carry".
  const commentIdByBlockId = new Map<string, string>();
  for (const [commentId, comment] of Object.entries(project.comments)) {
    if (!comment || !comment.blockId) continue;
    commentIdByBlockId.set(comment.blockId, commentId);
  }

  for (const target of project.targets) {
    // Phase 0: collect every `@compute`-marked control_repeat in this
    // sprite so we can promote the first to a region and surface
    // duplicates via `gpu.multiple_compute_regions`.
    const candidates: RawBlock[] = [];
    for (const block of Object.values(target.blocks)) {
      if (!block) continue;
      if (block.opcode !== 'control_repeat') continue;
      const firstSubstackId = readSubstackId(block);
      if (!firstSubstackId) continue;
      const entryBlock = target.blocks[firstSubstackId];
      if (!entryBlock) continue;
      const commentId = commentIdByBlockId.get(entryBlock.id);
      if (!commentId) continue;
      const comment = project.comments[commentId];
      if (!comment) continue;
      if (!comment.text.trim().startsWith('@compute')) continue;
      candidates.push(block);
    }
    if (candidates.length === 0) continue;

    // Phase 0: a sprite carrying multiple `@compute` markers is almost
    // certainly a mistake — surface it as an error-severity diagnostic
    // and record the surplus block ids on the surviving region so users
    // can find them in the editor.
    const duplicateIds = candidates.length > 1
      ? candidates.slice(1).map((c) => c.id)
      : [];
    if (duplicateIds.length > 0) {
      diagnostics.push({
        severity: 'error',
        code: GPU_DIAGNOSTIC_CODES.MULTIPLE_COMPUTE_REGIONS,
        message:
          `Multiple @compute markers found in sprite "${target.id}": ` +
          `[${candidates.map((c) => c.id).join(', ')}]. Pick one.`,
      });
    }

    const candidate = candidates[0]!;
    const kernelContainer = findKernelContainer(candidate, target.blocks);
    const kernelContainerId = kernelContainer.id;

    // The body entry is the candidate's substack head when nested, or
    // the kernel container's substack head when the candidate is the
    // outermost control_repeat (legacy case).
    const isNested = candidate.id !== kernelContainer.id;
    let bodyEntry: RawBlock;
    let commentBlockId: string;
    if (isNested) {
      const candidateSubId = readSubstackId(candidate);
      if (!candidateSubId) continue;
      const candidateEntry = target.blocks[candidateSubId];
      if (!candidateEntry) continue;
      bodyEntry = candidateEntry;
      commentBlockId = candidateEntry.id;
    } else {
      const kernelSubId = readSubstackId(kernelContainer);
      if (!kernelSubId) continue;
      const kernelEntry = target.blocks[kernelSubId];
      if (!kernelEntry) continue;
      bodyEntry = kernelEntry;
      commentBlockId = kernelEntry.id;
    }

    const commentId = commentIdByBlockId.get(commentBlockId);
    if (!commentId) continue;

    const bodyIds = walkSubstackBody(
      target.blocks,
      bodyEntry,
      new Set([kernelContainerId]),
    );

    // Phase 0: every control_repeat visible from the body — *excluding*
    // the kernel container itself — is a candidate for Phase 2's
    // implicit-axis emission. The `@compute` candidate itself is also a
    // target when nested, but it sits *outside* the walk (the walk
    // starts at the candidate's substack head) so we add it explicitly.
    const nestedRepeatContainerBlockIds: string[] = [];
    if (isNested) {
      nestedRepeatContainerBlockIds.push(candidate.id);
    }
    for (const id of bodyIds) {
      if (id === kernelContainerId) continue;
      if (id === candidate.id) continue;
      const b = target.blocks[id];
      if (b && b.opcode === 'control_repeat') {
        nestedRepeatContainerBlockIds.push(id);
      }
    }

    regions.push({
      regionId: `region:${target.id}:${kernelContainerId}`,
      blockId: kernelContainerId,
      spriteId: target.id,
      commentId,
      firstSubstackBlockId: commentBlockId,
      bodyBlockIds: bodyIds,
      kernelContainerBlockId: kernelContainerId,
      nestedRepeatContainerBlockIds,
      duplicateComputeBlockIds: duplicateIds,
    });
  }

  return { regions, diagnostics };
}

/**
 * Promote a `@compute`-marked candidate to a kernel container.
 *
 * Walks the candidate's `parent` chain and returns the nearest ancestor
 * whose opcode is `control_repeat`. When no such ancestor exists (the
 * candidate is sprite-level / topLevel), the candidate itself is
 * returned unchanged — this matches the legacy behaviour where the
 * `@compute` marker sits on the only control_repeat in the sprite.
 *
 * §Phase 0 (nested-parallelization-01-phase0 §3.7). Stops at the first
 * `control_repeat` ancestor; outer scratch loops further up the chain
 * remain ordinary scratch and are not promoted.
 */
function findKernelContainer(
  candidate: RawBlock,
  blocks: Record<string, RawBlock>,
): RawBlock {
  let current: RawBlock | undefined = candidate;
  while (current) {
    const parentId: string | null = current.parent;
    if (typeof parentId !== 'string') break;
    const parent: RawBlock | undefined = blocks[parentId];
    if (!parent) break;
    if (parent.opcode === 'control_repeat' && parent.id !== candidate.id) {
      return parent;
    }
    current = parent;
  }
  return candidate;
}

/**
 * Read the SUBSTACK input id off a `control_repeat` block. The vendored
 * VM stores it under `inputs.SUBSTACK` and the value is either a block
 * id string or `{ id: '...', name: '...' }` (the standard scratch-vm
 * block reference shape).
 */
function readSubstackId(block: RawBlock): string | null {
  const sub = block.inputs['SUBSTACK'];
  if (typeof sub === 'string') return sub;
  if (sub && typeof sub === 'object') {
    const id = (sub as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * Walk a substack body. We collect every block reachable from `entry`
 * via `next`, and recursively into any substack / branch inputs we find
 * — but we deliberately do NOT follow `next` across the boundary where a
 * block itself is the repeat's entrance (we'd loop).
 */
function walkSubstackBody(
  blocks: Record<string, RawBlock>,
  entry: RawBlock,
  ancestorIds: Set<string>,
): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const stack: RawBlock[] = [entry];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (visited.has(current.id)) continue;
    if (ancestorIds.has(current.id)) continue;
    visited.add(current.id);
    order.push(current.id);
    // Walk the `next` chain.
    const nextId = current.next;
    if (typeof nextId === 'string') {
      const next = blocks[nextId];
      if (next) stack.push(next);
    }
    // Walk into any sub-stacks (control_if / control_if_else /
    // control_repeat) so the block-subsetter sees their bodies too.
    for (const [, value] of Object.entries(current.inputs)) {
      if (value === null || value === undefined) continue;
      // shape: { id, name } | string | BlockShadowArray
      let id: string | null = null;
      if (typeof value === 'string') {
        id = value;
      } else if (typeof value === 'object') {
        const objValue = value as { id?: unknown };
        if (typeof objValue.id === 'string') id = objValue.id;
      }
      if (id && blocks[id] && !visited.has(id)) {
        const child = blocks[id];
        if (child) stack.push(child);
      }
    }
  }
  return order;
}

/**
 * Convenience accessor used by other gpu-kernel modules and by tests:
 * look up a block by id with a clear `undefined`-narrow contract.
 */
export function getBlockOrUndefined(
  project: ParsedProject,
  blockId: string,
): RawBlock | undefined {
  for (const target of project.targets) {
    const found = target.blocks[blockId];
    if (found) return found;
  }
  return undefined;
}
