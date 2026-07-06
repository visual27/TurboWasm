import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- the generator script is JS without its own .d.ts file
import { buildBenchTouching } from '../../scripts/gen-bench-sb3.mjs';

// SB3 input relationship and primitive constants, mirrored from
// vendored/scratch-vm/src/serialization/sb3.js so the assertions here
// stay aligned with what the deserializer actually accepts.
const INPUT_SAME_BLOCK_SHADOW = 1;
const INPUT_BLOCK_NO_SHADOW = 2;
const INPUT_DIFF_BLOCK_SHADOW = 3;
const MATH_NUM_PRIMITIVE = 4;

interface ProjectBlock {
  opcode: string;
  inputs?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  next?: string | null;
  parent?: string | null;
  topLevel?: boolean;
  shadow?: boolean;
  x?: number;
  y?: number;
  mutation?: unknown;
}

interface ProjectTarget {
  name: string;
  isStage: boolean;
  blocks: Record<string, ProjectBlock>;
  variables: Record<string, unknown>;
  costumes: Array<{ dataFormat: string }>;
}

interface ProjectJson {
  targets: ProjectTarget[];
  monitors: Array<{ opcode: string; params: { VARIABLE: string } }>;
  extensions: string[];
}

type BlockTable = Record<string, ProjectBlock>;

function getAllBlocks(): { stage: BlockTable; sprites: Record<string, BlockTable> } {
  const project = buildBenchTouching() as unknown as ProjectJson;
  const stage = project.targets.find((t: ProjectTarget) => t.isStage);
  if (!stage) throw new Error('stage target missing');
  const sprites: Record<string, BlockTable> = {};
  for (const t of project.targets) {
    if (!t.isStage) sprites[t.name] = t.blocks;
  }
  return { stage: stage.blocks, sprites };
}

function isPrimitiveArray(value: unknown): value is [number, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'string'
  );
}

function validateInputShape(blocks: BlockTable): { errors: string[] } {
  const errors: string[] = [];
  for (const [id, block] of Object.entries(blocks)) {
    if (!block.inputs) continue;
    for (const [inputName, raw] of Object.entries(block.inputs)) {
      if (!Array.isArray(raw)) {
        errors.push(`${id}.inputs.${inputName}: not an array (${typeof raw})`);
        continue;
      }
      const kind = raw[0];
      if (kind === INPUT_SAME_BLOCK_SHADOW) {
        const payload = raw[1];
        if (typeof payload === 'string') {
          if (!(payload in blocks)) {
            errors.push(`${id}.inputs.${inputName}: shadow id "${payload}" missing in blocks`);
          }
        } else if (isPrimitiveArray(payload)) {
          // inline primitive is acceptable
        } else {
          errors.push(
            `${id}.inputs.${inputName}: [1, ...] payload must be shadow id or primitive (got ${typeof payload})`,
          );
        }
      } else if (kind === INPUT_BLOCK_NO_SHADOW) {
        const blockId = raw[1];
        if (typeof blockId !== 'string') {
          errors.push(`${id}.inputs.${inputName}: [2, ...] block id must be string`);
        } else if (blockId !== 'placeholder' && !(blockId in blocks)) {
          errors.push(`${id}.inputs.${inputName}: block id "${blockId}" missing in blocks`);
        }
      } else if (kind === INPUT_DIFF_BLOCK_SHADOW) {
        const blockId = raw[1];
        const shadowId = raw[2];
        if (typeof blockId !== 'string' || !(blockId in blocks)) {
          errors.push(`${id}.inputs.${inputName}: [3, ...] block id "${blockId}" missing`);
        }
        if (typeof shadowId !== 'string' || !(shadowId in blocks)) {
          errors.push(`${id}.inputs.${inputName}: [3, ...] shadow id "${shadowId}" missing`);
        }
      } else {
        errors.push(`${id}.inputs.${inputName}: unknown input kind ${kind}`);
      }
    }
  }
  return { errors };
}

