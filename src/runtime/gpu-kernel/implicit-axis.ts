/**
 * Phase 2 (nested-parallelization-03-phase2 §3.3) — kernel container +
 * body 内 nested control_repeat の loop count formula から implicit axis
 * を生成する。
 *
 * 生成規則:
 *   - kernel container (RegionVerdict.blockId) → `Ry:global_y`
 *     formula = kernel container の `inputs.TIMES` chain
 *   - nestedRepeatContainerBlockIds[0] (= candidate when nested) → `Rx0:global_x`
 *   - nestedRepeatContainerBlockIds[1+]                          → `Rx1`, `Rx2`, ..., `global_x`
 *
 * legacy レイアウト (`isNested === false` = `nestedRepeatContainerBlockIds`
 * が空) では:
 *   - kernel container も candidate 自身なので、implicit axis を生成しない
 *     (= explicit `@repeat` のみが source of truth。legacy `expo-fixture.sb3`
 *     の出力 WGSL を完全互換に保つため)
 *
 * explicit drop:
 *   - ユーザーが `@repeat Ry:global_y = ...` を明示した場合、implicit Ry は
 *     生成しない (canonical key 安定性維持。`stripDirectiveVolatile` で
 *     canonical 計算から除外されているが、emitter 出力の重複を避ける)
 *
 * unsupported formula:
 *   - `scratchBlockToWgslExpr` が `null` を返した axis は
 *     `formula: ''` で push し、`gpu.implicit_axis_unsupported` warn を発火
 *   - axis-analysis.ts がこの axis を D2 demote で `finalAxis:
 *     'sequential'` に降格
 */
import { GPU_DIAGNOSTIC_CODES } from './diagnostic-codes';
import { scratchBlockToWgslExpr, type ScratchBlockExprContext } from './scratch-block-expr';
import type { Diagnostic, ImplicitAxis, ParsedDirective, RawBlock, RepeatDirective } from './types';

export interface CollectImplicitAxesResult {
  axes: ImplicitAxis[];
  diagnostics: Diagnostic[];
}

export interface CollectImplicitAxesInput {
  /** RegionVerdict.blockId (= kernel container id)。 */
  kernelContainerId: string;
  /**
   * `RegionVerdict.nestedRepeatContainerBlockIds` (Phase 0 で収集済み)。
   * legacy レイアウトでは空配列 → implicit axis 生成 skip。
   */
  nestedRepeatIds: readonly string[];
  /** Parsed project blocks (全 sprite 横断)。 */
  blocks: Record<string, RawBlock>;
  /** scratchBlockToWgslExpr 用の context。 */
  context: ScratchBlockExprContext;
  /** Diagnostic.regionId 用。 */
  regionId: string;
  /** @repeat directive 一覧 (explicit drop の判定用)。 */
  directives: readonly ParsedDirective[];
}

const KERNEL_CONTAINER_AXIS_NAME = 'Ry';
const KERNEL_CONTAINER_AXIS_TARGET: ImplicitAxis['axis'] = 'global_y';
const NESTED_REPEAT_AXIS_PREFIX = 'Rx';
const NESTED_REPEAT_AXIS_TARGET: ImplicitAxis['axis'] = 'global_x';

/**
 * Generate implicit axes from kernel container + nested repeats.
 *
 * Returns axes in dispatch order:
 *   1. `Ry:global_y` (kernel container, when nested)
 *   2. `Rx0:global_x` (candidate, when nested)
 *   3. `Rx1:global_x`, `Rx2:global_x`, ... (body 内の他の control_repeat)
 *
 * Diagnostics are returned alongside the axes; they should be forwarded to
 * `useErrorLogStore` via `RegionVerdict.diagnostics`.
 */
