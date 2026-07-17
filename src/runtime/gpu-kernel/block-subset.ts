/**
 * D1 demote classifier for region bodies.
 *
 * D1 (spec §4.1) rules:
 *
 *   - An unsupported opcode is in the body → region-level D1.
 *   - A nested @compute region (inner `control_repeat` carrying an
 *     `@compute` comment) is reachable inside the body → outer D1.
 *   - A `control_repeat_until`, `control_while`, or `control_forever` is
 *     reachable anywhere in the body → region-level D1.
 *
 * "Reachable" is determined by the region's `bodyBlockIds` plus a
 * recursive scan of `inputs` to catch sub-stacks of nested control
 * blocks. The block-subsetter operates on the already-walked body, so
 * nesting detection here is structural (looking for inner `@compute`
 * comments), not subtree-based.
 */

import type {
  BlockSubsetVerdict,
  Diagnostic,
  ExtractedRegion,
  ParsedComment,
  ParsedProject,
  RawBlock,
} from './types';

const GPU_UNSAFE_OPCODES: ReadonlySet<string> = new Set([
  // Loops not allowed inside a region.
  'control_repeat_until',
  'control_while',
  'control_forever',

  // String / random / wait / stop (side-effectful or not data-parallel).
  'operator_random',
  'operator_join',
  'operator_letter_of',
  'operator_stringLength',
  'operator_stringContains',
  'operator_stringIndex',
  'operator_stringLength',
  'data_stringindex',
  'data_stringlength',
  'data_stringcontains',
  'control_wait',
  'control_wait_until',
  'control_stop',
  'event_broadcast',
  'event_broadcastandwait',

  // Pen + sound + sensing layer side effects.
  'pen_penDown',
  'pen_penUp',
  'pen_clear',
  'pen_stamp',
  'pen_changePenHueByParam',
  'pen_changePenParamBy',
  'pen_setPenColorToColor',
  'pen_setPenParamTo',
  'pen_changePenSizeBy',
  'pen_setPenSizeTo',
  'sound_play',
  'sound_playUntilDone',
  'sound_stopAllSounds',
  'sensing_username',
  'sensing_usernameId',
  'sensing_daysSince2000',
  'sensing_current',
  'sensing_loudness',
  'sensing_touchingobject',
  'sensing_touchingcolor',
  'sensing_coloristouchingcolor',
  'sensing_distanceto',
  'sensing_timer',
  'sensing_resettimer',
  'sensing_of',
  'sensing_mousex',
  'sensing_mousey',
  'sensing_mousedown',
  'sensing_keypressed',
  'sensing_setdragmode',

  // List mutations that touch the host. Per spec §5.2, `data_addtolist` is
  // explicitly D1.
  'data_addtolist',
  'data_deleteoflist',
  'data_insertatlist',
  'data_deletealloflist',
  'data_replaceitemoflist',

  // Custom block calls (we don't trace `procedure_prototype` arg shapes).
  'procedure_call',
  'argument_reporter_string',
]);

const HOOK_OPCODE_KEYS = ['SUBSTACK', 'SUBSTACK2', 'CONDITION'];

export interface ClassifyBlockSubsetInput {
  region: ExtractedRegion;
  project: ParsedProject;
  /** Map of commentId → ParsedComment for nested-region detection. */
  comments: Record<string, ParsedComment>;
}

/**
 * Pure D1 verdict. `valid: false` means the region falls back to the JS
 * path (cascade into M5).
 */
export function classifyBlockSubset(
  input: ClassifyBlockSubsetInput,
): BlockSubsetVerdict {
  const { region, project } = input;
  const diagnostics: Diagnostic[] = [];

  // Build a flat list of blocks reachable inside the body. region.bodyBlockIds
  // already covers the entry substack via `next`. We additionally walk
  // `inputs.SUBSTACK` of nested control blocks (control_if / nested control_repeat)
  // because `region-extractor` only walked the entry substack.
  const bodyBlocks: RawBlock[] = [];
  const visited = new Set<string>();
  const queue: string[] = [...region.bodyBlockIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const block = findBlock(project, id);
    if (!block) continue;
    bodyBlocks.push(block);
    if (typeof block.next === 'string') queue.push(block.next);
    for (const key of HOOK_OPCODE_KEYS) {
      const sub = block.inputs[key];
      if (typeof sub === 'string') queue.push(sub);
      else if (sub && typeof sub === 'object' && typeof (sub as { id?: unknown }).id === 'string') {
        queue.push((sub as { id: string }).id);
      }
    }
  }

  for (const block of bodyBlocks) {
    if (GPU_UNSAFE_OPCODES.has(block.opcode)) {
      const diag: Diagnostic = {
        severity: 'warn',
        code: 'd1.region_demoted',
        message: `region '${region.regionId}' contains unsupported opcode '${block.opcode}' (D1 demote, falling back to JS)`,
        regionId: region.regionId,
        blockId: region.blockId,
      };
      return { valid: false, demoteReason: 'd1', diagnostics: [diag] };
    }
  }

  // Nested @compute region detection: any inner `control_repeat` whose
  // first-substack block carries an `@compute` comment.
  for (const block of bodyBlocks) {
    if (block.opcode !== 'control_repeat') continue;
    const subId = readSubstackId(block);
    if (!subId) continue;
    const inner = findBlock(project, subId);
    if (!inner) continue;
    const innerComment = findCommentByBlockId(input.comments, inner.id);
    if (innerComment && innerComment.text.trim().startsWith('@compute')) {
      const diag: Diagnostic = {
        severity: 'warn',
        code: 'd1.region_demoted',
        message: `region '${region.regionId}' contains a nested @compute region (D1 demote, falling back to JS)`,
        regionId: region.regionId,
        blockId: region.blockId,
      };
      return { valid: false, demoteReason: 'd1', diagnostics: [diag] };
    }
  }

  return { valid: true, diagnostics };
}

function findBlock(project: ParsedProject, id: string): RawBlock | undefined {
  for (const target of project.targets) {
    const b = target.blocks[id];
    if (b) return b;
  }
  return undefined;
}

function readSubstackId(block: RawBlock): string | null {
  const sub = block.inputs['SUBSTACK'];
  if (typeof sub === 'string') return sub;
  if (sub && typeof sub === 'object') {
    const id = (sub as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

function findCommentByBlockId(
  comments: Record<string, ParsedComment>,
  blockId: string,
): ParsedComment | undefined {
  for (const c of Object.values(comments)) {
    if (c && c.blockId === blockId) return c;
  }
  return undefined;
}