describe('gen-bench-sb3 (G1/G2/G3)', () => {
  it('produces three targets: Stage, Other, Actor', () => {
    const project = buildBenchTouching() as unknown as ProjectJson;
    const names = project.targets.map((t: ProjectTarget) => t.name);
    expect(names).toEqual(['Stage', 'Other', 'Actor']);
  });

  it('emits only the snake_case control_create_clone_of opcode (G3)', () => {
    const project = buildBenchTouching() as unknown as ProjectJson;
    const opcodes = new Set<string>();
    for (const t of project.targets) {
      for (const b of Object.values(t.blocks)) opcodes.add(b.opcode);
    }
    expect(opcodes.has('control_create_clone_of')).toBe(true);
    expect(opcodes.has('control_createcloneof')).toBe(false);
  });

  it('uses inline math_number primitives instead of separate shadow blocks (G1)', () => {
    const project = buildBenchTouching() as unknown as ProjectJson;
    for (const t of project.targets) {
      const opcodes = Object.values(t.blocks).map((b: ProjectBlock) => b.opcode);
      // All math_number shadow blocks should have been collapsed into
      // inline primitives — no separate math_number entries remain.
      expect(opcodes).not.toContain('math_number');
    }
  });

  it('uses inline colour_picker primitive for sensing_touchingcolor (G1)', () => {
    const { sprites } = getAllBlocks();
    // No colour_picker shadow block is necessary when it's inlined.
    for (const blocks of Object.values(sprites)) {
      const opcodes = Object.values(blocks).map((b: ProjectBlock) => b.opcode);
      expect(opcodes).not.toContain('colour_picker');
    }
  });

  it('stage data_setvariableto carries a VALUE input (G2)', () => {
    const { stage } = getAllBlocks();
    const setters = Object.values(stage).filter((b: ProjectBlock) => b.opcode === 'data_setvariableto');
    expect(setters.length).toBeGreaterThanOrEqual(3);
    for (const setter of setters) {
      const value = setter.inputs?.VALUE;
      expect(Array.isArray(value)).toBe(true);
      const arr = value as unknown[];
      expect(arr[0]).toBe(INPUT_SAME_BLOCK_SHADOW);
      const payload = arr[1];
      expect(isPrimitiveArray(payload)).toBe(true);
      if (isPrimitiveArray(payload)) {
        expect(payload[0]).toBe(MATH_NUM_PRIMITIVE);
        expect(payload[1]).toBe('0');
      }
    }
  });

  it('every input shape is well-formed and references existing blocks', () => {
    const { stage, sprites } = getAllBlocks();
    const allErrors: string[] = [];
    allErrors.push(...validateInputShape(stage).errors);
    for (const [name, blocks] of Object.entries(sprites)) {
      const result = validateInputShape(blocks);
      for (const e of result.errors) allErrors.push(`[${name}] ${e}`);
    }
    expect(allErrors).toEqual([]);
  });

  it('forever block has a SUBSTACK input referencing its first child', () => {
    const { sprites } = getAllBlocks();
    for (const [spriteName, blocks] of Object.entries(sprites)) {
      const forever = Object.entries(blocks).find(([, b]) => (b as ProjectBlock).opcode === 'control_forever') as [string, ProjectBlock] | undefined;
      if (!forever) continue;
      const [, foreverBlock] = forever;
      const substack = foreverBlock.inputs?.SUBSTACK;
      expect(Array.isArray(substack), `${spriteName} forever SUBSTACK is array`).toBe(true);
      const substackArr = substack as unknown[];
      expect(substackArr[0]).toBe(INPUT_BLOCK_NO_SHADOW);
      const childId = substackArr[1] as string;
      expect(typeof childId).toBe('string');
      expect(childId in blocks, `${spriteName} forever first child exists`).toBe(true);
    }
  });

  it('topLevel hats are present in every non-stage sprite', () => {
    const { sprites } = getAllBlocks();
    for (const [name, blocks] of Object.entries(sprites)) {
      const topLevelHats = Object.values(blocks).filter(
        (b: ProjectBlock) =>
          b.topLevel === true &&
          (b.opcode === 'event_whenflagclicked' || b.opcode === 'control_start_as_clone'),
      );
      expect(topLevelHats.length, `${name} should have at least one hat`).toBeGreaterThan(0);
    }
  });

  it('every touchingObject block has a TOUCHINGOBJECTMENU shadow (G1 menu shadows)', () => {
    const { sprites } = getAllBlocks();
    for (const [name, blocks] of Object.entries(sprites)) {
      for (const [id, block] of Object.entries(blocks)) {
        const b = block as ProjectBlock;
        if (b.opcode !== 'sensing_touchingobject') continue;
        const menuInput = b.inputs?.TOUCHINGOBJECTMENU;
        expect(Array.isArray(menuInput), `${name}:${id} TOUCHINGOBJECTMENU is array`).toBe(true);
        const menuArr = menuInput as unknown[];
        expect(menuArr[0]).toBe(INPUT_SAME_BLOCK_SHADOW);
        const shadowId = menuArr[1] as string;
        expect(typeof shadowId).toBe('string');
        expect(shadowId in blocks, `${name}:${id} menu shadow exists`).toBe(true);
      }
    }
  });

  it('every pointToward/menu has a TOWARDS shadow', () => {
    const { sprites } = getAllBlocks();
    for (const [name, blocks] of Object.entries(sprites)) {
      for (const [id, block] of Object.entries(blocks)) {
        const b = block as ProjectBlock;
        if (b.opcode !== 'motion_pointtowards') continue;
        const towards = b.inputs?.TOWARDS;
        const towardsArr = towards as unknown[];
        expect(towardsArr[0]).toBe(INPUT_SAME_BLOCK_SHADOW);
        const shadowId = towardsArr[1] as string;
        expect(shadowId in blocks, `${name}:${id} TOWARDS shadow exists`).toBe(true);
      }
    }
  });

  it('control_create_clone_of uses an INPUT shadow (not a field) for CLONE_OPTION', () => {
    const { sprites } = getAllBlocks();
    for (const [name, blocks] of Object.entries(sprites)) {
      for (const [id, block] of Object.entries(blocks)) {
        const b = block as ProjectBlock;
        if (b.opcode !== 'control_create_clone_of') continue;
        // CLONE_OPTION must be an input shadow, not a field.
        expect(b.fields?.CLONE_OPTION, `${name}:${id} should not use CLONE_OPTION field`).toBeUndefined();
        const input = b.inputs?.CLONE_OPTION;
        expect(Array.isArray(input), `${name}:${id} CLONE_OPTION input is array`).toBe(true);
        const arr = input as unknown[];
        expect(arr[0]).toBe(INPUT_SAME_BLOCK_SHADOW);
        const shadowId = arr[1] as string;
        expect(shadowId in blocks, `${name}:${id} CLONE_OPTION shadow exists`).toBe(true);
        const shadow = blocks[shadowId] as ProjectBlock;
        expect(shadow.opcode).toBe('control_create_clone_of_menu');
      }
    }
  });

  it('emits expected monitor variables (counter, actor_hits, other_hits)', () => {
    const project = buildBenchTouching() as unknown as ProjectJson;
    const monitorVars = project.monitors.map((m: { params: { VARIABLE: string } }) => m.params.VARIABLE).sort();
    expect(monitorVars).toEqual(['actor_hits', 'counter', 'other_hits']);
  });
});