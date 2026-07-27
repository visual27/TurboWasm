import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVendoredScratchVm } from '../utils/vendored-scratch-vm';

/**
 * Phase 3 — Limited compiler-time constant folding. The patch adds
 * `IROptimizer.tryFoldConstant` (= `vendored/scratch-vm/src/compiler/iroptimizer.js`)
 * which replaces 11 opcodes with their precomputed value when both
 * operands are compile-time `CONSTANT`s with a safe type bitset:
 *
 *   - `OP_NOT` / `OP_AND` / `OP_OR`     → fold into CONSTANT (boolean)
 *   - `OP_ADD` / `OP_SUB` / `OP_MUL` / `OP_DIV` → fold into CONSTANT (numeric)
 *   - `OP_EQUALS` / `OP_LESS` / `OP_GREATER` → fold into CONSTANT (boolean)
 *   - `OP_JOIN`                          → fold into CONSTANT (string)
 *
 * This test pins each fold candidate against the legacy
 * `IROptimizer.optimizeInput` (= which does NOT fold) by hand-building
 * IR nodes from `IntermediateInput` and asserting that the new
 * `tryFoldConstant` returns a `CONSTANT` node with the expected
 * value + type bitset. The negative cases (`OP_RANDOM`, mixed
 * STRING_NUM, `VAR_GET`, runtime gate = false) confirm the
 * fold path short-circuits correctly.
 *
 * The constructor signature is `(ir, target?)`. Without a `target`
 * (= callers that pre-date Phase 3) the gate returns false and no
 * fold happens; with a `target` whose `runtime.compilerOptions.constantFoldingEnabled`
 * is false the gate also returns false.
 */

// Local copy of the enum names so the test stays decoupled from
// `vendored/scratch-vm/src/compiler/enums.js` (= not exported).
const InputOpcode = {
  CONSTANT: 'constant',
  OP_NOT: 'op.not',
  OP_AND: 'op.and',
  OP_OR: 'op.or',
  OP_ADD: 'op.add',
  OP_SUBTRACT: 'op.subtract',
  OP_MULTIPLY: 'op.multiply',
  OP_DIVIDE: 'op.divide',
  OP_EQUALS: 'op.equals',
  OP_LESS: 'op.less',
  OP_GREATER: 'op.greater',
  OP_JOIN: 'op.join',
  VAR_GET: 'var.get',
};

const InputType = {
  NUMBER_POS_INT: 0x002,
  NUMBER_ZERO: 0x008,
  NUMBER_NEG_ZERO: 0x010,
  NUMBER_NEG_INT: 0x020,
  NUMBER_POS_INF: 0x001,
  NUMBER_NEG_INF: 0x080,
  NUMBER_NAN: 0x100,
  NUMBER: 0x0ff,
  NUMBER_OR_NAN: 0x1ff,
  STRING: 0xe00,
  BOOLEAN: 0x1000,
};

// Mirror of vendored scratch-vm's IntermediateInput.getNumberInputType.
// The actual helper lives in `vendored/scratch-vm/src/compiler/intermediate.js`
// but we re-implement it here so the test stays independent of the
// vendored tree's load order.
function getNumberInputType(n: number) {
  if (typeof n !== 'number') throw new Error('expected number');
  if (n === Infinity) return InputType.NUMBER_POS_INF;
  if (n === -Infinity) return InputType.NUMBER_NEG_INF;
  if (n < 0) return Number.isInteger(n) ? InputType.NUMBER_NEG_INT : 0x040 /* NUMBER_NEG_FRACT */;
  if (n > 0) return Number.isInteger(n) ? InputType.NUMBER_POS_INT : 0x004 /* NUMBER_POS_FRACT */;
  if (Number.isNaN(n)) return InputType.NUMBER_NAN;
  if (Object.is(n, -0)) return InputType.NUMBER_NEG_ZERO;
  return InputType.NUMBER_ZERO;
}

