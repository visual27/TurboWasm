# AGENTS.md

Operational guide for agents working on **TurboWasm Viewer** — a static SB3 player built on TurboWarp Scaffolding. Read this before touching the repo.

## Language conventions

- **Conversation with the user is conducted in Japanese.**
- **All in-product / on-page text (UI labels, buttons, dialog copy, error messages, ARIA labels, etc.) must be written in English.** Do not localize these strings to Japanese unless the user explicitly asks for it. Comments in source code are also in English.

## Commit policy

- **ソースコードを編集した場合、必ずコミットのみを行ってください。** `git commit` までは実施しますが、それ以外の副作用のある Git 操作 (push / pull / merge / rebase / reset / force-push / インタラクティブなコマンド、空コミット作成など) は **一切行わないこと**。PR の作成やリモートへの反映が必要な場合は、ユーザーに明示的に依頼を待つこと。

## Repo at a glance

- Single-package Vite + React 18 + TypeScript app (`src/`, `test/`). Static build output → `dist/`. No server runtime.
- Runtime VM = the vendored TurboWarp Scaffolding UMD at `vendored/scaffolding/dist/scaffolding-min.js`. Loaded via `dynamic import('@turbowarp/scaffolding')` from `src/lib/scaffolding.ts`; both `vite.config.ts` and `tsconfig.json` alias the specifier to the vendored UMD (never re-import from `node_modules`).
- `vendored/` is **gitignored**. A bare `npm install` is not enough — see setup below.

## First-time setup — order matters

```bash
npm install
cd vendored/scaffolding && npm install && npm run build && cd ../..
npm run dev      # or `npm run build` for the static output
```

For production-grade rebuilds of the UMD (only when scratch-vm / scratch-render sources change):
```bash
cd vendored/scaffolding && NODE_ENV=production npm run prepublishOnly && cd ../..
```

## Commands

