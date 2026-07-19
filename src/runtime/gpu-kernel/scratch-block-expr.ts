/**
 * Phase 2 (nested-parallelization-03-phase2 §3.2) — scratch block chain
 * → WGSL expression 逆変換器。
 *
 * `fn expo` の nested DSL で implicit axis formula を組み立てるために、
 * `control_repeat` の `inputs.TIMES` (= loop count formula) shadow chain
 * を WGSL expression 文字列に変換する。Phase 2 では仕様 §3.2 の最小集合
 * のみ実装する:
 *
 *   - `math_number` / `math_integer`        → literal
 *   - `math_positive_number` / `math_negativenumber` → `(expr)` / `-(expr)`
 *   - `operator_add` / `operator_subtract` / `operator_multiply` → `(a op b)`
 *   - `operator_divide`                      → `scratch_div(a, b)`
 *   - `operator_mod`                         → `scratch_mod(a, b)`
 *   - `data_itemoflist`                      → `scratch_list_read_f32(&<storage>, scratch_index_clamp(<idx>, <len>), <len>)`
 *   - `data_variableof`                      → scalarBindings 経由で解決
 *
 * 未対応 opcode は `null` を返す (= D2 demote 経路で sequential に降格)。
 *
 * Phase 3 で `@bind ..., scalar` サポートが入る際、Phase 3 で
 * `ScalarUniformBinding` 型を導入し `scalarBindings` に渡す。Phase 2 では
 * 空配列を渡し、`data_variableof` は常に `null` を返す (= `@repeat Rx =
 * aabb_tmp0` のような scratch variable 参照は sequential に降格、これは
 * Phase 3 完了で通る)。
 */
import type { BindDirective, ParsedDirective, RawBlock } from './types';

export interface ScratchBlockExprContext {
  /**
   * `@bind` で宣言された scratch list 名 → WGSL storage 名 (= renameTable
   * 経由)。`data_itemoflist` の `fields.LIST` を解決するために使用。
   */
  bindingNameBySurface: Map<string, string>;
  /**
   * `@bind ..., scalar` 宣言 (= Phase 3) から生成された scratch variable
   * name → WGSL struct field 名。`data_variableof` の解決用。Phase 2 では
   * 空配列を渡す。
   */
  scalarBindings: readonly ScalarUniformBindingLike[];
  /**
   * Phase E+ で生成された rename table (surface name → emit name)。
   * bindingNameBySurface の lookup に利用する。
   */
  renameTable: Readonly<Record<string, string>>;
}

/**
 * Phase 3 で導入予定の `ScalarUniformBinding` 型の最小限の structural
 * subset。Phase 2 ではこの interface だけを参照し、具象型は未実装。
 * Phase 3 で import 経路を実型に切り替える。
 */
export interface ScalarUniformBindingLike {
  /** scratch variable name (e.g. 'aabb_idx0', 'screen_w'). */
  name: string;
  /** WGSL struct field name (e.g. 'aabb_idx0', 'screen_w'). */
  wgslName: string;
  /** Scalar dtype ('f32' | 'i32'). */
  dtype: 'f32' | 'i32';
}

const MAX_RECURSION_DEPTH = 32;

/**
 * Build a `ScratchBlockExprContext` from parsed directives + rename table.
 *
 * - `bindingNameBySurface` は `@bind` (Phase E+ で `internalName` を持つ
 *   quoted name も含む) を surface name → emit WGSL name でマップする。
 * - `scalarBindings` は caller が `@bind ..., scalar` から構築して渡す
 *   (Phase 2 では `[]` で OK)。
 */
export function buildScratchBlockExprContext(
  directives: readonly ParsedDirective[],
  renameTable: Readonly<Record<string, string>>,
  scalarBindings: readonly ScalarUniformBindingLike[] = [],
): ScratchBlockExprContext {
  const bindingNameBySurface = new Map<string, string>();
  for (const d of directives) {
    if (d.kind !== 'bind') continue;
    const wgslName = renameTable[d.name] ?? d.name;
    bindingNameBySurface.set(d.name, wgslName);
  }
  return {
    bindingNameBySurface,
    scalarBindings,
    renameTable,
  };
}

/**
 * Convert a scratch block (typically a `control_repeat.inputs.TIMES` shadow
 * chain) into a WGSL expression string.
 *
 * Returns `null` when the block's opcode is not in the supported set, or
 * when recursion depth exceeds `MAX_RECURSION_DEPTH`. Callers (typically
 * `collectImplicitAxes`) treat `null` as "axis demotes to sequential" and
 * emit `gpu.implicit_axis_unsupported` warn diagnostic.
 */
export function scratchBlockToWgslExpr(
  block: RawBlock,
  blocks: Record<string, RawBlock>,
  context: ScratchBlockExprContext,
  depth: number = 0,
): string | null {
  if (depth > MAX_RECURSION_DEPTH) return null;

  switch (block.opcode) {
    case 'math_number':
    case 'math_integer': {
      const raw = literalToString(block.fields['NUM']);
      return raw;
    }
    case 'math_whole_number':
    case 'math_angle':
    case 'math_positive_number': {
      const raw = literalToString(block.fields['NUM']);
      return raw === null ? null : `(${raw})`;
    }
    case 'math_negativenumber': {
      const inner = resolveInput(block, 'NUM', blocks);
      if (!inner) return null;
      const expr = scratchBlockToWgslExpr(inner, blocks, context, depth + 1);
      return expr === null ? null : `-(${expr})`;
    }
    case 'operator_add':
    case 'operator_subtract':
    case 'operator_multiply':
    case 'operator_divide':
    case 'operator_mod':
      return binaryOp(block, blocks, context, depth);

    case 'data_variableof':
      return resolveVariableReference(block, context);

    case 'data_itemoflist':
      return resolveItemOfList(block, blocks, context, depth);

    default:
      return null;
  }
}

