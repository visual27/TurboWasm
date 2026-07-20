/**
 * Walk an SB3 `project.json`-shaped tree and find the regions defined by
 * `@compute` block comments on `control_repeat` blocks.
 *
 * Region definition (§Phase 4, gpu-kernel-dsl-phase4-spec §4.1 — Form A):
 *
 *   region entrance:
 *     a `control_repeat` block that *itself* carries a comment whose
 *     text starts with `@compute`. The anchor IS the kernel container.
 *   region body:
 *     every block reachable from the kernel container's
 *     `inputs.SUBSTACK` head via `next` traversal, including sub-repeats
 *     inside it.
 *
 * Non-`control_repeat` anchors (legacy first-substack position, non-repeat
 * blocks, repeatUntil/while/forever) surface a
 * `gpu.legacy_compute_comment_position` warning once per anchor and are
 * skipped — no region is created. Anchor-level multi-comment cases
 * (same block carrying duplicate `@compute` markers) emit
 * `gpu.multiple_compute_regions` once and the first marker wins.
 *
 * §Phase 4: `findKernelContainer` / ancestor promotion / kernel-container
 * collision logic was removed. The comment anchor IS the kernel
 * container, and the path table (`repeatPathTable`) is built alongside
 * the region so the resolver (`repeat-path-resolver.ts`) can map user
 * `@repeat` directives onto concrete `control_repeat` block ids.
 */

import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import { extractBlockReference } from './block-reference';
import type {
  Diagnostic,
  ExtractedRegion,
  ParsedComment,
  ParsedProject,
  ParsedTarget,
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
  // §Phase 4: warn-once per non-Form-A anchor so users upgrading from
  // v9 fixtures see one diagnostic per malformed marker rather than
  // one per (anchor, sprite) pair. The set is keyed by `blockId` so
  // a single anchor's two markers deduplicate.
  const warnedLegacyAnchors = new Set<string>();

  for (const target of project.targets) {
    const candidates = collectComputeAnchorCandidates(target, project.comments);
    if (candidates.length === 0) continue;

    // §Phase 4: per-candidate adoption with kernel-container
    // collision removed. The anchor IS the kernel container, so two
    // distinct anchors on two distinct control_repeats always
    // survive independently. Two markers on the same anchor produce
    // a `MULTIPLE_COMPUTE_REGIONS` error and only the first wins.
    const seenCandidateBlockIds = new Set<string>();
    let regionIndex = 0;
    for (const { block, commentId } of candidates) {
      if (seenCandidateBlockIds.has(block.id)) {
        const regionId = `region:${target.id}:${block.id}:${regionIndex - 1}`;
        diagnostics.push({
          severity: 'error',
          code: GPU_DIAGNOSTIC_CODES.MULTIPLE_COMPUTE_REGIONS,
          regionId,
          blockId: block.id,
          message:
            `control_repeat block ${block.id} has multiple @compute markers; pick one`,
        });
        continue;
      }

      // §Phase 4: anchor gating. The only accepted opcode is
      // `control_repeat`. Anything else surfaces
      // `gpu.legacy_compute_comment_position` once and is skipped.
      if (block.opcode !== 'control_repeat') {
        if (!warnedLegacyAnchors.has(block.id)) {
          warnedLegacyAnchors.add(block.id);
          diagnostics.push({
            severity: 'warn',
            code: GPU_DIAGNOSTIC_CODES.LEGACY_COMPUTE_COMMENT_POSITION,
            blockId: block.id,
            message:
              `@compute on non-control_repeat block ('${block.opcode}') is removed in v10; ` +
              `attach the marker to a control_repeat block to adopt a region`,
          });
        }
        continue;
      }

      const substackId = readSubstackId(block);
      if (!substackId) {
        if (!warnedLegacyAnchors.has(block.id)) {
          warnedLegacyAnchors.add(block.id);
          diagnostics.push({
            severity: 'warn',
            code: GPU_DIAGNOSTIC_CODES.LEGACY_COMPUTE_COMMENT_POSITION,
            blockId: block.id,
            message:
              `@compute on control_repeat '${block.id}' has no SUBSTACK body; region skipped`,
          });
        }
        continue;
      }
      const substackEntry = target.blocks[substackId];
      if (!substackEntry) {
        if (!warnedLegacyAnchors.has(block.id)) {
          warnedLegacyAnchors.add(block.id);
          diagnostics.push({
            severity: 'warn',
            code: GPU_DIAGNOSTIC_CODES.LEGACY_COMPUTE_COMMENT_POSITION,
            blockId: block.id,
            message:
              `@compute on control_repeat '${block.id}' points at a missing SUBSTACK head; region skipped`,
          });
        }
        continue;
      }

      const bodyIds = walkSubstackBody(
        target.blocks,
        substackEntry,
        new Set([block.id]),
      );
      const repeatPathTable = buildRepeatPathTable(
        block,
        target.blocks,
      );

      const regionId = `region:${target.id}:${block.id}:${regionIndex}`;
      const region: ExtractedRegion = {
        regionId,
        blockId: block.id,
        spriteId: target.id,
        commentId,
        firstSubstackBlockId: substackEntry.id,
        bodyBlockIds: bodyIds,
        kernelContainerBlockId: block.id,
        repeatPathTable,
        regionIndex,
        inlinedPrototypeBlockIds: [],
        commentAnchorBlockId: block.id,
      };

      seenCandidateBlockIds.add(block.id);
      regions.push(region);
      regionIndex += 1;
    }
  }

  return { regions, diagnostics };
}