| Command                                      | Purpose                                              | Notes                                                                                 |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`                                | Vite dev server                                      | Default port 5173, falls back to 5174.                                                |
| `npm run build`                              | typecheck (2 tsconfigs) + vite build                 | Produces `dist/`.                                                                     |
| `npm run typecheck`                          | `tsc --noEmit` for src + node                        | Both tsconfigs run in series; both must pass.                                         |
| `npm run lint`                               | `eslint . --max-warnings 0`                          | Warnings are treated as errors.                                                       |
| `npm test`                                   | Vitest single run                                    | 37 files / 337 tests; jsdom env.                                                      |
| `npm run test:watch`                         | Vitest watch                                         |                                                                                       |
| `npm run format`                             | Prettier write                                       | semi, singleQuote, trailingComma=all, printWidth=100, tabWidth=2 (see `.prettierrc`). |
| `npm run apply:scratch-render-patch`         | Re-run patch-package against vendored scratch-render | `postinstall` already invokes it; normally unnecessary.                               |
| `cd vendored/scratch-vm && npm run tap:unit` | scratch-vm upstream tap suite                        | 96 files / 3459 assertions; **not** part of `npm test`.                               |

Recommended order: **typecheck → lint → test → build**.

## Architecture quirks

- **`vendored/` is gitignored.** All scratch-vm / scratch-render edits live there; the UMD at `vendored/scaffolding/dist/scaffolding-min.js` is the shipped artifact.
- **`patches/scratch-render+0.1.0.patch`** is applied by `npm install` via `postinstall` → `scripts/apply-vendored-patches.mjs` → patch-package. The patch adds degenerate-bounds / degenerate-size guards to `RenderWebGL.extractDrawableScreenSpace` and `PenSkin._setCanvasSize` so extensions that drive a drawable into a zero-area state at load time do not crash with `Failed to construct 'ImageData'`. To regenerate after touching the vendored source:
  ```bash
  npx patch-package scratch-render --cwd vendored/scaffolding
  # move the resulting patches/scratch-render+0.1.0.patch to the project root if patch-package writes it inside vendored/
  ```
- **Runtime façade.** All VM integration lives in `src/runtime/player.ts`. Load flow: `useProjectLoader` (file / id / drop) → `player.loadProjectFromArrayBuffer` → on failure, `console.error('[player] loadProject failed:', err)` is logged with full stack, cause chain, and `_loadedExtensions` keys. Watch for that console prefix when debugging load issues.
- **Feature First.** `src/features/<name>/` owns its UI + state hooks. Cross-feature imports go through `src/lib/`, `src/hooks/`, or `src/stores/`. `src/components/ui/` holds shadcn-style primitives built with `class-variance-authority` (cva); new UI primitives go there, not under `features/`.
- **Vite cache.** First `npm run dev` after touching the UMD can serve stale pre-bundled deps from `node_modules/.vite`. Wipe with `rm -rf node_modules/.vite`.
- **No project-root CI workflows** (`.github/workflows/` does not exist). Verify locally with typecheck → lint → test → build before declaring done.
- **Single env var:** `VITE_GITHUB_REPO_URL` (build-time). Nothing else is runtime-configurable.

## TypeScript / React conventions

- `tsconfig.json` enables `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`. Do **not** relax these to silence the compiler.
- Function components return `React.JSX.Element` (or `Promise<void>` for async callbacks) — not implicit returns.
- Hooks, utilities, runtime modules use **named exports**; default exports are reserved for React components.
- `src/components/ui/` primitives use `cva(...)` for variants and `cn(...)` from `src/lib/utils.ts` for class merging. Do not introduce a different variant library.
- `import type { ... } from '...'` for type-only imports — the build relies on `verbatimModuleSyntax` semantics.
- ESLint: `@typescript-eslint/no-explicit-any` is `error`. Prefer `unknown` + narrowing.

## Testing

- Tests mirror `src/` under `test/` (e.g. `src/runtime/player.ts` → `test/runtime/player.test.ts`).
- Vitest config: `environment: 'jsdom'`, `globals: true`. `test/setup.ts` polyfills `Blob.arrayBuffer/text`, `window.matchMedia`, and `ResizeObserver` for jsdom — do not redefine these in individual tests.
- The `errorMessage` and `ProjectLoadError` helpers are exported from `src/runtime/player.ts` specifically for unit testing; cover the non-Error / non-string branches when you touch them.
- `useProjectLoader` and other hooks are commonly mocked at the module level with `vi.mock('@/features/project-loader/useProjectLoader', ...)`. See `test/features/stage/ProjectIdInput.test.tsx` for the pattern.
- Real-device verification is documented in `docs/`. Use Chrome DevTools MCP if available: `new_page` → drop a `.sb3` via the **Select File** button → read `list_console_messages` for `[player] loadProject ...` lines.

## Debug commands (project-ID input)

The project-ID input accepts `!`-prefixed debug commands for local state management without opening DevTools:

| Command                              | Effect                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `!help`                              | List available commands.                                                                |
| `!reset` / `!reset-settings`         | Reset theme, volume, advanced, extension allow-list, and session deny list to defaults. |
| `!reset-advanced`                    | Reset advanced settings + allow-list only.                                             |
| `!reset-theme`                       | Reset theme to `system`.                                                               |
| `!reset-volume`                      | Reset master volume to 100.                                                             |
| `!clear-extensions`                  | Clear the persistent extension allow-list.                                             |
| `!clear-storage`                     | Remove the `tw-viewer:settings:v1` key from `localStorage`.                            |
| `!dump`                              | Log the current settings to the browser console.                                       |

Implementation: `src/features/project-loader/debug-commands.ts`. Handler lives in `ProjectIdInput.tsx`. Unknown commands produce a `warn`-level entry in `ErrorLogPanel`.

## Specification highlights (from `prompt.md`)

The original design spec is `prompt.md` (or `docs/SPEC-001.md` if the team renames it). High-signal rules an agent must not forget:

- **Decision priority (ambiguous specs).** When in doubt:
  1. TurboWarp Scaffolding implementation / README
  2. TurboWarp upstream (turbowarp.org) behavior
  3. Only when (1) and (2) cannot satisfy the static-hosting constraint, add a thin abstraction layer in this repo.

  **Do not write a custom Scratch VM.** All VM / Runtime / Renderer / Extensions come from TurboWarp Scaffolding. If you find yourself adding JS that bypasses the vendored Scaffolding, stop and reconsider.

- **Project ID fetch (CORS-friendly, no proxy).** `src/services/scratch-project.ts` hits the official Scratch API directly from the browser; both endpoints already send `Access-Control-Allow-Origin: *`:
  - `GET https://api.scratch.mit.edu/projects/{id}` — metadata (field is `project_token`, not `token`).
  - `GET https://projects.scratch.mit.edu/{id}?token={project_token}` — sb3 binary.
  Conversion of the returned JSON / binary into a Scaffolding-loadable sb3 lives under `src/services/scratch-project/`. Failures surface through `useErrorLogStore` — no toast, no dialog.