export function collectImplicitAxes(input: CollectImplicitAxesInput): CollectImplicitAxesResult {
  const { kernelContainerId, nestedRepeatIds, blocks, context, regionId, directives } = input;
  const axes: ImplicitAxis[] = [];
  const diagnostics: Diagnostic[] = [];

  const isNested = nestedRepeatIds.length > 0;
  if (!isNested) {
    // Legacy layout: implicit axis を生成しない。explicit `@repeat` が
    // source of truth (= 既存 `expo-fixture.sb3` の出力 WGSL 完全互換)。
    return { axes, diagnostics };
  }

  const explicitNames = collectExplicitRepeatNames(directives);

  // 1. kernel container → Ry:global_y
  const container = blocks[kernelContainerId];
  if (container) {
    const formulaExpr = deriveFormulaFromRepeat(container, blocks, context);
    if (formulaExpr !== null) {
      const name = KERNEL_CONTAINER_AXIS_NAME;
      if (!explicitNames.has(name)) {
        axes.push({
          name,
          axis: KERNEL_CONTAINER_AXIS_TARGET,
          formula: formulaExpr,
          blockId: kernelContainerId,
          source: 'kernel-container',
        });
      }
    } else {
      diagnostics.push({
        severity: 'warn',
        code: GPU_DIAGNOSTIC_CODES.IMPLICIT_AXIS_UNSUPPORTED,
        message: `kernel container's loop count formula unsupported; axis '${KERNEL_CONTAINER_AXIS_NAME}' demoted to sequential`,
        blockId: kernelContainerId,
        regionId,
      });
      // Demoted axis も push (axis-analysis に sequential 判定させるため)。
      // formula は空文字にして D2 demote を発火させる。
      if (!explicitNames.has(KERNEL_CONTAINER_AXIS_NAME)) {
        axes.push({
          name: KERNEL_CONTAINER_AXIS_NAME,
          axis: KERNEL_CONTAINER_AXIS_TARGET,
          formula: '',
          blockId: kernelContainerId,
          source: 'kernel-container',
        });
      }
    }
  }

  // 2. nested repeats → Rx0, Rx1, Rx2, ...
  for (let index = 0; index < nestedRepeatIds.length; index += 1) {
    const id = nestedRepeatIds[index];
    if (!id) continue;
    const repeatBlock = blocks[id];
    if (!repeatBlock) continue;
    const formulaExpr = deriveFormulaFromRepeat(repeatBlock, blocks, context);
    const name = `${NESTED_REPEAT_AXIS_PREFIX}${index}`;
    if (formulaExpr !== null) {
      if (!explicitNames.has(name)) {
        axes.push({
          name,
          axis: NESTED_REPEAT_AXIS_TARGET,
          formula: formulaExpr,
          blockId: id,
          source: 'nested-repeat',
        });
      }
    } else {
      diagnostics.push({
        severity: 'warn',
        code: GPU_DIAGNOSTIC_CODES.IMPLICIT_AXIS_UNSUPPORTED,
        message: `nested control_repeat's loop count formula unsupported; axis '${name}' demoted`,
        blockId: id,
        regionId,
      });
      if (!explicitNames.has(name)) {
        axes.push({
          name,
          axis: NESTED_REPEAT_AXIS_TARGET,
          formula: '',
          blockId: id,
          source: 'nested-repeat',
        });
      }
    }
  }

  return { axes, diagnostics };
}

/**
 * Convert an `ImplicitAxis` (collector output) to a `RepeatDirective`-shape
 * so it can flow through the existing `computeDispatchPlan` /
 * `renameIdentifiers` pipeline.
 */
export function axisToRepeatDirective(axis: ImplicitAxis): RepeatDirective {
  return {
    kind: 'repeat',
    name: axis.name,
    axis: axis.axis,
    formula: axis.formula,
    blockId: axis.blockId,
    line: 0,
    column: 0,
  };
}

// --- helpers --------------------------------------------------------------

/**
 * Derive WGSL expression for a `control_repeat.inputs.TIMES` shadow chain.
 *
 * Returns `null` when the TIMES slot is empty / unsupported opcode / recursion
 * depth > 32 — caller demotes the axis to sequential.
 */
function deriveFormulaFromRepeat(
  repeat: RawBlock,
  blocks: Record<string, RawBlock>,
  context: ScratchBlockExprContext,
): string | null {
  if (repeat.opcode !== 'control_repeat') return null;
  const timesInput = repeat.inputs['TIMES'];
  const blockId = extractBlockIdFromTimes(timesInput);
  if (!blockId) return null;
  const shadow = blocks[blockId];
  if (!shadow) return null;
  return scratchBlockToWgslExpr(shadow, blocks, context, 0);
}

function extractBlockIdFromTimes(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') return item;
      if (Array.isArray(item)) {
        for (const inner of item) {
          if (typeof inner === 'string') return inner;
        }
      }
      if (item && typeof item === 'object') {
        const objValue = item as { id?: unknown; block?: unknown };
        if (typeof objValue.id === 'string') return objValue.id;
        if (typeof objValue.block === 'string') return objValue.block;
      }
    }
    return null;
  }
  if (input && typeof input === 'object') {
    const value = input as { id?: unknown; block?: unknown; shadow?: unknown };
    if (typeof value.id === 'string') return value.id;
    if (typeof value.block === 'string') return value.block;
    if (value.shadow !== undefined) return extractBlockIdFromTimes(value.shadow);
  }
  return null;
}

function collectExplicitRepeatNames(directives: readonly ParsedDirective[]): Set<string> {
  const out = new Set<string>();
  for (const d of directives) {
    if (d.kind === 'repeat') out.add(d.name);
  }
  return out;
}