interface AnchorCandidate {
  block: RawBlock;
  commentId: string;
}

/**
 * Collect every block that carries an `@compute` comment and decide
 * whether it qualifies as a Phase 4 Form A anchor.
 *
 * §Phase 4:
 *   - `opcode === 'control_repeat'` ⇒ accept as anchor (kernel
 *     container itself).
 *   - `opcode === 'control_repeat_until' / 'control_while' /
 *     'control_forever'` ⇒ warn-once + skip (these loop shapes are
 *     never supported as region entrances).
 *   - Any other opcode (legacy first-substack marker, sibling
 *     block, etc.) ⇒ warn-once + skip.
 *
 * The function returns both the adopted candidates AND the warning
 * diagnostics inline so the caller can fold them into the result
 * without re-walking the block tree.
 */
function collectComputeAnchorCandidates(
  target: ParsedTarget,
  projectComments: Record<string, ParsedComment>,
): AnchorCandidate[] {
  const candidates: AnchorCandidate[] = [];
  // Each `@compute` comment is its own candidate — even when two
  // markers share a `blockId`. The per-candidate loop downstream is
  // responsible for emitting `MULTIPLE_COMPUTE_REGIONS` when the same
  // anchor carries duplicate markers.
  for (const [commentId, comment] of Object.entries(projectComments)) {
    if (!comment || !comment.blockId) continue;
    if (!comment.text.trim().startsWith('@compute')) continue;
    const owner = target.blocks[comment.blockId];
    if (!owner) continue;
    candidates.push({ block: owner, commentId });
  }
  return candidates;
}

/**
 * Build the `repeatPathTable` for a kernel container. Walks each
 * repeat's `SUBSTACK` `next` chain and counts direct-child
 * `control_repeat` siblings only. Non-repeat sibling blocks are not
 * counted, so inserting ordinary scratch statements between repeats
 * does not shift any numeric path.
 *
 * Each segment is a non-negative integer without leading zeros. The
 * table maps `'self'` to the kernel container, `'0'` / `'1'` / ...
 * to direct children, `'0.0'` / `'0.1'` / ... to grandchildren, etc.
 *
 * `control_if` and other branch sub-stacks are *not* visited —
 * v10 leaves nested-`if` repeats out of scope. `SUBSTACK2` is also
 * ignored.
 */
function buildRepeatPathTable(
  kernelContainer: RawBlock,
  blocks: Record<string, RawBlock>,
): Readonly<Record<string, string>> {
  const table: Record<string, string> = { self: kernelContainer.id };
  visitRepeatChildren(kernelContainer, '', blocks, table, new Set());
  return Object.freeze(table);
}

function visitRepeatChildren(
  parent: RawBlock,
  parentPath: string,
  blocks: Record<string, RawBlock>,
  table: Record<string, string>,
  visited: Set<string>,
): void {
  if (visited.has(parent.id)) return;
  visited.add(parent.id);

  const substackId = readSubstackId(parent);
  if (!substackId) return;
  const entry = blocks[substackId];
  if (!entry) return;

  let childIndex = 0;
  let cursor: RawBlock | undefined = entry;
  const localVisited = new Set<string>();
  while (cursor) {
    if (localVisited.has(cursor.id)) break;
    localVisited.add(cursor.id);
    if (cursor.opcode === 'control_repeat') {
      const segment = String(childIndex);
      const fullPath = parentPath.length === 0 ? segment : `${parentPath}.${segment}`;
      if (!Object.prototype.hasOwnProperty.call(table, fullPath)) {
        table[fullPath] = cursor.id;
      }
      visitRepeatChildren(cursor, fullPath, blocks, table, visited);
      childIndex += 1;
    }
    const nextId: string | null = cursor.next;
    if (typeof nextId !== 'string') break;
    cursor = blocks[nextId];
    if (!cursor) break;
  }
}

/**
 * Read the SUBSTACK input id off a `control_repeat` block. The vendored
 * VM stores it under `inputs.SUBSTACK` as a scratch-vm block reference,
 * which can take any of the raw shapes documented in
 * `block-reference.ts`. §Phase 1 unifies the accept logic on the shared
 * `extractBlockReference` helper so loader-emitted array shapes
 * (`[2, blockId]`) and the hand-built `{ id }` / bare-string shapes both
 * resolve to the same id.
 */
function readSubstackId(block: RawBlock): string | null {
  return extractBlockReference(block.inputs['SUBSTACK']);
}

/**
 * Walk a substack body. We collect every block reachable from `entry`
 * via `next`, and recursively into any substack / branch inputs we find
 * — but we deliberately do NOT follow `next` across the boundary where a
 * block itself is the kernel container (we'd loop).
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
    // §Phase 1: route every input value through `extractBlockReference`
    // so the union of accept-shapes (`[2, id]`, `{ id }`, `{ block,
    // shadow }`, bare string, ...) is handled identically here and in
    // `readSubstackId`.
    for (const [, value] of Object.entries(current.inputs)) {
      if (value === null || value === undefined) continue;
      const id = extractBlockReference(value);
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
