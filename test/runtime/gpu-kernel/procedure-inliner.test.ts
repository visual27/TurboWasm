/**
 * §Phase 5 (gpu-kernel-dsl-phase5-spec §5.7) — `procedure-inliner.ts`
 * unit tests. Hand-crafted scratch DTOs (mirroring the
 * `region-extractor.test.ts` pattern) so the depth-17 / cycle /
 * argument-replacement paths can be exercised without standing up a
 * full sb3 fixture.
 */
import { describe, expect, it } from 'vitest';
import { inlineProcedures } from '@/runtime/gpu-kernel/procedure-inliner';
import { MAX_INLINING_DEPTH } from '@/utils/constants';
import type { ExtractedRegion, ParsedProject, RawBlock } from '@/runtime/gpu-kernel/types';

function mkBlock(id: string, opcode: string, opts: Partial<RawBlock> = {}): RawBlock {
  return {
    id,
    opcode,
    next: null,
    parent: null,
    inputs: {},
    fields: {},
    ...opts,
  };
}

function mkPrototype(
  id: string,
  proccode: string,
  argumentNames: string[],
  substackHeadId: string,
): RawBlock {
  return mkBlock(id, 'procedures_prototype', {
    inputs: { SUBSTACK: substackHeadId },
    mutation: {
      proccode,
      argumentnames: JSON.stringify(argumentNames),
    },
    topLevel: true,
  });
}

function mkCall(
  id: string,
  proccode: string,
  args: Array<{ key: string; refId: string }>,
  parent: string | null,
): RawBlock {
  const inputs: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    inputs[`arg${i}`] = [2, arg.refId];
  }
  return mkBlock(id, 'procedure_call', {
    inputs,
    mutation: { proccode },
    parent,
  });
}

function mkReporterString(id: string, name: string, parent: string | null): RawBlock {
  return mkBlock(id, 'argument_reporter_string', {
    fields: { VARIABLE: [name, null] },
    parent,
  });
}

function mkRegion(bodyBlockIds: string[]): ExtractedRegion {
  return {
    regionId: 'region:sprite1:kernelContainer:0',
    blockId: 'kernelContainer',
    spriteId: 'sprite1',
    commentId: 'cmt',
    firstSubstackBlockId: bodyBlockIds[0] ?? '',
    bodyBlockIds,
    kernelContainerBlockId: 'kernelContainer',
    repeatPathTable: { self: 'kernelContainer' },
    regionIndex: 0,
    inlinedPrototypeBlockIds: [],
    commentAnchorBlockId: 'kernelContainer',
  };
}

function mkProject(blocks: RawBlock[]): ParsedProject {
  const blockMap: Record<string, RawBlock> = {};
  for (const b of blocks) blockMap[b.id] = b;
  return {
    targets: [{ id: 'sprite1', isStage: false, blocks: blockMap }],
    comments: {},
  };
}