// Mirror of IntermediateInput. Re-implemented here so the test
// doesn't have to reach into `vendored/scratch-vm/src/compiler/intermediate.js`
// (= CommonJS, awkward to require from a Vitest ESM context).
class II {
  opcode: string;
  type: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputs: Record<string, any>;
  constructor(opcode: string, type: number, inputs: Record<string, unknown>) {
    this.opcode = opcode;
    this.type = type;
    this.inputs = inputs;
  }
  isAlwaysType(t: number): boolean {
    return (this.type & t) === this.type;
  }
  isSometimesType(t: number): boolean {
    return (this.type & t) !== 0;
  }
}

function constantOf(value: unknown, type: number): II {
  return new II(InputOpcode.CONSTANT, type, { value });
}

function buildOptimizer(
  vm: { iroptimizer: { IROptimizer: new (...args: unknown[]) => unknown } },
  { constantFoldingEnabled = true } = {},
): {
  shouldFoldConstant(input: II): boolean;
  tryFoldConstant(input: II): unknown;
  optimizeInput(input: II, state: unknown): unknown;
} {
  // The optimizer is constructed with a `target` reference so the
  // gate consults `runtime.compilerOptions.constantFoldingEnabled`.
  // The actual fold pass is exercised directly via `tryFoldConstant`
  // — we don't need to wire up a full IR for these unit tests.
  const target = {
    runtime: {
      compilerOptions: { constantFoldingEnabled },
    },
  };
  return new vm.iroptimizer.IROptimizer({ entry: {}, procedures: {} }, target) as {
  shouldFoldConstant(input: II): boolean;
  tryFoldConstant(input: II): unknown;
  optimizeInput(input: II, state: unknown): unknown;
};
}

/**
 * Helper that narrows `II | null` to `II` so the downstream
 * `.opcode` / `.type` / `.inputs.value` accesses type-check
 * without a non-null assertion (`folded!.opcode`) on every line.
 */
function expectFolded(folded: II | null): II {
  expect(folded).not.toBeNull();
  // Non-null is asserted above; TS just needs a hint.
  return folded as II;
}

