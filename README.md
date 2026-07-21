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

> **Note:** `scripts/setup-vendored.mjs` pins `SCRATCH_VM_REF` to a specific
> commit (not `origin/develop`) because the GPU kernel patches under
> `patches/vendored/` (`gpu-kernel-list-binding+0.1.0.patch` and
> `gpu-kernel-runtime+0.1.0.patch`) are regenerated against that exact SHA via
> `scripts/regen-gpu-kernel-patches.mjs`. A fresh clone (e.g. Cloudflare Pages)
> therefore bootstraps against a known-compatible scratch-vm snapshot. If the
> pinned SHA drifts past the patch baseline, the script logs a `WARNING` and
> continues with the GPU kernel pipeline disabled (runtime falls back to the JS
> path); regenerate the GPU kernel patches against the current `develop` HEAD
> and update the pin atomically.

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
| Custom Block Inlining (Phase 5) | `bootstrapGpuKernels` flips `procedure_call` / `argument_reporter_*` back to D1-unsafe when this is `false`. See [Phase 5 DSL — Custom Block Inlining](#phase-5-dsl--custom-block-inlining-) |

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
schema version 11 — see [Breaking Changes](#breaking-changes)). A user
who had pinned `'force-webgpu'` before the v6 retirement will be
silently downgraded to `'auto'` on first load — the migration lives in
`src/lib/persistence.ts:migratePerformanceMode`.

### GPU Kernels

The `GPU Kernels` toggle enables the GPU compute kernel pipeline (the
`@compute` comment DSL described in [GPU compute kernel DSL](#gpu-compute-kernel-dsl)).
When `true`, every `control_repeat` block that carries an `@compute`
block comment on itself (Phase 4 loose-position form) is pre-parsed on
`loadProject` and, when feasible, turned into a WebGPU compute dispatch.
The toggle defaults to `true`, mirroring the `TurboWasm Acceleration`
policy. It is **always** coerced back to `true` by the "Set as default"
button so the user cannot accidentally lock themselves off the GPU path.

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
| `region-extractor.ts` | Walks project.json, finds `control_repeat` blocks that carry a comment starting with `@compute` (Phase 4 loose-position form). |
| `repeat-path-resolver.ts` (Phase 4) | Resolves each `@repeat`'s `repeatPath="<path>"` against the region's `repeatPathTable` to a concrete `control_repeat` block id. |
| `block-subset.ts` (D1) | Flags regions that contain unsafe opcodes (random, string ops, wait/broadcast/stop, pen/sound/sensing, list mutations, custom-block calls, nested `control_repeat_until/while/forever`). The `procedure_call` / `argument_reporter_*` pair is D1-safe only when `inliningEnabled` is `true` (Phase 5). |
| `procedure-inliner.ts` (Phase 5) | Pre-parse expands `procedure_call` blocks into the region body with cycle and depth (≤ `MAX_INLINING_DEPTH = 16`) guards. |
| `axis-analysis.ts` (D2) | Five-condition axis safety check per `@repeat Ri:axis` (see [D2 axis safety](#d2-axis-safety-%C2%A74.2)). |
| `cascade-analysis.ts` (D3) | `@map` DAG cycle detection + missing-`@map` cascade + identifier collision warnings. |
| `wgsl-emitter.ts` | Builds the `@compute` WGSL module + `ScratchUniforms` + `@group(0) @binding(N)` storage bindings. Lowercases `operator_mathop` into WGSL builtins (Phase 2). |
| `kernel-registry.ts` (M5) | Canonical AST → GPipeline cache; cross-kernel buffer conflict analysis; region DAG. |
| `__dispatch-kernel-sync.ts` (M5) | Per-dispatch synchronous path: pre-dispatch list length read → writeBuffer×N → submit (fire-and-forget) → mapAsync readback. |
| `list-buffer-binding.ts` (M5) | Lazy-allocated GPU storage buffers per `@bind name`; `forDeviceLost()` rebuilds everything on `device.lost`. Aggregates buffer size across regions and warns `gpu.regional_buffer_memory_pressure` at 80% of `device.limits.maxStorageBufferBindingSize` (Phase 3). |
| `apply-gpu-kernels.ts` (M5) | Installs `window.__turboWasmGpuKernelLookup(blockId)` for the vendored scratch-vm hook. |
| `initialize-gpu-kernels.ts` (M5) | Bootstraps the WebGPU device, emits WGSL per region, builds pipelines. Aggregates emitter diagnostics into `InitializeResult.emitDiagnostics` (Phase 5 §15.14). |
| `diagnostic-forwarding.ts` (Phase 5) | Single `forwardGpuDiagnostics` entry point with severity-bucketed routing. |
| `scalar-uniform-binding.ts` (Phase 3) | Extracts `@bind ..., scalar` directives into WGSL `@group(1) @binding(0)` uniform buffer entries with host-side 16-byte stride packing. |

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

The comment must be attached to a **`control_repeat` block itself**
(§Phase 4 loose-position form; the kernel container = the marker host).
The kernel container's `SUBSTACK` is the region body. A `@compute`
marker on any other position — including the first substack entry
block, a `control_repeat_until`, a `control_while`, or a
`control_forever` — emits `gpu.legacy_compute_comment_position` warn
and falls back to the JS path; the region is not extracted.

A single sprite can carry multiple `@compute` markers on **different**
`control_repeat` blocks. Each marker becomes an independent region with
its own kernel container, body, and dispatch context. Two markers on
the **same** `control_repeat` D1-demote the region with
`gpu.multiple_compute_regions` (error).

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
pipeline. §Phase 3 §15.10: the canonical key deliberately omits
`regionId` / `blockId` / `kernelContainerBlockId` so a save-as-new-
project renumbering the scratch block ids still hits the cached
pipeline. The runtime identity (`Kernel.id`) and block-id lookup
(`byBlockId`) still use the un-stripped regionId / blockId.

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

#### `@repeat R<i>[:<axis>] = <formula> [, repeatPath="<path>"]`

Declares one dispatch axis. Multiple `@repeat` directives are permitted
on a single region — each surviving axis runs in parallel; demoted axes
fall back to sequential.

| Token | Meaning |
| --- | --- |
| `i` | Index digit (typically `0`, `1`, `2`). |
| `axis` | One of `global_x`, `global_y`, `global_z`, `local_x`, `local_y`, `local_z`, `workgroup_x`, `workgroup_y`, `workgroup_z`, or `sequential` (the safe fallback). |
| `formula` | Raw formula text. WGSL-allowed syntax (see [Formula syntax](#formula-syntax)). |
| `repeatPath` | Optional `repeatPath="self"` or `repeatPath="<numeric path>"` (e.g. `"0"`, `"0.1"`) that selects the target `control_repeat`. Defaults to `"self"` (the kernel container). The resolver (`repeat-path-resolver.ts`) maps the path onto a concrete block id via the region's `repeatPathTable`. Missing/invalid/duplicate paths surface `gpu.repeat_path_*` errors and D1-demote the region. |

The dispatch size for a parallel axis is computed at runtime as
`ceil(runtime_list_length / workgroup_size_axis)` per spec §3.5.
§Phase 2 (15.3) removed the previous `, max=<uint>` suffix and the
`@max` directive entirely; the dispatch cap is now derived from the
runtime list length at dispatch time.

§Phase 4 (BREAKING) replaced the legacy `, blockId="<scratch-id>"`
suffix with `repeatPath="<path>"`. Any leftover `blockId=` is rejected
with `gpu.repeat_path_invalid` so old fixtures fail loud rather than
silently keeping the v9 contract alive.

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
  `argument_reporter_boolean`. These are **D1-safe** only when
  `procedure-inliner.ts` can expand the call site — i.e. when
  `advanced.customBlockInliningEnabled` is `true` AND the prototype
  resolves AND the cycle/depth guard holds. When the inliner rejects
  the call (depth > 16, cycle, missing prototype) the owning region
  D1-demotes with `gpu.procedure_recursion_unsupported` or
  `gpu.procedure_prototype_not_found`.

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
2. **Formula references `Ri` or a `@bind` list.** The formula text
   contains `Ri` as a whole-word identifier, a quoted surface name
   (`"R0"` / `"my axis"`), a hashed `internalName` (`__tw_<hex>`),
   or the name of any list `@bind` declared in the same region
   (e.g. `aabb_w`, `len(aabb_w)`). Scalar bindings do not qualify as
   loop bounds — they feed `data_variableof` resolution instead. This
   keeps the legacy `expo-fixture.sb3` (`@repeat R0:global_x = len(aabb_w)`)
   parallel.
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
demotes are downgraded to `info` to avoid log spam. Phase 5 adds a
single `forwardGpuDiagnostics()` entry point
(`src/runtime/gpu-kernel/diagnostic-forwarding.ts`) with severity-
bucketed routing (errors unlimited, warn capped at 5 with overflow
folded to info).

| Code | Severity | When |
| --- | --- | --- |
| `gpu.adapter_unavailable` | `warn` | `navigator.gpu` missing. At most one per session. |
| `gpu.dsl_syntax_error` | `warn` | Directive could not be parsed. Includes line / column. |
| `gpu.identifier_collision` | `warn` | `@map var` collides with a reserved keyword. Emitter auto-renames. |
| `gpu.emitter_unsupported_opcode` | `error` | Body block opcode not in the GPU-safe subset (or `operator_mathop` not in the lowered set). |
| `gpu.emitter_integer_division_substituted` | `info` | `//` rewritten to `floor(a/b)`. |
| `gpu.emitter_generic_pow_substituted` | `info` | `^` rewritten to `exp(base*log(exp))`. |
| `gpu.shader_module_failed` | `warn` | `createShaderModule` validate failed. |
| `gpu.pipeline_create_failed` | `warn` | `createComputePipelineAsync` rejected. |
| `gpu.list_buffer_resize` | `debug` | List length changed between dispatches. Console-only. |
| `gpu.clamp_overflow` | `debug` | List length exceeded the GPU buffer cap. Console-only. |
| `gpu.multiple_compute_regions` | `error` | Two `@compute` markers on the same `control_repeat`. D1 demote. |
| `gpu.kernel_container_collision` | `warn` | A region adopted then dropped because its kernel container was already claimed. Phase 3. |
| `gpu.bind_slot_collision` | `error` | Same `@bind` slot used twice inside one region. D1 demote. |
| `gpu.regional_buffer_memory_pressure` | `warn` | Aggregate buffer size across regions exceeds 80% of `device.limits.maxStorageBufferBindingSize`. Phase 3. |
| `gpu.legacy_compute_comment_position` | `warn` | `@compute` attached to the first substack entry block (pre-Phase 4 form). Region not extracted. |
| `gpu.repeat_path_required` | `error` | `@repeat` directive omitted `repeatPath=`. D1 demote. Phase 4. |
| `gpu.repeat_path_invalid` | `error` | `repeatPath` value did not match `'self'` or a numeric path. D1 demote. Phase 4. |
| `gpu.repeat_path_not_found` | `error` | `repeatPath` not present in the region's `repeatPathTable`. D1 demote. Phase 4. |
| `gpu.repeat_path_duplicate` | `error` | Two `@repeat` directives used the same `repeatPath`. D1 demote. Phase 4. |
| `gpu.procedure_recursion_unsupported` | `error` | `procedure-inliner` depth exceeded `MAX_INLINING_DEPTH = 16` OR cycle detected. D1 demote. Phase 5. |
| `gpu.procedure_prototype_not_found` | `error` | `procedure_call` referenced an undefined prototype. D1 demote. Phase 5. |
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
@compute                                       ← attached to control_repeat below
control_repeat (aabb_h)                        ← kernel container (Ry axis via @repeat)
  idx1 = idx0
  control_repeat (aabb_w)                      ← inner repeat (Rx axis via @repeat)
    idx1 += 1
    tmp1 = tmp0 * buff_r[idx1]
    buff_r[idx1] = 1 + (tmp1 - 1) * (tmp1 < 1)
    ... (g, b same pattern)
  idx0 += screen_w

@compute
@bind tmp0(0) ro f32
@bind buff_r(1) rw f32
@bind buff_g(2) rw f32
@bind buff_b(3) rw f32
@bind aabb_w(5) ro f32
@bind aabb_h(9) ro f32
@bind aabb_minx(6) ro f32
@bind aabb_miny(7) ro f32
@bind aabb_idx0(4) ro i32, scalar
@bind aabb_tmp0(10) ro f32, scalar
@bind screen_w(8) ro f32, scalar
@workgroup_size(64)
@repeat Rx:global_x = aabb_w, repeatPath="0"     ← inner repeat axis
@repeat Ry:global_y = aabb_h, repeatPath="self"  ← kernel container axis
```

`pow2` is inlined inside the `@compute` body as an `operator_mathop`
chain (`e ^ (ln(2) * v)`); no custom block is required. See
[`operator_mathop` → WGSL builtins](#operator_mathop--wgsl-builtins-phase-2)
and `test/runtime/gpu-kernel/operator-mathop.test.ts`.

With `aabb_w = 100`, `aabb_h = 64`, and a default 64-thread
workgroup, the dispatched size is `ceil(100/64) × 64 × 1 = 2 × 64 × 1`
workgroups → 8,192 invocations, completing in a single frame.

### Loose comment position (Phase 4)

The `@compute` marker attaches to a **`control_repeat` block itself**
(§Phase 4). The marked repeat becomes the kernel container; its
`SUBSTACK` is the region body. The kernel container's own dispatch
axis is declared explicitly via `@repeat ... repeatPath="self"`; any
inner `control_repeat` without an `@repeat` directive is emitted as a
WGSL `for (...) { ... }` sequential loop.

```
@compute                                     ← attached to control_repeat below
control_repeat (aabb_h)                      ← kernel container
  idx1 = idx0
  control_repeat (aabb_w)                    ← inner repeat (dispatch axis via @repeat)
    idx1 += 1
    tmp1 = tmp0 * buff_r[idx1]
    buff_r[idx1] = 1 + (tmp1 - 1) * (tmp1 < 1)
    ...
  idx0 += screen_w

@compute
@bind tmp0(0) ro f32
@bind buff_r(1) rw f32
@bind buff_g(2) rw f32
@bind buff_b(3) rw f32
@bind aabb_w(5) ro f32
@bind aabb_h(9) ro f32
@bind aabb_minx(6) ro f32
@bind aabb_miny(7) ro f32
@bind aabb_idx0(4) ro i32, scalar
@bind aabb_tmp0(10) ro f32, scalar
@bind screen_w(8) ro f32, scalar
@workgroup_size(64)
@repeat Rx:global_x = aabb_w, repeatPath="0"   ← inner repeat axis
@repeat Ry:global_y = aabb_h, repeatPath="self" ← kernel container axis
```

§Phase 4 BREAKING (v10) replaced the v9 nested-parallelization
machinery (`findKernelContainer` ancestor promotion, implicit 2D axes,
the `advanced.nestedParallelizationEnabled` opt-in, the
`nestedRepeatContainerBlockIds` field) with the explicit
`@repeat …, repeatPath="…"` form above. The Settings dialog toggle
was removed. Old fixtures that placed `@compute` on the first substack
entry block emit `gpu.legacy_compute_comment_position` warn and fall
back to the JS path. See [Breaking Changes](#breaking-changes).

### Multiple `@compute` regions per sprite

A single sprite can carry multiple `@compute` markers, each on a
**different** `control_repeat` block. Each marker becomes an
independent region with its own kernel container, body, and dispatch
context:

- The same `control_repeat` block receiving multiple `@compute` markers
  emits `gpu.multiple_compute_regions` (error) and D1-demotes.
- Different `control_repeats` each become their own region.
- Cross-region `@bind` slot overlap is allowed: the viewer does not
  enforce ordering — the user's scratch code in `when flag clicked`
  must dispatch the regions sequentially. WebGPU preserves
  submission order within a single queue, so sequential dispatch is
  deterministic.
- Aggregate GPU memory across multiple regions is monitored via
  `list-buffer-binding.ts`; exceeding 80% of
  `device.limits.maxStorageBufferBindingSize` surfaces
  `gpu.regional_buffer_memory_pressure` warn (Phase 3).

The fixture `test/.test-fixtures/multi-region-fixture.sb3` (generated
by `scripts/make-multi-region-fixture.mjs`) exercises the path; see
`test/runtime/gpu-kernel/multi-region-fixture.test.ts`.

### `operator_mathop` → WGSL builtins (Phase 2)

Scratch's `operator_mathop` block (selectable from the math operators
drawer) maps directly to WGSL intrinsics inside `@compute` regions.
This lets you write the canonical `pow2(v) = e^(ln(2) * v)` idiom
inline, without a custom block.

| `operator_mathop.OPERATOR` | WGSL output | Unary / Binary |
| --- | --- | --- |
| `abs` | `abs(x)` | unary |
| `floor` | `floor(x)` | unary |
| `ceiling` | `ceil(x)` | unary |
| `sqrt` | `sqrt(x)` | unary |
| `sin`, `cos`, `tan` | `sin(radians(x))`, `cos(radians(x))`, `tan(radians(x))` | unary (degrees → radians) |
| `asin`, `acos`, `atan` | `degrees(asin(x))`, `degrees(acos(x))`, `degrees(atan(x))` | unary (radians → degrees) |
| `ln` | `log(x)` | unary |
| `log` | `log(x) * (1 / log(10))` | unary (WGSL has no `log10`) |
| `e ^` | `exp(x)` | unary |
| `10 ^` | `pow(10.0, x)` | unary |

Unsupported operators fall back to `0.0` and emit
`gpu.emitter_unsupported_opcode` (warn) so the user can see what the
parser missed. `atan2`, `mod`, and `round` are separate scratch opcodes
(not part of `operator_mathop`) and are intentionally out of scope
here. The lowering lives in `wgsl-emitter.ts:emitMathop`; the fixture
`test/.test-fixtures/expo-fixture.sb3` uses `e ^ (ln(2) * v)` to
assemble `pow2`.

### Custom block inlining (Phase 5)

`@compute` regions can reference scratch custom blocks via
`procedure_call`. The pre-parse pipeline
(`src/runtime/gpu-kernel/procedure-inliner.ts`) expands the call site
at parse time, replacing `argument_reporter_string` /
`argument_reporter_boolean` blocks with references to the call-site
argument blocks.

- **Depth limit**: 16 (`MAX_INLINING_DEPTH` in
  `src/utils/constants.ts`). Exceeding this surfaces
  `gpu.procedure_recursion_unsupported` (error, D1 demote).
- **Cycle detection**: visited prototype block id set detects mutual
  recursion independently of depth (Phase 5).
- **Multi-call dispatch**: calling the same custom block N times
  produces N independent regions that share the same compiled WGSL
  pipeline via canonical-key caching. Each call site has its own
  dispatch context with independent `scalarBindings`.
- **User opt-out**: Settings dialog → "Custom Block Inlining" toggle
  (`advanced.customBlockInliningEnabled`, default `true`). When
  disabled, `procedure_call` and `argument_reporter_*` are treated
  as D1-unsafe for that bootstrap pass (D1 demote). Unlike
  `enableWebgpu` / `enableWasm`, **`Set as default` preserves the OFF
  value** so a power user who explicitly disables inlining keeps that
  setting across reloads.

```
define fn_apply_expo (v)
  @compute
  @bind tmp0(0) ro f32
  @bind buff_r(1) rw f32
  ...
  control_repeat (aabb_h)
    @repeat Rx:global_x = aabb_w, repeatPath="0"
    ... pixel work ...

when flag clicked
  call fn_apply_expo (1.0)
  call fn_apply_expo (2.0)
  call fn_apply_expo (3.0)
  ← inlining yields 3 regions, all sharing the same WGSL pipeline
```

Failure modes:

| Diagnostic | Severity | Cause |
| --- | --- | --- |
| `gpu.procedure_recursion_unsupported` | error | Inlining depth > 16 OR cycle detected |
| `gpu.procedure_prototype_not_found` | error | `procedure_call` references undefined prototype |

`STORAGE_VERSION` is bumped from `10` to `11`. The `v10 → v11`
migration in `src/lib/persistence.ts:sanitizeAdvanced` seeds
`customBlockInliningEnabled` with `true` for older payloads.

### Phase 5 DSL — Custom Block Inlining

Phase 5 enables `@compute` regions to call custom blocks
(`procedure_call` blocks) by pre-parse inline-expanding them into
the region's body. The expansion is implemented in
`src/runtime/gpu-kernel/procedure-inliner.ts` and triggered at the
`buildBlockSubsetVerdict` boundary:

```scratch
// Scratch defines fn_apply_expo(v) once, with an @compute block
// inside its body. The same prototype is called 3 times from
// when_flag_clicked.

@compute
@bind buff_r(1) rw f32
@bind aabb_w(2) ro f32
@workgroup_size(64)
@repeat R0:global_x = len(aabb_w)
  body:   tmp0 = buff_r[R0] * v     ← `v` is the `argument_reporter_string`
         buff_r[R0] = tmp0
```

Each `procedure_call fn_apply_expo <arg>` site:

1. The inliner finds the `procedures_prototype` whose `proccode`
   matches and copies its body under fresh sprite-local block ids
   (`__tw_inl_<sprite>_<n>`).
2. `argument_reporter_string` / `argument_reporter_boolean` blocks
   inside the prototype body are rewired to point at the call-site's
   argument block — no fresh id allocation, the call-site reference
   is shared across every inlined call site within the same region.
3. `control_repeat` blocks inside the prototype body get an explicit
   fresh → original id remap so `@repeat` directives authored against
   a prototype-internal `control_repeat` continue to resolve.

Two defences against runaway / mutual recursion:

- `MAX_INLINING_DEPTH = 16` (exported from
  `src/utils/constants.ts`) caps the deepest possible call chain. A
  chain longer than 16 trips `gpu.procedure_recursion_unsupported`
  immediately, regardless of whether the visited set sees a cycle.
- `visitedPrototypeIds: Set<string>` carries the visited prototype
  block ids. Re-entering an already-visited prototype trips
  `gpu.procedure_recursion_unsupported` at the second visit,
  independent of depth.

Settings → Custom Block Inlining (Phase 5) opts out of the
expansion. The toggle sits in the TurboWasm section right below
Enable WASM and forwards its value through
`bootstrapGpuKernels` → `collectRegionVerdictsFromArrayBuffer` →
`buildBlockSubsetVerdict`. When off, the bootstrap path re-adds
`procedure_call` / `argument_reporter_*` to `GPU_UNSAFE_OPCODES`
for that pre-parse pass so any region that uses a custom block
demotes to the JS path. Unlike `enableWebgpu` / `enableWasm`,
**`Set as default` preserves the OFF value** so a power user who
explicitly disables inlining keeps that setting across reloads.

`STORAGE_VERSION` is bumped from `10` to `11`. The `v10 → v11`
migration in `src/lib/persistence.ts:sanitizeAdvanced` seeds
`customBlockInliningEnabled` with `true` for older payloads.

Kernel-registry consequence — 1 entry × N dispatch context:

When the same custom block is invoked N times via `procedure_call`
and the bodies share directives, the canonical keys collapse
(`KernelRegistry.size() === 1` after registration). Each call
site gets an independent `DispatchSiteContext` carrying the
per-call scalar bindings, registered via
`KernelRegistry.registerDispatchSite(blockId, context)`.

Fixtures and tests:

- `test/.test-fixtures/custom-block-fixture.sb3` (generated by
  `scripts/make-custom-block-fixture.mjs`, registered in
  `scripts/ensure-test-fixtures.mjs`) — one prototype invoked 3
  times; tests assert 3 regions, 1 canonical key, 3 dispatch sites.
- `test/runtime/gpu-kernel/procedure-inliner.test.ts` — hand-crafted
  DTO unit tests covering depth 16/17 boundary, mutual recursion,
  argument-reporter replacement, prototype-not-found, opt-out path.
- `test/runtime/gpu-kernel/kernel-registry-multi-dispatch.test.ts`
  — pins the 1 entry × N dispatch context structure.
- `test/runtime/gpu-kernel/region-extractor-single-pass.test.ts`
  — pins the single-pass extraction invariant (inliner lives in
  `block-subset`, not `region-extractor`).

### Verifying locally

```bash
npm run setup                  # vendored bootstrap (idempotent)
npm run fixtures:setup         # generates all fixtures (expo / expo-nested /
                               # expo-byte-scalar / multi-region / custom-block /
                               # gpu-kernel-diagnostics)
npm run build                  # full build (vendored + wasm + vite)
npm run preview                # serves dist/
npm run verify:gpu-kernel      # canvas compare GPU vs JS path (legacy + nested)
TURBOWASM_VARIANT=legacy npm run verify:gpu-kernel
TURBOWASM_VARIANT=nested npm run verify:gpu-kernel
npm run bench:gpu-kernel       # writes ./logs/bench-gpu-kernel-init.out
RUN_E2E=1 npx vitest run test/e2e/gpu-kernel.test.ts
```

`verify:gpu-kernel` exercises both `legacy` (single-axis Form A) and
`nested` (inner repeat + scalar uniforms) fixtures, each twice (GPU
pass + JS pass). It exits 0 in either case: when WebGPU is available
it compares the canvas pixel buffer of the GPU path against the JS
path with a 1e-6 absolute tolerance; when WebGPU is absent it emits
1×1 placeholder PNGs to `./logs/turbowarp-equivalent-gpu-{default,legacy-only}.png`
and exits 0. The bench script measures pre-parse wall-time and
pipeline cache hits across 10 consecutive loads.

Available fixtures (all regenerated by `npm run fixtures:setup`):

| File | Generator | Purpose |
| --- | --- | --- |
| `expo-fixture.sb3` | `scripts/make-expo-fixture.mjs` | Single-region, loose-position Form A (Phase 4) |
| `expo-fixture-nested.sb3` | `scripts/make-expo-fixture.mjs` (nested) | Nested layout, scalar uniforms (Phase 3) |
| `expo-fixture-byte-scalar.sb3` | `scripts/make-expo-fixture.mjs` (byte-scalar) | `byte` dtype + scalar (Phase 3) |
| `multi-region-fixture.sb3` | `scripts/make-multi-region-fixture.mjs` | Multiple `@compute` regions per sprite (Phase 3) |
| `custom-block-fixture.sb3` | `scripts/make-custom-block-fixture.mjs` | Procedure inlining demo (Phase 5) |
| `gpu-kernel-diagnostics-fixture.sb3` | `scripts/make-gpu-kernel-diagnostics-fixture.mjs` | Diagnostic forwarding (Phase 5 §15.9 / §15.14) |
| `bench-touching.sb3` | `scripts/gen-bench-sb3.mjs` | WASM hot-loop benchmark |
| `svg-sprite-fixture.sb3` | `scripts/make-svg-sprite-fixture.mjs` | DoD Canvas pixel comparison |
| `twconfig-fixture.sb3`, `twconfig-640x480.sb3` | `scripts/make-twconfig-fixture.mjs` etc. | `twconfig` stage-size smoke |
| `repro.sb3` | `scripts/make-repro-fixture.mjs` | ExtensionPermissionDialog smoke |
| `stage-size-sprite-repro.sb3` | `scripts/make-stage-size-sprite-repro.mjs` | twconfig second-load sprite redraw |

### Source layout

```
src/runtime/gpu-kernel/
├── comment-parser.ts            (lexer: @compute directive text → ParsedDirective[])
├── region-extractor.ts          (project.json walk → ExtractedRegion[], single-pass)
├── repeat-path-resolver.ts      (Phase 4: resolve repeatPath="…" to control_repeat id)
├── procedure-inliner.ts         (Phase 5: procedure_call expansion + depth/cycle guard)
├── block-subset.ts              (D1 demote classifier; procedure_call opt-in via inliningEnabled)
├── bound-block-validator.ts     (inliner remaps + validateBoundBlockIds)
├── axis-analysis.ts             (D2 demote per @repeat axis)
├── cascade-analysis.ts          (D3 @map DAG + cycles)
├── scratch-compat.ts            (scratch-compat header + JS reference impls)
├── scratch-block-expr.ts        (Phase 2: scratch block → WGSL expression inverse)
├── scalar-uniform-binding.ts    (Phase 3: @bind ..., scalar → @group(1) @binding(0) struct)
├── wgsl-emitter.ts              (RegionVerdict → WGSL string + emitMathop + emitFormula)
├── list-buffer-binding.ts       (M5: lazy GPU buffer pool + memory pressure detection)
├── kernel-registry.ts           (M5: canonical AST → Pipeline cache; 1 entry × N dispatch)
├── __dispatch-kernel-sync.ts    (M5: pre/post dispatch + sync submit + scalar read)
├── dispatch-formula-evaluator.ts (Phase 3: WGSL formula → JS reducer chain)
├── apply-gpu-kernels.ts         (M5: install window.__turboWasmGpuKernelLookup)
├── initialize-gpu-kernels.ts    (M5: boot WebGPU + emit + register; Phase 5 emitDiagnostics)
├── diagnostic-forwarding.ts     (Phase 5: severity-bucketed routing helper)
├── region-verdict-pipeline.ts   (M6: glue between M3 and M5)
├── formula-rewrite.ts           (Phase E+: name[idx] / len(name) / bool(x) sugar)
├── diagnostic-codes.ts          (16 diagnostic codes; see Diagnostic codes)
├── types.ts                     (Diagnostic, ParsedDirective, RegionVerdict, AxisFinal)
└── index.ts                     (public re-exports)

test/runtime/gpu-kernel/         (mirror of src/, vitest + jsdom)
test/e2e/gpu-kernel.test.ts      (RUN_E2E=1 gated Playwright wrapper)
test/runtime/gpu-kernel-patches.test.ts   (vendored patch regression guard)
test/runtime/gpu-kernel-player-wiring.test.ts (M6 unit tests)

patches/vendored/gpu-kernel-list-binding+0.1.0.patch
patches/vendored/gpu-kernel-runtime+0.1.0.patch

scripts/make-expo-fixture.mjs                (legacy / nested / byte-scalar)
scripts/make-multi-region-fixture.mjs        (Phase 3)
scripts/make-custom-block-fixture.mjs        (Phase 5)
scripts/make-gpu-kernel-diagnostics-fixture.mjs (Phase 5 §15.9/§15.14)
scripts/verify-gpu-kernel.mjs                (canvas compare GPU vs JS path)
scripts/bench-gpu-kernel-init.mjs            (pre-parse wall-time + cache hits)
```

**Removed in Phase 4**: the `implicit-axis.ts` module
(`collectImplicitAxes`), the `findKernelContainer` ancestor-promotion
function, the `nestedRepeatContainerBlockIds` field, and the
`advanced.nestedParallelizationEnabled` Settings toggle. Form A
(`@compute` on `control_repeat` self) + `repeatPathTable` resolver
supersede them.

### Storage schema (cumulative history)

The `localStorage` blob under `tw-viewer:settings:v1` carries an
explicit `version` field. Migrations run on read; older payloads are
folded forward silently. Current `STORAGE_VERSION = 11`
(`src/utils/constants.ts`). Each bump:

- v2: split `advanced` (runtime state) and `defaultAdvanced` (saved defaults).
- v3: top-level `performanceMode` added.
- v4: `advanced.svgAccelerationMode` added (Stage 2).
- v5: top-level `userExplicitFps` added (Alt+Flag round-trip).
- v6: `svgAccelerationMode` retired; `performanceMode: 'force-webgpu'` downgraded to `'auto'`.
- v7: `advanced.enableGpuKernels` added (M1 of GPU kernel plan).
- v8: top-level `performanceMode` collapsed into `enableWasm: boolean`; `enableGpuKernels` renamed to `enableWebgpu`.
- v9: `advanced.nestedParallelizationEnabled` added (Phase 4 nested `@compute` opt-in).
- v10: `nestedParallelizationEnabled` retired (Phase 4 BREAKING) — silently dropped on read.
- v11: `advanced.customBlockInliningEnabled: boolean` added (Phase 5 inlining opt-out, default `true`). v10→v11 migration seeds `true` if unset.

`!clear-storage` debug command drops the entire blob.

## Breaking Changes

### Phase 4 (combined with v9 nested parallelization removal)

`@compute` markers on the **first substack entry block** of a
`control_repeat` are no longer recognised. Move the marker to the
`control_repeat` block itself (loose-position form, Form A). Inner
`control_repeat`s that should remain parallel axes must add an
explicit `@repeat R:axis = formula, repeatPath="<numeric path>"`
directive; the kernel container takes `repeatPath="self"` (default).

v9 `advanced.nestedParallelizationEnabled` opt-in toggle has been
removed. The Settings dialog no longer exposes "Nested @compute
(Experimental)". The `v9 → v10` migration in
`src/lib/persistence.ts:sanitizeAdvanced` silently drops the
`nestedParallelizationEnabled` field. The
`nestedRepeatContainerBlockIds` field on `ExtractedRegion` is gone;
`repeatPathTable` replaces it as the resolver's source of truth.

Migration path: regenerate the fixture via
`scripts/make-expo-fixture.mjs` (Form A) or manually move the
`@compute` comment to the `control_repeat` block itself. Projects
that have not migrated emit `gpu.legacy_compute_comment_position`
warn and fall back to the JS path.

### Phase 5 (additive, opt-out available)

`procedure_call` inside `@compute` regions is now inlined by default
(§Phase 5). To opt out, disable "Custom Block Inlining" in Settings.
When the opt-out is active, `procedure_call` and `argument_reporter_*`
are treated as D1-unsafe for that bootstrap pass (D1 demote).
`STORAGE_VERSION` bumps `10 → 11`; the v10 → v11 migration seeds
`customBlockInliningEnabled` with `true`.

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