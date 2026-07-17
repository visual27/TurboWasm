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
 */

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

      const bodyIds = walkSubstackBody(target.blocks, entryBlock, new Set([block.id]));
      regions.push({
        regionId: `region:${target.id}:${block.id}`,
        blockId: block.id,
        spriteId: target.id,
        commentId,
        firstSubstackBlockId: entryBlock.id,
        bodyBlockIds: bodyIds,
      });
    }
  }

  return { regions, diagnostics };
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