describe('Phase 3 — IROptimizer.tryFoldConstant (limited fold)', () => {
  const vm = loadVendoredScratchVm();
  if (!vm) {
    it.skip('vendored scratch-vm missing; run `npm run setup` to enable the unit bridge', () => {});
    return;
  }

  // ---- boolean fold: OP_NOT / OP_AND / OP_OR ------------------------

  it('OP_NOT(CONST(true)) folds to CONST(false) with BOOLEAN type', () => {
    const optimizer = buildOptimizer(vm);
    const operand = constantOf(true, InputType.BOOLEAN);
    const op = new II(InputOpcode.OP_NOT, InputType.BOOLEAN, { operand });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.opcode).toBe(InputOpcode.CONSTANT);
    expect(folded.inputs.value).toBe(false);
    expect(folded.type).toBe(InputType.BOOLEAN);
  });

  it('OP_NOT(CONST("")) folds to CONST(true) via Cast.toBoolean', () => {
    const optimizer = buildOptimizer(vm);
    const operand = constantOf('', InputType.STRING);
    const op = new II(InputOpcode.OP_NOT, InputType.BOOLEAN, { operand });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(true);
  });

  it('OP_AND(CONST(true), CONST(false)) folds to CONST(false)', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(true, InputType.BOOLEAN);
    const right = constantOf(false, InputType.BOOLEAN);
    const op = new II(InputOpcode.OP_AND, InputType.BOOLEAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(false);
    expect(folded.type).toBe(InputType.BOOLEAN);
  });

  it('OP_OR(CONST("0"), CONST(1)) folds via Cast.toBoolean (= 0 is false)', () => {
    // Cast.toBoolean("0") === false, Cast.toBoolean(1) === true → true.
    const optimizer = buildOptimizer(vm);
    const left = constantOf('0', InputType.STRING);
    const right = constantOf(1, InputType.NUMBER);
    const op = new II(InputOpcode.OP_OR, InputType.BOOLEAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(true);
  });

  // ---- numeric fold: OP_ADD / OP_SUB / OP_MUL / OP_DIV --------------

  it('OP_ADD(2, 3) folds to CONST(5) with NUMBER_POS_INT type', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(2, getNumberInputType(2));
    const right = constantOf(3, getNumberInputType(3));
    const op = new II(InputOpcode.OP_ADD, InputType.NUMBER_OR_NAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(5);
    expect(folded.type).toBe(InputType.NUMBER_POS_INT);
  });

  it('OP_ADD(Infinity, -Infinity) folds to CONST(NaN) with NUMBER_NAN type', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(Infinity, InputType.NUMBER_POS_INF);
    const right = constantOf(-Infinity, InputType.NUMBER_NEG_INF);
    const op = new II(InputOpcode.OP_ADD, InputType.NUMBER_OR_NAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(Number.isNaN(folded.inputs.value)).toBe(true);
    expect(folded.type).toBe(InputType.NUMBER_NAN);
  });

  it('OP_MUL(Infinity, 0) folds to CONST(NaN) — preserves IEEE-754 rule', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(Infinity, InputType.NUMBER_POS_INF);
    const right = constantOf(0, InputType.NUMBER_ZERO);
    const op = new II(InputOpcode.OP_MULTIPLY, InputType.NUMBER_OR_NAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(Number.isNaN(folded.inputs.value)).toBe(true);
    expect(folded.type).toBe(InputType.NUMBER_NAN);
  });

  it('OP_DIV(1, 0) folds to CONST(Infinity) with NUMBER_POS_INF type', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(1, getNumberInputType(1));
    const right = constantOf(0, InputType.NUMBER_ZERO);
    const op = new II(InputOpcode.OP_DIVIDE, InputType.NUMBER_OR_NAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(Infinity);
    expect(folded.type).toBe(InputType.NUMBER_POS_INF);
  });

  it('OP_DIV(-1, 0) folds to CONST(-Infinity) with NUMBER_NEG_INF type', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(-1, getNumberInputType(-1));
    const right = constantOf(0, InputType.NUMBER_ZERO);
    const op = new II(InputOpcode.OP_DIVIDE, InputType.NUMBER_OR_NAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(-Infinity);
    expect(folded.type).toBe(InputType.NUMBER_NEG_INF);
  });

  it('OP_DIV(0, 0) folds to CONST(NaN) — preserves IEEE-754 rule', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(0, InputType.NUMBER_ZERO);
    const right = constantOf(0, InputType.NUMBER_ZERO);
    const op = new II(InputOpcode.OP_DIVIDE, InputType.NUMBER_OR_NAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(Number.isNaN(folded.inputs.value)).toBe(true);
    expect(folded.type).toBe(InputType.NUMBER_NAN);
  });

  it('OP_SUB(0, -0) folds to CONST(0) preserving -0 sign via Object.is', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(0, InputType.NUMBER_ZERO);
    // Note: scratch-vm's `constantFoldingEnabled` doesn't preserve
    // -0 in the literal input (JSON has no -0), but the JS result of
    // `0 - (-0)` is `0`, so the fold result is `NUMBER_ZERO`.
    const right = constantOf(-0, InputType.NUMBER_NEG_ZERO);
    const op = new II(InputOpcode.OP_SUBTRACT, InputType.NUMBER_OR_NAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(Object.is(folded.inputs.value, 0)).toBe(true);
    expect(folded.type).toBe(InputType.NUMBER_ZERO);
  });

  // ---- comparison fold: OP_EQUALS / OP_LESS / OP_GREATER ------------

  it('OP_EQUALS("5", 5) folds to CONST(true) via Cast.compare', () => {
    // Scratch equality is type-coercing; Cast.compare("5", 5) === 0
    // (= true). This is the canonical "scratch semantics" assertion.
    const optimizer = buildOptimizer(vm);
    const left = constantOf('5', InputType.STRING);
    const right = constantOf(5, getNumberInputType(5));
    const op = new II(InputOpcode.OP_EQUALS, InputType.BOOLEAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(true);
    expect(folded.type).toBe(InputType.BOOLEAN);
  });

  it('OP_LESS(1, 2) folds to CONST(true)', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(1, getNumberInputType(1));
    const right = constantOf(2, getNumberInputType(2));
    const op = new II(InputOpcode.OP_LESS, InputType.BOOLEAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(true);
  });

  it('OP_GREATER("apple", "banana") folds to CONST(false) (case-insensitive string compare)', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf('apple', InputType.STRING);
    const right = constantOf('banana', InputType.STRING);
    const op = new II(InputOpcode.OP_GREATER, InputType.BOOLEAN, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe(false);
  });

  // ---- string fold: OP_JOIN -----------------------------------------

  it('OP_JOIN("foo", "bar") folds to CONST("foobar") with STRING type', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf('foo', InputType.STRING);
    const right = constantOf('bar', InputType.STRING);
    const op = new II(InputOpcode.OP_JOIN, InputType.STRING, { left, right });
    const folded = expectFolded(optimizer.tryFoldConstant(op) as II | null);
    expect(folded.inputs.value).toBe('foobar');
    expect(folded.type).toBe(InputType.STRING);
  });

  // ---- negative cases ------------------------------------------------

  it('OP_ADD(2, "foo") does NOT fold — STRING_NUM operand protects the + concat rule', () => {
    // STRING_NUM (type 0x200) is sometimes a string (isSometimesType(STRING)),
    // so `bothPurelyNumeric` rejects the fold. The runtime keeps
    // `2 + "foo" = "2foo"`.
    const optimizer = buildOptimizer(vm);
    const left = constantOf(2, getNumberInputType(2));
    const right = constantOf('foo', InputType.STRING);
    const op = new II(InputOpcode.OP_ADD, InputType.NUMBER_OR_NAN, { left, right });
    const folded = optimizer.tryFoldConstant(op) as II | null;
    expect(folded).toBeNull();
  });

  it('OP_RANDOM(...) is not in the fold set — returns null', () => {
    // Sanity: random opcodes are not handled at all by tryFoldConstant.
    const optimizer = buildOptimizer(vm);
    const op = new II('op.random', InputType.NUMBER, {
      from: constantOf(1, getNumberInputType(1)),
      to: constantOf(10, getNumberInputType(10)),
    });
    const folded = optimizer.tryFoldConstant(op) as II | null;
    expect(folded).toBeNull();
  });

  it('OP_ADD with VAR_GET operand does NOT fold — variable ref breaks the constant pair', () => {
    const optimizer = buildOptimizer(vm);
    const left = constantOf(1, getNumberInputType(1));
    const right = new II(InputOpcode.VAR_GET, InputType.NUMBER, { variable: { id: 'x' } });
    const op = new II(InputOpcode.OP_ADD, InputType.NUMBER_OR_NAN, { left, right });
    const folded = optimizer.tryFoldConstant(op) as II | null;
    expect(folded).toBeNull();
  });

  it('does NOT fold when the runtime gate is OFF (constantFoldingEnabled = false)', () => {
    // Drive through `optimizeInput` (= the actual call site) so the
    // gate check inside `shouldFoldConstant` is honored. Direct calls
    // to `tryFoldConstant` bypass the gate by design (= the gate is
    // owned by `optimizeInput`, not by the fold pass itself).
    const optimizer = buildOptimizer(vm, { constantFoldingEnabled: false });
    const left = constantOf(2, getNumberInputType(2));
    const right = constantOf(3, getNumberInputType(3));
    const op = new II(InputOpcode.OP_ADD, InputType.NUMBER_OR_NAN, { left, right });
    // `optimizeInput` requires a TypeState for the recursive walk;
    // for an operator-only input the state is irrelevant.
    const state = { variables: Object.create(null) };
    const folded = optimizer.optimizeInput(op, state) as II;
    expect(folded.opcode).toBe(InputOpcode.OP_ADD);
    expect(folded.inputs.left).toBe(left);
    expect(folded.inputs.right).toBe(right);
  });

  it('does NOT fold when the optimizer was constructed without a target (backward compat)', () => {
    // No `target` argument → `this.target` is null → `shouldFoldConstant` is false.
    const optimizer = new vm.iroptimizer.IROptimizer({ entry: {}, procedures: {} });
    const left = constantOf(2, getNumberInputType(2));
    const right = constantOf(3, getNumberInputType(3));
    const op = new II(InputOpcode.OP_ADD, InputType.NUMBER_OR_NAN, { left, right });
    const state = { variables: Object.create(null) };
    const folded = optimizer.optimizeInput(op, state) as II;
    expect(folded.opcode).toBe(InputOpcode.OP_ADD);
    expect(folded.inputs.left).toBe(left);
    expect(folded.inputs.right).toBe(right);
  });

  // ---- source-level markers (companion to scratch-vm-patches-symbols) ----

  it('vendored iroptimizer.js carries the constant-folding marker', () => {
    const iroptimizerPath = resolve(
      process.cwd(),
      'vendored/scratch-vm/src/compiler/iroptimizer.js',
    );
    if (!existsSync(iroptimizerPath)) return;
    const text = readFileSync(iroptimizerPath, 'utf8');
    expect(text).toContain('// TurboWasm: constant-folding');
  });

  it('vendored runtime.js compilerOptions carries constantFoldingEnabled = true', () => {
    const runtimePath = resolve(
      process.cwd(),
      'vendored/scratch-vm/src/engine/runtime.js',
    );
    if (!existsSync(runtimePath)) return;
    const text = readFileSync(runtimePath, 'utf8');
    expect(text).toContain('constantFoldingEnabled: true');
  });

  it('compile.js forwards thread.target to the new IROptimizer(ir, target)', () => {
    const compilePath = resolve(
      process.cwd(),
      'vendored/scratch-vm/src/compiler/compile.js',
    );
    if (!existsSync(compilePath)) return;
    const text = readFileSync(compilePath, 'utf8');
    expect(text).toContain('new IROptimizer(ir, thread.target)');
  });

  // ---- Phase 3 follow-up: NaN / -0 emit guard ----
  //
  // Regression target: pre-patch, the JSGenerator CONSTANT case did
  // not handle NUMBER_NAN (= 0x100) or NUMBER_NEG_ZERO (= 0x010)
  // types — both fail `isAlwaysType(NUMBER)` because neither bit is
  // a subset of NUMBER (= 0x0ff). The fold pass produces these types
  // for `0 / 0 = NaN` and `-0 - 0 = -0`; without the explicit cases
  // added by the `// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler`
  // hunk, the compiled script throws "JS: Unknown constant input
  // type '256'" (or '16') and the project fails to run. The probes
  // below pin (a) the source marker, (b) the vendored UMD marker,
  // and (c) the emit-shaped sibling case in the type branch order
  // (= the NUMBER_NAN branch is checked before BOOLEAN).

  it('vendored jsgen.js carries the NaN / -0 emit marker', () => {
    const jsgenPath = resolve(
      process.cwd(),
      'vendored/scratch-vm/src/compiler/jsgen.js',
    );
    if (!existsSync(jsgenPath)) return;
    const text = readFileSync(jsgenPath, 'utf8');
    expect(text).toContain(
      '// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler',
    );
  });

  it('vendored UMD carries the NaN / -0 emit marker (post-rebuild)', () => {
    const umdPath = resolve(
      process.cwd(),
      'vendored/scaffolding/dist/scaffolding-min.js',
    );
    if (!existsSync(umdPath)) return;
    const text = readFileSync(umdPath, 'utf8');
    expect(text).toContain(
      '// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler',
    );
  });

  it('jsgen.js CONSTANT case handles NUMBER_NAN and NUMBER_NEG_ZERO branches', () => {
    // Source-level probe: the patched jsgen.js must contain the
    // `isAlwaysType(InputType.NUMBER_NAN)` and `isAlwaysType(InputType.NUMBER_NEG_ZERO)`
    // branches in the CONSTANT case. Without these the fold would
    // produce a constant the JSGenerator cannot emit.
    const jsgenPath = resolve(
      process.cwd(),
      'vendored/scratch-vm/src/compiler/jsgen.js',
    );
    if (!existsSync(jsgenPath)) return;
    const text = readFileSync(jsgenPath, 'utf8');
    expect(text).toMatch(/isAlwaysType\(InputType\.NUMBER_NAN\)/u);
    expect(text).toMatch(/isAlwaysType\(InputType\.NUMBER_NEG_ZERO\)/u);
    // The literal emit strings must be `'NaN'` and `'-0'`. The existing
    // NUMBER branch already handles `-0` via `Object.is(value, -0)`,
    // but the new branches are required for the type-bit-set path.
    expect(text).toMatch(/return\s+'NaN'/u);
    expect(text).toMatch(/return\s+'-0'/u);
  });
});