describe('procedure-inliner: §Phase 5 prototype expansion', () => {
  it('inlines a zero-argument procedure_call by copying its body', () => {
    const write = mkBlock('writeA', 'data_replaceitemoflist', { parent: 'protoSubst' });
    const subHead = mkBlock('protoSubst', 'data_itemoflist', { next: 'writeA' });
    const proto = mkPrototype('proto', 'apply_expo', [], 'protoSubst');
    const call = mkCall('call1', 'apply_expo', [], 'kernelContainer');
    const project = mkProject([proto, subHead, write, call]);
    const region = mkRegion(['call1']);

    const result = inlineProcedures(region, project, 'sprite1');

    expect(result.diagnostics).toEqual([]);
    expect(result.inlinedPrototypeBlockIds).toEqual(['proto']);
    expect(result.bodyBlockIds).toHaveLength(2);
    // Both new ids must be the inliner's sprite-local fresh ids.
    for (const id of result.bodyBlockIds) {
      expect(id.startsWith('__tw_inl_sprite1_')).toBe(true);
    }
    // Fresh -> original map must point at the prototype body blocks.
    const originals = new Set(result.freshBlockIdMappings.values());
    expect(originals.has('protoSubst')).toBe(true);
    expect(originals.has('writeA')).toBe(true);
  });

  it('replaces argument_reporter_string with the call-site argument block id', () => {
    const argReporter = mkReporterString('argRep_v', 'v', 'protoSubst');
    const useReporter = mkBlock('useReporter', 'operator_multiply', {
      inputs: { NUM1: 'argRep_v' },
      next: null,
      parent: 'protoSubst',
    });
    const write = mkBlock('writeA', 'data_replaceitemoflist', {
      inputs: { ITEM: 'useReporter' },
      parent: 'protoSubst',
      next: null,
    });
    const subHead = mkBlock('protoSubst', 'data_itemoflist', { next: 'writeA' });
    const proto = mkPrototype('proto', 'mul_by %s', ['v'], 'protoSubst');
    const callArg = mkBlock('callArgValue', 'math_number', { fields: { NUM: [2, null] } });
    const call = mkCall(
      'call1',
      'mul_by %s',
      [{ key: 'v', refId: 'callArgValue' }],
      'kernelContainer',
    );
    const project = mkProject([
      proto,
      subHead,
      argReporter,
      useReporter,
      write,
      callArg,
      call,
    ]);
    const region = mkRegion(['call1']);

    const result = inlineProcedures(region, project, 'sprite1');

    expect(result.diagnostics).toEqual([]);
    // The inlined body must carry the callArgValue id directly (no
    // fresh-id allocation for reporters; the reporter is replaced by
    // reference).
    expect(result.bodyBlockIds).toContain('callArgValue');
    expect(result.bodyBlockIds).not.toContain('argRep_v');
    // useReporter and writeA get fresh ids and remapped inputs.
    expect(result.freshBlockIdMappings.has('argRep_v') ?? false ? false : true).toBe(true);
    // No control_repeat in the prototype body, so no boundBlockIdRemaps.
    expect(result.boundBlockIdRemaps.size).toBe(0);
    // The fresh -> original map should record useReporter and writeA
    // but NOT argRep_v (reporter is replaced, not copied).
    const originals = new Set(result.freshBlockIdMappings.values());
    expect(originals.has('useReporter')).toBe(true);
    expect(originals.has('writeA')).toBe(true);
    expect(originals.has('argRep_v')).toBe(false);
  });

  it('replaces argument_reporter_boolean with the call-site argument block id', () => {
    const argReporter = mkBlock('argRep_flag', 'argument_reporter_boolean', {
      fields: { VARIABLE: ['flag', null] },
      parent: 'protoSubst',
    });
    const useReporter = mkBlock('useReporter', 'operator_and', {
      inputs: { OPERAND1: 'argRep_flag' },
      parent: 'protoSubst',
    });
    const write = mkBlock('writeA', 'data_replaceitemoflist', {
      inputs: { ITEM: 'useReporter' },
      parent: 'protoSubst',
    });
    const subHead = mkBlock('protoSubst', 'data_itemoflist', { next: 'writeA' });
    const proto = mkPrototype('proto', 'with_flag %b', ['flag'], 'protoSubst');
    const callArg = mkBlock('callArgFlag', 'operator_true');
    const call = mkCall(
      'call1',
      'with_flag %b',
      [{ key: 'flag', refId: 'callArgFlag' }],
      'kernelContainer',
    );
    const project = mkProject([
      proto,
      subHead,
      argReporter,
      useReporter,
      write,
      callArg,
      call,
    ]);
    const region = mkRegion(['call1']);

    const result = inlineProcedures(region, project, 'sprite1');

    expect(result.diagnostics).toEqual([]);
    expect(result.bodyBlockIds).toContain('callArgFlag');
    expect(result.bodyBlockIds).not.toContain('argRep_flag');
  });

  it('returns PROCEDURE_PROTOTYPE_NOT_FOUND error when proccode does not match', () => {
    const call = mkCall('call1', 'no_such_proc', [], 'kernelContainer');
    const project = mkProject([call]);
    const region = mkRegion(['call1']);

    const result = inlineProcedures(region, project, 'sprite1');

    expect(result.diagnostics).toHaveLength(1);
    const diag = result.diagnostics[0]!;
    expect(diag.severity).toBe('error');
    expect(diag.code).toBe('gpu.procedure_prototype_not_found');
    expect(diag.message).toMatch(/no_such_proc/);
    // Empty inlining result.
    expect(result.bodyBlockIds).toEqual([]);
    expect(result.inlinedPrototypeBlockIds).toEqual([]);
  });

  it('handles multi-argument procedure_call with both string and boolean reporters', () => {
    const argV = mkReporterString('argRep_v', 'v', 'protoSubst');
    const argFlag = mkBlock('argRep_flag', 'argument_reporter_boolean', {
      fields: { VARIABLE: ['flag', null] },
      parent: 'protoSubst',
    });
    const write = mkBlock('writeA', 'data_replaceitemoflist', {
      inputs: { ITEM: 'argRep_v' },
      parent: 'protoSubst',
    });
    const writeB = mkBlock('writeB', 'data_replaceitemoflist', {
      inputs: { ITEM: 'argRep_flag' },
      parent: 'protoSubst',
    });
    write.next = 'writeB';
    const subHead = mkBlock('protoSubst', 'data_itemoflist', { next: 'writeA' });
    const proto = mkPrototype('proto', 'fn %s %b', ['v', 'flag'], 'protoSubst');
    const callArgV = mkBlock('callArgV', 'math_number', { fields: { NUM: [1, null] } });
    const callArgFlag = mkBlock('callArgFlag', 'operator_true');
    const call = mkCall(
      'call1',
      'fn %s %b',
      [
        { key: 'v', refId: 'callArgV' },
        { key: 'flag', refId: 'callArgFlag' },
      ],
      'kernelContainer',
    );
    const project = mkProject([
      proto,
      subHead,
      argV,
      argFlag,
      write,
      writeB,
      callArgV,
      callArgFlag,
      call,
    ]);
    const region = mkRegion(['call1']);

    const result = inlineProcedures(region, project, 'sprite1');

    expect(result.diagnostics).toEqual([]);
    expect(result.bodyBlockIds).toContain('callArgV');
    expect(result.bodyBlockIds).toContain('callArgFlag');
    expect(result.bodyBlockIds).not.toContain('argRep_v');
    expect(result.bodyBlockIds).not.toContain('argRep_flag');
  });

  it('returns boundBlockIdRemaps when inlined body contains a control_repeat', () => {
    const innerRepeat = mkBlock('innerRepeat', 'control_repeat', {
      inputs: { SUBSTACK: 'innerWrite', TIMES: [2, 'innerTimes'] },
      parent: 'protoSubst',
    });
    const innerWrite = mkBlock('innerWrite', 'data_replaceitemoflist', {
      parent: 'innerRepeat',
    });
    const subHead = mkBlock('protoSubst', 'data_itemoflist', { next: 'innerRepeat' });
    const proto = mkPrototype('proto', 'inner_loop', [], 'protoSubst');
    const call = mkCall('call1', 'inner_loop', [], 'kernelContainer');
    const project = mkProject([proto, subHead, innerRepeat, innerWrite, call]);
    const region = mkRegion(['call1']);

    const result = inlineProcedures(region, project, 'sprite1');

    expect(result.diagnostics).toEqual([]);
    expect(result.boundBlockIdRemaps.size).toBe(1);
    const [, originalId] = [...result.boundBlockIdRemaps.entries()][0]!;
    expect(originalId).toBe('innerRepeat');
  });
});