// --- helpers --------------------------------------------------------------

function binaryOp(
  block: RawBlock,
  blocks: Record<string, RawBlock>,
  context: ScratchBlockExprContext,
  depth: number,
): string | null {
  const opMap: Record<string, string> = {
    operator_add: '+',
    operator_subtract: '-',
    operator_multiply: '*',
    operator_divide: 'scratch_div',
    operator_mod: 'scratch_mod',
  };
  const op = opMap[block.opcode];
  if (!op) return null;
  const left = resolveInput(block, 'NUM1', blocks);
  const right = resolveInput(block, 'NUM2', blocks);
  if (!left || !right) return null;
  const le = scratchBlockToWgslExpr(left, blocks, context, depth + 1);
  const re = scratchBlockToWgslExpr(right, blocks, context, depth + 1);
  if (le === null || re === null) return null;
  if (op === 'scratch_div') return `scratch_div(${le}, ${re})`;
  if (op === 'scratch_mod') return `scratch_mod(${le}, ${re})`;
  return `(${le} ${op} ${re})`;
}

/**
 * Resolve `data_variableof` → WGSL expression.
 *
 * Priority (Phase 2 + Phase 3 互換):
 *   1. `scalarBindings` (= `@bind ..., scalar`) に name 一致があれば
 *      `u_scratch.<wgsl_name>` を返す (= scalar uniform)。
 *   2. `bindingNameBySurface` (= `@bind` list) に name 一致があれば
 *      `&<storage>` を返す (e.g. `len(my_list)` の `my_list` sugar 経由)。
 *   3. どちらも無ければ `null` (Phase 2 ではここに必ず落ちる。Phase 3 で
 *      scalarBindings に binding を追加すれば通る)。
 */
function resolveVariableReference(
  block: RawBlock,
  context: ScratchBlockExprContext,
): string | null {
  const varName = extractStringField(block.fields['VARIABLE']);
  if (!varName) return null;

  const scalarMatch = context.scalarBindings.find((b) => b.name === varName);
  if (scalarMatch) return `u_scratch.${scalarMatch.wgslName}`;

  const listStorage = context.bindingNameBySurface.get(varName);
  if (listStorage) return `&${listStorage}`;

  return null;
}

/**
 * Resolve `data_itemoflist(LIST=L, INDEX=I)` → WGSL expression.
 *
 * - `LIST` (field) が `@bind` に登録されていれば `&<storage>` を使う。
 * - `INDEX` (input) は再帰的に scratchBlockToWgslExpr で逆変換。
 * - `dtype` は Phase 2 では f32 固定 (= legacy fixture と fn expo が f32)。
 *   Phase 3 で byte / i32 dtype をサポートする場合はここで分岐。
 */
function resolveItemOfList(
  block: RawBlock,
  blocks: Record<string, RawBlock>,
  context: ScratchBlockExprContext,
  depth: number,
): string | null {
  const listName = extractStringField(block.fields['LIST']);
  const indexInput = resolveInput(block, 'INDEX', blocks);
  if (!listName || !indexInput) return null;
  const indexExpr = scratchBlockToWgslExpr(indexInput, blocks, context, depth + 1);
  if (indexExpr === null) return null;
  const storageName = context.bindingNameBySurface.get(listName);
  if (!storageName) return null;
  const lengthName = `u_scratch.${storageName}_length`;
  return `scratch_list_read_f32(&${storageName}, scratch_index_clamp(${indexExpr}, ${lengthName}), ${lengthName})`;
}

/**
 * Resolve a scratch-vm `inputs.<key>` reference to its block. The reference
 * can be either a bare block-id string or a shadow tuple
 * `[1, blockId]` / `[2, blockId]`. Returns `null` when the slot is empty
 * or the referenced block is missing.
 */
function resolveInput(
  block: RawBlock,
  key: string,
  blocks: Record<string, RawBlock>,
): RawBlock | null {
  const input = block.inputs[key];
  if (input === undefined || input === null) return null;
  const blockId = extractBlockIdFromInput(input);
  if (!blockId) return null;
  return blocks[blockId] ?? null;
}

function extractBlockIdFromInput(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        return item;
      }
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
    if (value.shadow !== undefined) return extractBlockIdFromInput(value.shadow);
  }
  return null;
}

function literalToString(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') return item;
      if (Array.isArray(item)) {
        for (const inner of item) {
          if (typeof inner === 'string') return inner;
        }
      }
    }
    return null;
  }
  if (input && typeof input === 'object') {
    const value = input as { value?: unknown; text?: unknown };
    if (typeof value.value === 'string') return value.value;
    if (typeof value.text === 'string') return value.text;
  }
  return null;
}

function extractStringField(field: unknown): string | null {
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    for (const item of field) {
      if (typeof item === 'string') return item;
    }
    return null;
  }
  if (field && typeof field === 'object') {
    const value = field as { id?: unknown; name?: unknown; value?: unknown };
    if (typeof value.id === 'string') return value.id;
    if (typeof value.name === 'string') return value.name;
    if (typeof value.value === 'string') return value.value;
  }
  return null;
}

/**
 * Re-export so the bound-block-style helper from `formula-rewrite.ts` is
 * not duplicated here. BindDirective を使って surface → emit name を引く
 * helper は wgsl-emitter 側に既に存在するため、ここでは未公開。
 */
export type { BindDirective };