- **`twconfig` marker.** Look for the literal token `// _twconfig_` inside a project comment. The JSON that follows is parsed read-only by `src/runtime/twconfig.ts` and merged into `currentAdvanced`. Unknown keys are silently ignored; malformed JSON does not abort the load. Only the supported keys listed in `twconfig.ts` are honored — anything else is dropped.

- **Storage key.** All UI state is one JSON blob under `localStorage` key `tw-viewer:settings:v1` (`STORAGE_KEYS.settings` in `src/utils/constants.ts`). When bumping the schema, change the suffix (`v2`, …) and write a migration in `src/lib/persistence.ts`.

- **No toasts, no dialogs for runtime errors.** All errors go through the always-visible `ErrorLogPanel` at the bottom of the page (`src/features/error-log/`). `severity === 'error'` is the on/off switch.

- **Extension loading flow.** `src/runtime/extension-urls.ts` reads `extensionURLs` from `project.json` before the VM sees the buffer. If any are present and not in the persistent allow-list (`useSettingsStore.allowedExtensionUrls`), `ExtensionPermissionDialog` opens with per-URL switches, sandbox-mode selector, and **Deny All / Allow Selected / Allow All** buttons. Sandbox mode `'disabled'` triggers `stripProjectExtensions`, which removes `extensions` / `extensionURLs` from `project.json` so the project loads without throwing.

- **Prohibited.** No Next.js, no SSR, no custom Scratch VM, no jQuery, no Bootstrap / Material UI / Chakra UI. `any` is banned (enforced by ESLint). No giant single-file components, no Zustand-store bloat (split selectors instead), no hard-coded URLs or numeric upper bounds (route through `src/utils/constants.ts` and `import.meta.env.VITE_GITHUB_REPO_URL`).

## Where to look first when something breaks

| Symptom                                                          | Look here first                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Failed to construct 'ImageData': ...` at project load           | DevTools console `[player] loadProject ...` lines; `patches/scratch-render+0.1.0.patch`; `vendored/scaffolding/node_modules/scratch-render/src/{RenderWebGL,PenSkin}.js` (around lines 1494 and 475 respectively). |
| Dev server serves stale scaffold                                 | `rm -rf node_modules/.vite`, then `npm run dev`.                                                                                                                                                                   |
| `vendored/scaffolding/dist/scaffolding-min.js` looks out of date | `cd vendored/scaffolding && npm run build` (or `prepublishOnly` for production).                                                                                                                                    |
| Tests pass locally but typecheck fails                           | Look for unused locals / params; `noUnusedLocals` + `noUnusedParameters` are strict.                                                                                                                               |
| Lost patches after `npm install`                                 | Check that `postinstall` ran and that `node_modules/patch-package` is present. Run `npm run apply:scratch-render-patch` manually.                                                                                  |
| Extension permission dialog doesn't appear                        | `ExtensionPermissionDialog` registers its request handler in a mount effect and clears it on unmount — confirm the component is mounted and `App.tsx` renders it inside `<ExtensionPermissionDialog />`.              |
| `Permission to load extension denied: <id>` at load             | URL is not in `allowedExtensionUrls`. Either re-prompt the user or persist via `useSettingsStore.addAllowedExtensionUrl`.                                                                                          |