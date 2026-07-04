# TurboWasm Viewer

A minimal, statically-deployed **SB3 viewer** built on top of [TurboWarp Scaffolding](https://github.com/TurboWarp/scaffolding). Phase 1 of a longer-term project to deliver a WASM-accelerated, TurboWarp-compatible runtime viewer.

This project is **not** a Scratch editor — it is a read-only player for `.sb3` projects.

## Features

- Drag & Drop, file picker, and Project ID loading (Scratch / Trampoline).
- TurboWarp Runtime execution via `@turbowarp/scaffolding`.
- Advanced settings (FPS, Interpolation, Warp Timer, High Quality Pen, Turbo Mode, Compiler toggle, Infinity Clones, Remove Fencing, Remove Misc Limits, Stage size) with **immediate apply**.
- `twconfig` parsing from project comments (read-only).
- System / Light / Dark theme with `prefers-color-scheme` support.
- Stage-only Fullscreen mode with overlay controls.
- Project Metadata display (Title / Description / Instructions / Notes and Credits) for Project ID loads.
- Inline error log panel — no toasts or modals.
- `localStorage` persistence for theme, volume, and advanced settings (`tw-viewer:settings:v1`).
- Pluggable Extension registrar interface (add-ons reserved for future).
- Pluggable Cloud Variables provider interface (no-op default; reserved for future).

## Quick start

```bash
npm install
cd vendored/scaffolding && npm install && npm run build && cd ../..
npm run dev      # start dev server
npm run build    # production build → dist/
npm run preview  # preview built output
npm test         # run unit tests
npm run lint     # run ESLint
npm run typecheck
```

### Vendored scaffolding & scratch-render patch

`vendored/scaffolding/node_modules/scratch-render` carries a small in-tree patch
(see `patches/scratch-render+0.1.0.patch`) that guards against the
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
was generated inside `vendored/`).

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
  services/     # external API integrations (scratch-project metadata + data)
  utils/        # pure utilities (clamp, format, constants)
  types/        # shared type definitions
  styles/       # global CSS
```

Feature First architecture: each feature owns its UI and state hooks. Cross-feature imports go through `lib/` / `hooks/` / `stores`.

## Advanced Settings mapping

The Settings dialog maps directly to the TurboWarp VM/Runtime APIs:

| Setting              | Target                                              |
| -------------------- | --------------------------------------------------- |
| FPS                  | `vm.runtime.frameLoop.setFramerate(v)`              |
| Interpolation        | `vm.runtime.frameLoop.setInterpolation(v)`          |
| High Quality Pen     | `vm.renderer.setUseHighQualityRender(v)`            |
| Warp Timer           | `vm.runtime.setCompilerOptions({warpTimer})`        |
| Infinite Clones      | `vm.runtime.setRuntimeOptions({maxClones: ∞})`      |
| Remove Fencing       | `vm.runtime.setRuntimeOptions({fencing: false})`    |
| Remove Misc Limits   | `vm.runtime.setRuntimeOptions({miscLimits: false})` |
| Turbo Mode           | `vm.setTurboMode(v)`                                |
| Disable Compiler     | `vm.runtime.setCompilerOptions({enabled: !v})`      |
| Stage Width / Height | `vm.setStageSize(w, h)`                             |

## Extension points

Future extensions (Addons, Cloud Variables) plug into runtime via two interfaces:

- `src/runtime/extensions.ts` — `addExtensionRegistrar({ id, register })`. Registered callbacks run after `scaffolding.setup()` and before any project load.
- `src/runtime/cloud-provider.ts` — `setCloudProvider(provider)`. The default is a no-op provider.

## Environment variables

| Variable               | Purpose                                   | Default                                 |
| ---------------------- | ----------------------------------------- | --------------------------------------- |
| `VITE_GITHUB_REPO_URL` | Target URL of the GitHub icon (top-right) | `https://github.com/visual27/TurboWasm` |

Vite injects build-time values; changing them requires a rebuild.

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
along with this program. If not, see <https://www.gnu.org/licenses/gpl-3.0.html>.
```

This project contains modified code from:

- [TurboWarp](https://github.com/TurboWarp/) — © Scratch Foundation contributors, GPL-3.0
- [turbowarp.org](https://turbowarp.org/) — © Scratch Foundation contributors, GPL-3.0

This project is **not** affiliated with the official TurboWarp project.

## Acknowledgements

- [TurboWarp](https://turbowarp.org/) for the Scaffolding library and the underlying VM/Runtime.
- [Scratch](https://scratch.mit.edu) for the original project format and APIs.
