# TurboWasm Viewer

A minimal, statically-deployed **SB3 viewer** built on top of [TurboWarp Scaffolding](https://github.com/TurboWarp/scaffolding). The runtime is accelerated by a WASM-SIMD collision-detection pipeline (`TurboWasm Acceleration`) with a 2-way WASM-SIMD ↔ JavaScript fallback chain. Each tier degrades gracefully on environments that do not support it.

This project is **not** a Scratch editor — it is a read-only player for `.sb3` projects.

## Features

- Drag & Drop, file picker, and Project ID loading (Scratch / Trampoline).
- TurboWarp Runtime execution via `@turbowarp/scaffolding`.
- **TurboWasm Acceleration** (see [Advanced Settings mapping](#advanced-settings-mapping)):
  - WASM SIMD batched `isTouchingColor` / `isTouchingDrawables` with per-lane perspective divide.
  - WASM-SIMD ↔ JavaScript 2-tier fallback chain plus a `Performance Mode` selector (`auto` / `force-wasm` / `legacy-only`).
- Advanced settings (FPS, Interpolation, Warp Timer, High Quality Pen, Turbo Mode, Compiler toggle, Infinity Clones, Remove Fencing, Remove Misc Limits, Stage size, **Performance Mode**) with **immediate apply**.
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
schema version 6). The `!reset-performance` debug command reverts the
mode to `auto`; see [Debug commands](#debug-commands) below. A user who
had pinned `'force-webgpu'` before the v6 retirement will be silently
downgraded to `'auto'` on first load — the migration lives in
`src/lib/persistence.ts`.

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