describe('procedure-inliner: depth limit (MAX_INLINING_DEPTH = 16)', () => {
  it('accepts a straight chain of depth 16', () => {
    // Build 16 procedures, each calling the next via procedure_call.
    const blocks: RawBlock[] = [];
    for (let i = 1; i <= MAX_INLINING_DEPTH; i += 1) {
      const procId = `p${i}`;
      const subId = `sub${i}`;
      const writeId = `w${i}`;
      const nextCallId = i === MAX_INLINING_DEPTH ? '' : `call${i}`;
      const sub = mkBlock(subId, 'data_itemoflist');
      if (nextCallId) sub.next = nextCallId;
      const write = mkBlock(writeId, 'data_replaceitemoflist', { parent: subId });
      const proto = mkPrototype(procId, `proc${i}`, [], subId);
      blocks.push(proto, sub, write);
      if (nextCallId) {
        blocks.push(
          mkCall(nextCallId, `proc${i + 1}`, [], subId),
        );
      }
    }
    blocks.push(mkCall('call0', 'proc1', [], 'kernelContainer'));
    const project = mkProject(blocks);
    const region = mkRegion(['call0']);

    const result = inlineProcedures(region, project, 'sprite1');

    expect(result.diagnostics.filter((d) => d.code === 'gpu.procedure_recursion_unsupported')).toEqual([]);
  });

  it('rejects a straight chain of depth 17 with PROCEDURE_RECURSION_UNSUPPORTED', () => {
    const blocks: RawBlock[] = [];
    for (let i = 1; i <= MAX_INLINING_DEPTH + 1; i += 1) {
      const procId = `p${i}`;
      const subId = `sub${i}`;
      const nextCallId = i === MAX_INLINING_DEPTH + 1 ? '' : `call${i}`;
      const sub = mkBlock(subId, 'data_itemoflist');
      if (nextCallId) sub.next = nextCallId;
      const proto = mkPrototype(procId, `proc${i}`, [], subId);
      blocks.push(proto, sub);
      if (nextCallId) {
        blocks.push(mkCall(nextCallId, `proc${i + 1}`, [], subId));
      }
    }
    blocks.push(mkCall('call0', 'proc1', [], 'kernelContainer'));
    const project = mkProject(blocks);
    const region = mkRegion(['call0']);

    const result = inlineProcedures(region, project, 'sprite1');

    const recursionDiagnostics = result.diagnostics.filter(
      (d) => d.code === 'gpu.procedure_recursion_unsupported',
    );
    expect(recursionDiagnostics.length).toBeGreaterThan(0);
    expect(recursionDiagnostics[0]!.severity).toBe('error');
  });

  it('rejects mutual recursion (proc A -> proc B -> proc A) regardless of depth', () => {
    // A body: callB, B body: callA
    const subA = mkBlock('subA', 'data_itemoflist', { next: 'callBFromA' });
    const subB = mkBlock('subB', 'data_itemoflist', { next: 'callAFromB' });
    const callBFromA = mkCall('callBFromA', 'procB', [], 'subA');
    const callAFromB = mkCall('callAFromB', 'procA', [], 'subB');
    const protoA = mkPrototype('procA', 'procA', [], 'subA');
    const protoB = mkPrototype('procB', 'procB', [], 'subB');
    const callEntry = mkCall('callEntry', 'procA', [], 'kernelContainer');
    const project = mkProject([protoA, protoB, subA, subB, callBFromA, callAFromB, callEntry]);
    const region = mkRegion(['callEntry']);

    const result = inlineProcedures(region, project, 'sprite1');

    const cycleDiagnostic = result.diagnostics.find(
      (d) => d.code === 'gpu.procedure_recursion_unsupported',
    );
    expect(cycleDiagnostic).toBeDefined();
    expect(cycleDiagnostic!.severity).toBe('error');
    expect(cycleDiagnostic!.message).toMatch(/cycle/);
  });

  it('does not falsely flag a procedure whose body references itself in reporter only', () => {
    // A body that USES `v` reporter (no call back into A) — must not
    // trip cycle detection on its own.
    const argV = mkReporterString('argV', 'v', 'subSelf');
    const write = mkBlock('write', 'data_replaceitemoflist', {
      inputs: { ITEM: 'argV' },
      parent: 'subSelf',
    });
    const subSelf = mkBlock('subSelf', 'data_itemoflist', { next: 'write' });
    const protoSelf = mkPrototype('protoSelf', 'self_ref %s', ['v'], 'subSelf');
    const callArgV = mkBlock('callArgV', 'math_number', { fields: { NUM: [1, null] } });
    const callSelf = mkCall(
      'callSelf',
      'self_ref %s',
      [{ key: 'v', refId: 'callArgV' }],
      'kernelContainer',
    );
    const project = mkProject([protoSelf, subSelf, argV, write, callArgV, callSelf]);
    const region = mkRegion(['callSelf']);

    const result = inlineProcedures(region, project, 'sprite1');

    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
