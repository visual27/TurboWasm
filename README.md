# TurboWasm

A minimal, statically-deployed **SB3 viewer** built on top of [TurboWarp Scaffolding](https://github.com/TurboWarp/scaffolding). The runtime is accelerated by a WASM-SIMD collision-detection pipeline (`TurboWasm Acceleration`) with a 2-way WASM-SIMD ↔ JavaScript fallback chain. Each tier degrades gracefully on environments that do not support it.

This project is **not** a Scratch editor — it is a read-only player for `.sb3` projects.

## Features

- Drag & Drop, file picker, and Project ID loading (Scratch / Trampoline).
- TurboWarp Runtime execution via `@turbowarp/scaffolding`.
- **TurboWasm Acceleration** (see [Advanced Settings mapping](#advanced-settings-mapping)):
  - WASM SIMD batched `isTouchingColor` / `isTouchingDrawables` with per-lane perspective divide.
  - WASM-SIMD ↔ JavaScript 2-tier fallback chain plus a `Performance Mode` selector (`auto` / `force-wasm` / `legacy-only`).
- **GPU compute kernels** (`@compute` comment DSL — see [GPU compute kernel DSL](#gpu-compute-kernel-dsl)): optional WebGPU offload for `control_repeat` regions marked with `@compute`. Falls back to the JS path when WebGPU is unavailable, when a region is unsupported (D1/D2/D3 demote), or when Performance Mode is `legacy-only`. Configured via the `GPU Kernels` toggle in the TurboWasm section of the Settings dialog.
- Advanced settings (FPS, Interpolation, Warp Timer, High Quality Pen, Turbo Mode, Compiler toggle, Infinity Clones, Remove Fencing, Remove Misc Limits, Stage size, **Performance Mode**, **GPU Kernels**) with **immediate apply**.
- `twconfig` parsing from project comments (read-only).
- System / Light / Dark theme with `prefers-color-scheme` support.
- Stage-only Fullscreen mode with overlay controls.
- Project Metadata display (Title / Description / Instructions / Notes and Credits) for Project ID loads.
- Inline error log panel — no toasts or modals.
- `localStorage` persistence for theme, volume, and advanced settings (`tw-viewer:settings:v1`).
- Pluggable Extension registrar interface (add-ons reserved for future).
- Pluggable Cloud Variables provider interface (no-op default; reserved for future).

> **Retired features (v6):** The previous Settings dialog exposed a `Force WebGPU` Performance Mode and an `SVG Acceleration` dropdown (Stage 2 of the original TurboWasm plan). Both were removed because the corresponding runtime paths (`gpu-collision.ts`, `gpu-batch-renderer.ts`, `svg-acceleration/*`) were never wired beyond feature detection — the JS-side hooks always returned `null`, so the UI selectors silently fell through to the JavaScript path. See the [v6 migration notes in AGENTS.md](AGENTS.md) for details and the persisted `force-webgpu` downgrade behaviour.

## Quick start

```bash
npm install        # root deps + postinstall reapplies patches/scratch-render+0.1.0.patch
npm run setup      # clone vendored/{scaffolding,scratch-vm} + apply local patches + build (idempotent)
npm run dev        # start dev server
npm run build      # production build → dist/
npm run preview    # preview built output
npm test           # run unit tests
npm run lint       # run ESLint
npm run typecheck
```

`npm run setup` materializes `vendored/` (which is `.gitignore`'d) from the
upstream `TurboWarp/scaffolding` and `TurboWarp/scratch-vm` repos, applies the
local fork patches under `patches/vendored/`, installs its dependencies, and
runs its build. It is a no-op once `vendored/scaffolding/dist/scaffolding-min.js`
exists. To re-bootstrap from scratch, run `npm run setup -- --force`.

### Vendored scaffolding, scratch-vm & scratch-render patches

`vendored/` contains local forks of `TurboWarp/scaffolding` and
`TurboWarp/scratch-vm` (see `patches/vendored/scaffolding+0.4.0.patch` and
`patches/vendored/scratch-vm.patch`). The scratch-vm fork carries VM
hot-path optimizations consumed via `vendored/scaffolding`'s `file:../scratch-vm`
dependency link. Both patches are applied automatically by `npm run setup`.

In addition, `vendored/scaffolding/node_modules/scratch-render` carries a small
in-tree patch (`patches/scratch-render+0.1.0.patch`) that guards against the
`Failed to construct 'ImageData': The source height is zero or not a number`
DOMException thrown by `RenderWebGL.extractDrawableScreenSpace` /
`PenSkin._setCanvasSize` when a custom extension drives a drawable or the
stage into a degenerate (zero-area) state at load time. The patch is applied
automatically by the `postinstall` hook once `vendored/scaffolding/node_modules`
is in place. Re-run it manually at any time with:

```bash
npm run apply:scratch-render-patch
```

If you ever need to regenerate the patch after touching scratch-render sources,
use `npx patch-package scratch-render --cwd vendored/scaffolding` (then move
the resulting `patches/scratch-render+0.1.0.patch` to the project root if it
was generated inside `vendored/`). For the vendored scaffolding / scratch-vm
patches, regenerate from the vendored working copies with
`git -C vendored/<repo> diff > patches/vendored/<repo>.patch`.

The `wasm-collision-runtime+0.1.0.patch` install the optional WASM-SIMD
collision hooks in `RenderWebGL.isTouchingColor` /
`RenderWebGL.isTouchingDrawables`. The patch no longer carries the WebGPU
compute / instanced renderer / SVG acceleration hooks (those paths were
retired in v6).

The patches live in the source files under
`vendored/scaffolding/node_modules/scratch-render/src/`, but the runtime
loads the UMD bundle at `vendored/scaffolding/dist/scaffolding-min.js`.
`scripts/setup-vendored.mjs` re-applies the scratch-render patches to the
source tree right before calling `npm run build` inside
`vendored/scaffolding/`, so a freshly built UMD always carries the same
`// TurboWasm:` guards. To pick up a regenerated patch in the UMD, run
`npm run setup -- --force`.

The build output in `dist/` is a fully static site. Deploy the contents of `dist/` to any static host (Cloudflare Pages, GitHub Pages, Netlify, Vercel static, etc.) — no server-side runtime required.

## Architecture

```
src/
  components/   # shared UI primitives (shadcn wrappers + layout)
  features/     # feature modules (stage, settings, theme, idle, error-log, …)
  hooks/        # shared custom hooks
  stores/       # Zustand stores (settings, project, error log, player)
  lib/          # thin wrappers (persistence, validation, scaffolding loader)
  runtime/      # TurboWarp Runtime integration (player façade, twconfig, extensions, cloud-provider)
    tw-wasm/    # TurboWasm acceleration pipeline (WASM SIMD only)
      applyTurboWasmAcceleration.ts   # WASM-SIMD ↔ JS fallback chain
      capabilities.ts                # WASM-SIMD feature detection
      wasm-collision-client.ts        # WASM-SIMD host
  services/     # external API integrations (scratch-project metadata + data)
  utils/        # pure utilities (clamp, format, constants)
  types/        # shared type definitions
  styles/       # global CSS

wasm-collision/   # Rust crate → wasm-collision-bg.wasm (gitignored)
scripts/          # vendored setup, postinstall, browser verification
test/             # Vitest specs (jsdom env, single source of truth for the runtime contract)
vendored/         # vendored scratch-vm / scratch-render / Scaffolding (gitignored)
```

Feature First architecture: each feature owns its UI and state hooks. Cross-feature imports go through `lib/` / `hooks/` / `stores/`.

## Advanced Settings mapping

The Settings dialog maps directly to the TurboWarp VM/Runtime APIs:

| Setting              | Target                                              |
| -------------------- | --------------------------------------------------- |
| FPS                  | `vm.runtime.frameLoop.setFramerate(v)`              |
| Interpolation        | `vm.setInterpolation(v)` (also updates `runtime.interpolationEnabled` and emits `INTERPOLATION_CHANGED`) |
| High Quality Pen     | `vm.renderer.setUseHighQualityRender(v)`            |
| Warp Timer           | `vm.runtime.setCompilerOptions({warpTimer})`        |
| Infinite Clones      | `vm.runtime.setRuntimeOptions({maxClones: ∞})`      |
| Remove Fencing       | `vm.runtime.setRuntimeOptions({fencing: false})`    |
| Remove Misc Limits   | `vm.runtime.setRuntimeOptions({miscLimits: false})` |
| Turbo Mode           | `vm.setTurboMode(v)`                                |
| Disable Compiler     | `vm.runtime.setCompilerOptions({enabled: !v})`      |
| Stage Width / Height | `vm.setStageSize(w, h)`                             |
| TurboWasm Acceleration | `applyTurboWasmAcceleration(enabled, caps, mode)` |
| Performance Mode     | `applyTurboWasmAcceleration(enabled, caps, mode)` (controls tier selection; see below) |

### Performance Mode

The **Performance Mode** dropdown is the user-facing selector for the
collision-detection backend. The default is `auto`, which uses the WASM
SIMD path when the runtime detects SIMD support and falls back to the
original JavaScript collision loop otherwise. The other two are explicit
overrides for debugging and benchmarking:

- **`auto`** — WASM SIMD when supported, otherwise the original JavaScript
  path. The recommended default.
- **`force-wasm`** — Always use the WASM SIMD path when it has
  initialised. Falls back to JavaScript when SIMD is unavailable.
- **`legacy-only`** — All TurboWasm hooks are cleared. The runtime
  behaves identically to the unmodified `scratch-render`. The
  Definition-of-Done parity requirement.

The setting persists in `localStorage` (key `tw-viewer:settings:v1`,
schema version 7). The `!reset-performance` debug command reverts the
mode to `auto`; see [Debug commands](#debug-commands) below. A user who
had pinned `'force-webgpu'` before the v6 retirement will be silently
downgraded to `'auto'` on first load — the migration lives in
`src/lib/persistence.ts`.

### GPU Kernels

The `GPU Kernels` toggle enables the GPU compute kernel pipeline (the
`@compute` comment DSL described in [GPU compute kernel DSL](#gpu-compute-kernel-dsl)).
When `true`, every `control_repeat` substack whose first block carries an
`@compute` block comment is pre-parsed on loadProject and, when feasible,
turned into a WebGPU compute dispatch. The toggle defaults to `true`,
mirroring the `TurboWasm Acceleration` policy. It is **always** coerced
back to `true` by the "Set as default" button so the user cannot
accidentally lock themselves off the GPU path.

Short-circuit rules (any one disables GPU dispatch for this project):

1. `performanceMode === 'legacy-only'`.
2. `advanced.enableGpuKernels === false`.
3. `globalThis.navigator.gpu` is `undefined` (jsdom, Safari, older browsers).
4. The vendored scratch-vm patch series is not installed (a missing
   `globalThis.__turboWasmGpuKernelLookup` falls through to the JS path).
5. `createComputePipelineAsync` fails — kernel is D4-demoted for the
   remainder of the session.

Failures surface in the inline error log panel with codes from
`d1.region_demoted` through `d4.kernel_runtime_demoted` and
`gpu.adapter_unavailable`. A single `gpu.adapter_unavailable` warning is
emitted per session to avoid log spam.

## GPU compute kernel DSL

The GPU compute kernel pipeline reads a **comment DSL** attached to the
first substack block of a `control_repeat`. The DSL is a strict subset
of plain-text comment directives that the player parses at
`loadProject` time, runs through four demote stages (D1–D4), and — when
the region survives — emits a WebGPU compute shader.

The pipeline lives under `src/runtime/gpu-kernel/` and has six
independent modules, all test-covered:

| Module | Responsibility |
| --- | --- |
| `comment-parser.ts` | Lexes `@compute` directive text. Case-insensitive on directive heads, CRLF/LF/TAB tolerant. |
| `region-extractor.ts` | Walks project.json, finds `control_repeat` blocks whose first substack block carries a comment starting with `@compute`. |
| `block-subset.ts` (D1) | Flags regions that contain unsafe opcodes (random, string ops, wait/broadcast/stop, pen/sound/sensing, list mutations, custom-block calls, nested `control_repeat_until/while/forever`). |
| `axis-analysis.ts` (D2) | Five-condition axis safety check per `@repeat Ri:axis` (see [D2 axis safety](#d2-axis-safety-%C2%A74.2)). |
| `cascade-analysis.ts` (D3) | `@map` DAG cycle detection + missing-`@map` cascade + identifier collision warnings. |
| `wgsl-emitter.ts` | Builds the `@compute` WGSL module + `ScratchUniforms` + `@group(0) @binding(N)` storage bindings. |
| `kernel-registry.ts` (M5) | Canonical AST → GPipeline cache; cross-kernel buffer conflict analysis; region DAG. |
| `__dispatch-kernel-sync.ts` (M5) | Per-dispatch synchronous path: pre-dispatch list length read → writeBuffer×N → submit (fire-and-forget) → mapAsync readback. |
| `list-buffer-binding.ts` (M5) | Lazy-allocated GPU storage buffers per `@bind name`; `forDeviceLost()` rebuilds everything on `device.lost`. |
| `apply-gpu-kernels.ts` (M5) | Installs `window.__turboWasmGpuKernelLookup(blockId)` for the vendored scratch-vm hook. |
| `initialize-gpu-kernels.ts` (M5) | Bootstraps the WebGPU device, emits WGSL per region, builds pipelines. |

The vendored-side hooks (M2) live in
`patches/vendored/gpu-kernel-list-binding+0.1.0.patch` and
`patches/vendored/gpu-kernel-runtime+0.1.0.patch`:

- `list-binding` adds `runtime.__getListBuffer(name)`,
  `__getListBufferById(id)`, `__getScalarValue(name)`, `__setScalarValue(name, value)`.
- `runtime` adds a top-of-primitive hook in `repeat` / `repeatUntil` /
  `repeatWhile` that consults `globalThis.__turboWasmGpuKernelDispatch(blockId)`.
  When the lookup returns truthy the JS path is skipped and the loop
  counter is consumed in one frame; when the lookup returns falsy the
  hook is a no-op so projects without `@compute` regions run normally.

### Comment marker

The DSL lives inside a Scratch **block comment** — the textual content of
`target.comments[commentId].text`. The marker is the literal token
`@compute` at the start of the comment text:

```
@compute
@bind ...         ; one or more
@workgroup_size(...) ; optional
@repeat ...        ; one per parallel axis
@map ...           ; zero or more
```

Comments are multi-line strings. CRLF, LF, mixed indentation (TAB /
space), and leading `//` prefixes are all tolerated. The directive head
is case-insensitive (`@Bind`, `@BIND`, `@bind` are equivalent).

The comment must be attached to the **first substack block** of a
`control_repeat`. Any other position (e.g. on the repeat block itself,
on a `control_repeat_until`, on a `control_while`, on a `control_forever`)
is treated as **no `@compute` region** by `region-extractor.ts`. A
nested `@compute` inside a region's body D1-demotes the outer region
per spec §4.5.

### Directive reference

Each directive occupies one line. Empty lines and lines that don't start
with `@` are ignored (or, when malformed, surface a
`gpu.dsl_syntax_error` diagnostic per spec §9.1).

#### `@bind <name>(<slot>) ro|rw [f32|i32|byte]`

Binds a scratch-vm list (or scalar) to a `@group(0) @binding(N)`
storage buffer.

| Token | Meaning |
| --- | --- |
| `name` | Scratch list/scalar name. Case-insensitive (lower-cased before lookup). Plain ASCII identifier, or a quoted string for names containing spaces / punctuation (see [Quoted names](#quoted-names-spaces--punctuation)). |
| `slot` | Non-negative integer. Becomes the WGSL `@group(0) @binding(N)` index. |
| `ro` | Read-only storage (`var<storage, read>`). |
| `rw` | Read-write storage (`var<storage, read_write>`). |
| dtype | `f32` (default), `i32`, `byte`. `byte` is reserved for v2; current build treats it as `f32` with a warning. |

Example:

```
@bind scratch_list(0) rw f32
@bind tmp0(1) ro
@bind buff_r(2) rw
```

##### Quoted names (spaces / punctuation) — recommended

Scratch allows variable and list names that contain spaces, such as
`"my list"`. **Quoting is the recommended form for every identifier
slot** in the `@compute` DSL — `@bind`, `@repeat`, and `@map`
all accept either a plain identifier or a double-quoted string. The
quoted form is unambiguous even when names contain punctuation or
extend into future DSL extensions; unquoted identifiers continue to
work for backwards compatibility.

```
@compute
@bind "my list"(0) rw f32      ; @bind with quoted name (recommended)
@bind tmp0(1) ro f32           ; unquoted names still work
@repeat "R0":global_x = aabb_w ; @repeat name + axis quoted
@map "idx with space" <- 0     ; @map var quoted
```

The quoted name is preserved as the `name` field on the directive
(used for runtime lookups via `__getListBuffer`). The parser derives
an `internalName` (FNV-1a hash, formatted as `__tw_<8 hex digits>`)
for the WGSL side; the emitter uses it for the `@group(0) @binding(N)`
storage declaration, the `ScratchUniforms.<name>_length` field, and
the `for`/`let` bindings. Quoted references in formulas (`"my list"`)
resolve through the rename pass to the same internal name.

Escape sequences inside a quoted name: `\"` → `"`, `\\` → `\`; any
other `\<char>` drops the backslash and keeps the literal character
(forward compatibility for future escapes).

Canonical keys (cache hits) are based on `name`, so two regions that
bind the same Scratch list — quoted or not — share the same compiled
pipeline.

##### Formula syntax sugar

The `@map <var> <- <formula>` and `@repeat R<i> = <formula>` slots
accept a small set of general notations and rewrite them to the
underlying scratch-compat definitions during WGSL emission. The
user-facing surface stays language-natural; the emitter handles the
expansion.

| DSL form | Expands to |
| --- | --- |
| `name[idx]` | `scratch_list_read_{dtype}(&<emit>, scratch_index_clamp(idx, u_scratch.<emit>_length), u_scratch.<emit>_length)` |
| `len(name)` | `u_scratch.<emit>_length` |
| `bool(x)` | `select(0.0, 1.0, x != 0.0)` |

`<emit>` is the WGSL-safe identifier for the `@bind` (the original
name if WGSL-safe, otherwise the FNV-1a `internalName`). `<dtype>`
matches the binding's `f32`/`i32`/`byte` declaration. `bool(x)`
mirrors `scratch_bool` from `scratch-compat.ts`: NaN-safe coercion to
`0.0` / `1.0`. `name` and `idx` may be any expression; nested sugar
inside the subscript or argument is recursively expanded.

```
@bind my_list(0) ro f32
@repeat R0:global_x = len(my_list)
@map flag <- bool(my_list[R0])
```

Subscript and `len(...)` targets that do not resolve to a `@bind`
directive in the same region surface a `gpu.formula_sugar_undeclared_target`
diagnostic; the formula body is left as-is so the user can fix the
typo without losing the rest of the WGSL output.

#### `@workgroup_size(<x> [, <y>] [, <z>])`

Lifts directly into WGSL's `@compute @workgroup_size(x,y,z)`. Default
when omitted: `(64, 1, 1)`. All entries must be `≥ 1`.

If the resolved size exceeds `device.limits.maxComputeWorkgroupSizeX/Y/Z`,
the runtime clamps the offending axis and emits an `info`-level
diagnostic (Q19).

#### `@repeat R<i>[:<axis>] = <formula> [, blockId="<id>"]`

Declares one dispatch axis. Multiple `@repeat` directives are permitted
on a single region — each surviving axis runs in parallel; demoted axes
fall back to sequential.

| Token | Meaning |
| --- | --- |
| `i` | Index digit (typically `0`, `1`, `2`). |
| `axis` | One of `global_x`, `global_y`, `global_z`, `local_x`, `local_y`, `local_z`, `workgroup_x`, `workgroup_y`, `workgroup_z`, or `sequential` (the safe fallback). |
| `formula` | Raw formula text. WGSL-allowed syntax (see [Formula syntax](#formula-syntax)). |
| `blockId` | Optional `blockId="<scratch-block-id>"` linking the directive to a specific scratch block in the body (Phase 0 nested parallelization §1.1). |

The dispatch size for a parallel axis is computed at runtime as
`ceil(runtime_list_length / workgroup_size_axis)` per spec §3.5.
§Phase 2 (15.3) removed the previous `, max=<uint>` suffix and the
`@max` directive entirely; the dispatch cap is now derived from the
runtime list length at dispatch time.

#### `@map <var> <- <formula>`

Declares a `let` binding derived from `global_invocation_id` (or
another `@map`). The WGSL emitter topologically sorts the `@map`
graph (per spec §3.7) and emits each binding in dependency order as a
`let <var>: f32 = <formula>;`. Cycles are detected here and demote the
region to D3.

Reserved keywords in `<var>` (WGSL builtin names and the DSL keywords
`global_invocation_id`, `local_invocation_id`, `workgroup_id`,
`builtin`, `dispatch`, `compute`) are auto-renamed to `__tw_tmp_<hex>`
with a single `gpu.identifier_collision` warning.

### Axis values

The `axis` token in `@repeat` selects how the dispatch counter is
mapped onto the WGSL `gid` builtin:

| Axis value | WGSL builtin | Notes |
| --- | --- | --- |
| `global_x` | `global_invocation_id.x` | Most common. Use for 1-D data-parallel kernels. |
| `global_y` | `global_invocation_id.y` | 2-D grid (e.g. image rows). |
| `global_z` | `global_invocation_id.z` | 3-D grid (volumetric). |
| `local_x` / `local_y` / `local_z` | `local_invocation_id.{x,y,z}` | Reserved for per-thread-shared dispatch. |
| `workgroup_x` / `workgroup_y` / `workgroup_z` | `workgroup_id.{x,y,z}` | Per-workgroup dispatch. |
| `sequential` | n/a | Region falls back to a `for` loop in JS. Use when D2 demotes an axis. |

Omitting `axis` (`:axis` entirely) is treated as `sequential` — the
safe fallback per spec §3.3.

### Formula syntax

`@repeat` and `@map` formula strings are spliced verbatim into the WGSL
output prefixed by `let <var>: f32 = ` (or `var R0: u32 = ` for the
parallel-axis counter). The formula is opaque WGSL — anything the WGSL
parser accepts is allowed (Q21). The emitter scans tokens for known
identifiers and flags anything outside that whitelist with a
`gpu.emitter_syntax_warning`:

| Whitelisted identifier class | Examples |
| --- | --- |
| Numeric literals | `0`, `1.5`, `-3`, `6.022e23` |
| WGSL builtins | `global_invocation_id`, `local_invocation_id`, `workgroup_id`, `select`, `min`, `max`, `clamp`, `sin`, `cos`, `pow`, `exp`, `log`, `floor`, `ceil`, `fract`, `abs`, `sqrt`, `mix`, `step` |
| `scratch-compat` helpers | `scratch_div`, `scratch_mod`, `scratch_index_clamp`, `scratch_list_read_f32`, `scratch_list_read_i32`, `scratch_list_write_f32`, `scratch_bool` |
| `@bind`-declared names | All names from the region's `@bind` directives |
| `@map`-declared names | All names from the region's `@map` directives |
| Operators and parens | `+ - * / % ( ) , ;` |
| Casts | `f32(...)`, `i32(...)`, `u32(...)` |

Substitutions for non-WGSL primitives:

| Scratch-vm primitive | WGSL substitution |
| --- | --- |
| Integer division `//` (not in scratch-vm) | `floor(<a>/<b>)` (with `gpu.emitter_integer_division_substituted` warning) |
| Generic exponent `^` (not in scratch-vm) | `exp(<base>*log(<exp>))` (with `gpu.emitter_generic_pow_substituted` warning). For region-local use, define a custom block outside the `@compute` region. |

### D1 — block subset demote (§4.1)

A region D1-demotes when **any** of these opcodes appears anywhere
inside the body (including nested sub-stacks of `control_if` etc.):

- **Loops not allowed as region entrances** (would also prevent region
  extraction): `control_repeat_until`, `control_while`, `control_forever`.
- **Non-data-parallel ops** (random, string, wait, broadcast, stop):
  `operator_random`, `operator_join`, `operator_letter_of`,
  `operator_stringLength`, `operator_stringContains`,
  `operator_stringIndex`, `control_wait`, `control_wait_until`,
  `control_stop`, `event_broadcast`, `event_broadcastandwait`.
- **Pen, sound, sensing** (touch IO): `pen_*`, `sound_*`, `sensing_*`.
- **List mutations that touch the host** (`data_addtolist` etc., per
  spec §5.2): `data_addtolist`, `data_deleteoflist`,
  `data_insertatlist`, `data_deletealloflist`,
  `data_replaceitemoflist`.
- **Custom-block calls**: `procedure_call`, `argument_reporter_string`,
  `argument_reporter_boolean`.

Region nesting (another `control_repeat` inside the body carrying its
own `@compute` comment) also D1-demotes the outer region (spec §4.5).

A D1-demoted region is logged with code `d1.region_demoted` (severity
`warn`) and falls back to the JS path entirely.

### D2 — axis safety (§4.2)

For each `@repeat Ri:<axis>` the axis-analysis stage checks five
conditions. **All** must hold for the axis to remain parallel; failing
any one collapses the axis to `sequential`:

1. **`@map` declares `Ri`.** A bare `@repeat R0:global_x = aabb_width`
   without a matching `@map R0 <- …` D2-demotes the axis.
2. **Formula references `Ri`.** The formula text contains `Ri` as a
   whole-word identifier.
3. **Body does not write to `Ri`.** No `data_setvariableto` or
   `data_changevariableby` whose target variable name is `Ri`.
4. **No cross-iteration access.** No list index of the form `Ri + k`
   or `Ri - k` with `k ≠ 0` (Q18).
5. **All body blocks are GPU-supportable** (same table as D1, minus the
   "entrance" restrictions — see [D1](#d1--block-subset-demote-%C2%A74.1)).

A D2-demoted axis is logged with code `d2.axis_demoted`. Other axes
remain parallel; the region continues to compile.

### D3 — cascade demote (§4)

A region D3-demotes when any one of:

- The `@map` declarations form a cycle (`@map a <- b + 1` + `@map b <- a + 1`).
- A surviving `@repeat Ri:<axis>` has no matching `@map Ri`.
- The WGSL emitter produces a shader that fails `createShaderModule` validate.
- An `@map` variable name collides with a reserved keyword **and** the
  emitter cannot auto-rename (auto-rename is always attempted first;
  this case is unreachable in practice but reserved for future).

D3 is logged with code `d3.region_cascade_demoted`. The region falls
back to the JS path.

### D4 — runtime demote (§4)

Triggered when a kernel that previously compiled fails to dispatch at
runtime. Causes:

- `device.lost` (the user pulled the GPU out from under the page).
- `queue.submit` OOM.
- `mapAsync` readback timeout.

D4 sets the kernel's `jsOnly` flag in the registry, so subsequent
dispatches for the same `blockId` short-circuit to JS for the rest of
the session. Code: `d4.kernel_runtime_demoted`.

### `scratch-compat` helpers (§5.1)

Every emitted WGSL module is preceded by a header containing seven
helpers that map scratch-vm's `cast.js` primitives into IEEE754-faithful
WGSL. They live in `src/runtime/gpu-kernel/scratch-compat.ts`; the
TypeScript-side reference implementations (`jsScratchDiv`,
`jsScratchMod`, `jsScratchIndexClamp`) are the canonical test
reference — GPU output must match the JS reference within 1e-6.

| Helper | Behaviour |
| --- | --- |
| `scratch_div(a, b)` | `let q = a / b; return q;` — NaN for `0/0`, `+Inf` for `+x/0`, `-Inf` for `-x/0`. No branching. |
| `scratch_mod(n, m)` | `let q = floor(n/m); return n - q * m;` — floored division (sign-corrected). |
| `scratch_index_clamp(idx, len)` | 1-based. Out-of-range → `-1.0` sentinel. |
| `scratch_list_read_f32(buf_idx, idx, len)` | Out-of-range → `0.0/0.0` (NaN) for arithmetic paths. |
| `scratch_list_read_i32(buf_idx, idx, len)` | Same but `i32`. |
| `scratch_list_write_f32(buf_idx, idx, len, value)` | Out-of-range write is a no-op. |
| `scratch_bool(x)` | `select(0.0, 1.0, x != 0.0)` — NaN is `false`. |

Logic operators (`and`, `or`, `not`) are translated per spec §5.1a/Q13:

- `A and B` → `select(0.0, 1.0, scratch_bool(A) * scratch_bool(B))`
- `A or B` → `select(0.0, 1.0, max(scratch_bool(A), scratch_bool(B)))`
- `not A` → `select(1.0, 0.0, scratch_bool(A))`

The emitter refuses to translate B when B is side-effectful (e.g.
`data_addtolist`); the region D1-demotes instead.

### Diagnostic codes (§9)

All GPU kernel diagnostics flow through `useErrorLogStore.push(...)` —
no toasts, no modals. They show up in the inline `ErrorLogPanel` when
their severity is `error` and stay in the store otherwise. Per spec
§9.4, the first five region demotes are surfaced at `warn`; further
demotes are downgraded to `info` to avoid log spam.

| Code | Severity | When |
| --- | --- | --- |
| `gpu.adapter_unavailable` | `warn` | `navigator.gpu` missing. At most one per session. |
| `gpu.dsl_syntax_error` | `warn` | Directive could not be parsed. Includes line / column. |
| `gpu.identifier_collision` | `warn` | `@map var` collides with a reserved keyword. Emitter auto-renames. |
| `gpu.emitter_unsupported_opcode` | `error` | Body block opcode not in the GPU-safe subset. |
| `gpu.emitter_integer_division_substituted` | `info` | `//` rewritten to `floor(a/b)`. |
| `gpu.emitter_generic_pow_substituted` | `info` | `^` rewritten to `exp(base*log(exp))`. |
| `gpu.shader_module_failed` | `warn` | `createShaderModule` validate failed. |
| `gpu.pipeline_create_failed` | `warn` | `createComputePipelineAsync` rejected. |
| `gpu.list_buffer_resize` | `debug` | List length changed between dispatches. Console-only. |
| `gpu.clamp_overflow` | `debug` | List length exceeded the GPU buffer cap. Console-only. |
| `d1.region_demoted` | `warn` | Body contains an unsafe opcode (see [D1](#d1--block-subset-demote-%C2%A74.1)). |
| `d2.axis_demoted` | `warn` | One axis fails the five-condition safety check (see [D2](#d2--axis-safety-%C2%A74.2)). |
| `d3.region_cascade_demoted` | `warn` | `@map` cycle / missing-`@map` / WGSL compile failure (see [D3](#d3--cascade-demote-%C2%A7)). |
| `d4.kernel_runtime_demoted` | `warn` | Runtime dispatch failure (device lost / OOM / timeout). Subsequent dispatches skip the GPU path for the rest of the session. |

### Demo: `fn expo` (§13)

The vendored test fixture `test/.test-fixtures/expo-fixture.sb3`
(generated by `scripts/make-expo-fixture.mjs`) demonstrates a full
AABB × pixel-multiply kernel. The body of the sprite's main block
contains:

```
@compute
@bind aabb_w(0) ro f32
@bind aabb_height(1) ro f32
@bind buff_r(2) rw f32
@bind tmp0(3) ro f32
@workgroup_size(64,1,1)
@repeat R0:global_x = aabb_w
@repeat R1:global_y = aabb_height
@repeat R2:global_z = 1
@map R0 <- 0
@map idx0 <- f32(R0)
@map idx1 <- f32(R1) * aabb_width + idx0
```

(`pow2` and the AABB setup live outside the `@compute` region — they
seed `tmp0 = 2^v` via `operator_mathop e^`, since scratch-vm has no
general exponent `^`.)

With `aabb_w = 100`, `aabb_height = 64`, and a default 64-thread
workgroup, the dispatched size is `ceil(100/64) × 64 × 1 = 2 × 64 × 1`
workgroups → 8,192 invocations, completing in a single frame.

### Nested `@compute` (Phase 4)

The nested-parallelization plan extends the DSL so `@compute` can be
placed on the substack first block of **any** `control_repeat`, not
just the sprite-level top one. When the candidate is a nested
`control_repeat`, `region-extractor.findKernelContainer` walks the
parent chain and promotes the nearest ancestor `control_repeat` to
the kernel container. The M3 → M5 pipeline then emits an implicit
2D dispatch with axes derived from the surrounding loop counts:

- kernel container's `inputs.TIMES` → `Ry:global_y`
- nested repeats → `Rx0`, `Rx1`, ... `global_x`

Pixel-level parallelism is achievable with scratch code that does
not change at all — only the placement of the `@compute` comment and
the new directives (`@bind ..., scalar`,
`@repeat <name>:<axis> = <formula>` referencing nested scratch
lists) are added.

The vendored fixture `test/.test-fixtures/expo-fixture-nested.sb3`
(generated by `scripts/make-expo-fixture.mjs`'s `buildNestedProject`
helper, registered alongside the legacy fixture in
`scripts/ensure-test-fixtures.mjs`) demonstrates the shape:

```
@compute
@bind tmp0(0) ro f32
@bind buff_r(1) rw f32
@bind buff_g(2) rw f32
@bind buff_b(3) rw f32
@bind aabb_w(5) ro f32
@bind aabb_h(9) ro f32
@bind aabb_minx(6) ro f32
@bind aabb_miny(7) ro f32
@bind aabb_idx0(4) ro i32, scalar   ← Phase 3 Tier 2 uniform
@bind aabb_tmp0(10) ro f32, scalar  ← Phase 3 Tier 2 uniform
@bind screen_w(8) ro f32, scalar    ← Phase 3 Tier 2 uniform
@workgroup_size(64)
@repeat Ry:global_y = aabb_h[aabb_idx0]
@repeat Rx:global_x = aabb_tmp0
```

The `nestedParallelizationEnabled` toggle in the Settings dialog
(TurboWasm section) gates the path at `player.ts:bootstrapGpuKernels`.
The default is `false` (v8 → v9 migration seeds the field with
`false`); flipping it to `true` lets nested regions through to the
GPU pipeline while leaving the legacy outer-only layout on the same
code path it has always used. Existing projects with nested layouts
fall through to the JS path until the user opts in — bit-identical
with the pre-Phase-4 baseline.

### Verifying locally

```bash
npm run fixtures:setup         # generates expo-fixture.sb3 alongside the others
npm run build                  # full build (vendored + wasm + vite)
npm run preview                # serves dist/
npm run verify:gpu-kernel      # runs scripts/verify-gpu-kernel.mjs against #expo
npm run bench:gpu-kernel       # writes ./logs/bench-gpu-kernel-init.out
RUN_E2E=1 npx vitest run test/e2e/gpu-kernel.test.ts
```

`verify:gpu-kernel` exits 0 in either case: when WebGPU is available it
compares the canvas pixel buffer of the GPU path against the
`legacy-only` path with a 1e-6 absolute tolerance; when WebGPU is
absent it emits 1×1 placeholder PNGs to `./logs/turbowarp-equivalent-gpu-{default,legacy-only}.png`
and exits 0. The bench script measures pre-parse wall-time and
pipeline cache hits across 10 consecutive loads.

### Source layout

```
src/runtime/gpu-kernel/
├── comment-parser.ts          (@compute directive text → ParsedDirective[])
├── region-extractor.ts        (project.json walk → ExtractedRegion[])
├── block-subset.ts            (D1 demote classifier)
├── axis-analysis.ts           (D2 demote per @repeat axis)
├── cascade-analysis.ts        (D3 @map DAG + cycles)
├── scratch-compat.ts          (scratch-compat header + JS reference impls)
├── wgsl-emitter.ts            (RegionVerdict → WGSL string)
├── list-buffer-binding.ts     (M5: lazy GPU buffer pool)
├── kernel-registry.ts         (M5: canonical AST → Pipeline cache)
├── __dispatch-kernel-sync.ts  (M5: pre/post dispatch + sync submit)
├── apply-gpu-kernels.ts       (M5: install window.__turboWasmGpuKernelLookup)
├── initialize-gpu-kernels.ts  (M5: boot WebGPU + emit + register)
├── region-verdict-pipeline.ts (M6: glue between M3 and M5)
├── types.ts                   (Diagnostic, ParsedDirective, RegionVerdict, AxisFinal)
└── index.ts                   (public re-exports)

test/runtime/gpu-kernel/       (mirror of src/, vitest + jsdom)
test/e2e/gpu-kernel.test.ts    (RUN_E2E=1 gated Playwright wrapper)
test/runtime/gpu-kernel-patches.test.ts (vendored patch regression guard)
test/runtime/gpu-kernel-player-wiring.test.ts (M6 unit tests)

patches/vendored/gpu-kernel-list-binding+0.1.0.patch
patches/vendored/gpu-kernel-runtime+0.1.0.patch

scripts/make-expo-fixture.mjs
scripts/verify-gpu-kernel.mjs
scripts/bench-gpu-kernel-init.mjs
```

## Extension points

Future extensions (Addons, Cloud Variables) plug into runtime via two interfaces:

- `src/runtime/extensions.ts` — `addExtensionRegistrar({ id, register })`. Registered callbacks run after `scaffolding.setup()` and before any project load.
- `src/runtime/cloud-provider.ts` — `setCloudProvider(provider)`. The default is a no-op provider.

## Environment variables

| Variable               | Purpose                                   | Default                                 |
| ---------------------- | ----------------------------------------- | --------------------------------------- |
| `VITE_GITHUB_REPO_URL` | Target URL of the GitHub icon (top-right) | `https://github.com/visual27/TurboWasm` |

Vite injects build-time values; changing them requires a rebuild.

## Performance pipeline

The Viewer ships one collision-detection pipeline (`TurboWasm Acceleration`),
backed by the WASM-SIMD collision module. Phase 2 (WebGPU compute), Phase 3
(WebGPU instanced renderer), and Stage 2 (SVG acceleration) were all
retired in v6 because their JS-side hooks were never wired beyond feature
detection — see the [AGENTS.md → "Phase 4 撤廃"](AGENTS.md) section for
the Phase 4 (resvg-wasm) precedent that established the same pattern.

| Path                                | Implementation                                                    |
| ----------------------------------- | ----------------------------------------------------------------- |
| WASM SIMD `isTouchingColor` / `isTouchingDrawables` | `wasm-collision/` (Rust), `wasm-collision-client.ts` |
| 2-tier fallback chain (`wasm` ↔ `js`) | `src/runtime/tw-wasm/applyTurboWasmAcceleration.ts`         |

The vendored `scratch-render` is patched
(`patches/wasm-collision-runtime+0.1.0.patch`) to install the host-side
hooks that the runtime reads at frame time: `_twWasmIsTouchingColor` and
`_twWasmIsTouchingDrawables`. The previously-installed
`_twWasmGpuTouchingStart`, `_twWasmGpuTouchingFin`, `_twWasmDrawSprites`,
and `_twWasmSvgAcceleration` hooks were retired along with the matching
runtime paths.

`*.wasm` files are served with `Content-Type: application/wasm` and
`Cache-Control: public, max-age=31536000, immutable` via
`public/_headers` (Cloudflare Pages and other static hosts honour this
file).

## Verification

A headless Chromium smoke test lives at `scripts/verify-browser.mjs`
and `scripts/chrome-devtools-mcp-verify.mjs`. They boot the dev / preview
build, poll `window.__turbowasm` (set by `__exposeForBrowserVerify` in
the player) and assert the surviving WASM-SIMD host hooks are wired
correctly (and that the retired Phase 2 / 3 / Stage 2 hooks are NOT
present on the renderer). The captured logs land in
`./logs/browser-verify-*.log` and a screenshot in
`./logs/browser-verify-home.png`.

```bash
npm run build
npm run preview &        # serves dist/ on port 4173
node scripts/verify-browser.mjs --url http://localhost:4173
```

A separate harness (`scripts/verify-turbowarp-equivalent.mjs`) opens
two browser contexts (one with `performanceMode: 'auto'`, one with
`'legacy-only'`) and compares the rendered canvas pixels at the
ImageData level. This guards the DoD parity contract — see
`test/e2e/turbowarp-equivalent.test.ts` for the Vitest entry point.

## License

This project is based on TurboWarp (and its Scaffolding library). TurboWarp is licensed under the **GNU General Public License v3.0 (GPL-3.0)**. Unless otherwise noted, this project is licensed under **GPL-3.0**.

```
TurboWasm Viewer
Copyright (C) 2026 visual27

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/gpl-3.0.html>.
```

This project contains modified code from:

- [TurboWarp](https://github.com/TurboWarp/) — © Scratch Foundation contributors, GPL-3.0
- [turbowarp.org](https://turbowarp.org/) — © Scratch Foundation contributors, GPL-3.0

This project is **not** affiliated with the official TurboWarp project.

## Acknowledgements

- [TurboWarp](https://turbowarp.org/) for the Scaffolding library and the underlying VM/Runtime.
- [Scratch](https://scratch.mit.edu) for the original project format and APIs.