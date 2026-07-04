# AGENTS.md

Operational guide for agents working on **TurboWasm Viewer** — a static SB3 player built on TurboWarp Scaffolding. Read this before touching the repo.

## TL;DR

- Static Vite + React 18 + TS app. Output → `dist/`. No server runtime.
- Runtime VM = vendored TurboWarp Scaffolding UMD. `vendored/` is **gitignored**, so `npm install` alone is **not enough** — see **Setup** below.
- Architecture: `src/features/<name>/` owns UI + state. Cross-feature imports go through `src/lib/`, `src/hooks/`, `src/stores/`. shadcn-style primitives live in `src/components/ui/` (use `cva` + `cn` from `src/lib/utils.ts`).
- All runtime errors → `ErrorLogPanel` (always visible). **No toasts, no modals.**
- All UI state → one JSON blob at `localStorage` key `tw-viewer:settings:v1` (`STORAGE_KEYS.settings`).
- Verify locally before declaring done: `npm run typecheck && npm run lint && npm test && npm run build`. **No CI workflows exist.**
- Real-device smoke test: Chrome DevTools MCP → `new_page` → drop `.sb3` or open `…/#<id>` → `list_console_messages` and look for `[player] loadProject …` lines.

## Language conventions

- **Conversation with the user is conducted in Japanese.**
- **All in-product text (UI labels, dialog copy, error messages, ARIA, etc.) must be written in English.** Do not localize unless explicitly asked. Source-code comments are also in English.

## Commit policy

- **ソースコードを編集した場合、必ずコミットのみを行ってください。** `git commit` までは実施しますが、それ以外の副作用のある Git 操作 (push / pull / merge / rebase / reset / force-push / インタラクティブなコマンド、空コミット作成など) は **一切行わないこと**。PR の作成やリモートへの反映はユーザーからの明示的な依頼を待つこと。

## Setup — order matters

```bash
npm install
cd vendored/scaffolding && npm install && npm run build && cd ../..
npm run dev      # or `npm run build` for the static output
```

`vendored/scaffolding/dist/scaffolding-min.js` is the shipped VM. Both `vite.config.ts` and `tsconfig.json` alias `@turbowarp/scaffolding` to this UMD (never re-import from `node_modules`).

For production-grade rebuilds (only when scratch-vm / scratch-render sources change):
```bash
cd vendored/scaffolding && NODE_ENV=production npm run prepublishOnly && cd ../..
```

## Commands

| Command | Purpose | Notes |
| --- | --- | --- |
| `npm run dev` | Vite dev server | Port 5173, falls back to 5174 / 5175. |
| `npm run build` | typecheck (2 tsconfigs) + vite build | Produces `dist/`. |
| `npm run typecheck` | `tsc --noEmit` for src + node | Both tsconfigs in series; both must pass. |
| `npm run lint` | `eslint . --max-warnings 0` | Warnings are errors. |
| `npm test` | Vitest single run | 37 files / 354 tests; jsdom env. |
| `npm run format` | Prettier write | semi, singleQuote, trailingComma=all, printWidth=100, tabWidth=2. |
| `npm run apply:scratch-render-patch` | Re-run patch-package | `postinstall` already does this. |
| `cd vendored/scratch-vm && npm run tap:unit` | scratch-vm upstream tap | 96 files / 3459 assertions; **not** part of `npm test`. |

Recommended verification order: **typecheck → lint → test → build**.

## Architecture & conventions

- **Vendored runtime.** `vendored/` is gitignored. The shipped artifact is the UMD at `vendored/scaffolding/dist/scaffolding-min.js`. `patches/scratch-render+0.1.0.patch` adds degenerate-bounds / degenerate-size guards to `RenderWebGL.extractDrawableScreenSpace` and `PenSkin._setCanvasSize` (otherwise extensions can crash with `Failed to construct 'ImageData'`). To regenerate after touching vendored source:
  ```bash
  npx patch-package scratch-render --cwd vendored/scaffolding
  # move patches/scratch-render+0.1.0.patch to project root if patch-package wrote it inside vendored/
  ```
- **Scaffolding never emits `ASSET_PROGRESS`.** The minified bundle defines the constant but never dispatches it, and scratch-storage's `load(assetType, assetId, dataFormat)` has no `onProgress` argument. Without intervention, `LoadingProgress` stays in the indeterminate state for the entire load. `loadProjectFromArrayBuffer` in `src/runtime/player.ts` drives the bar manually: `setAssetProgress(0, 1)` right before `attachedScaffolding.loadProject` and `setAssetProgress(1, 1)` right after, then `useProjectStore.setReadyFromId` (or `setReadyFromFile`) unmounts the overlay. **Do not** remove these calls without first verifying an alternative progress source.
- **Scaffolding leaks monitor DOM nodes.** `_monitors` Map and `_monitorOverlay` children are never removed on `MONITORS_UPDATE` (the empty event from `runtime.dispose()` is a no-op). `resetScaffoldingMonitors(scaffolding)` in `src/runtime/player.ts` is exported (for tests) and called immediately before each `loadProject` so the second project load does not inherit the first project's variable / list monitors.
- **Runtime façade.** All VM integration lives in `src/runtime/player.ts`. Load flow: `useProjectLoader` → `player.loadProjectFromArrayBuffer`. On failure, `console.error('[player] loadProject failed:', err)` is logged with full stack, cause chain, and `_loadedExtensions` keys — watch for that prefix when debugging load issues.
- **Settings reflect to the runtime via `subscribe`, not via a `ref` mirror.** `StageView` subscribes to `useSettingsStore` and passes the live `state.advanced` into `applySettings`. Do **not** re-introduce a `useAdvancedRef` pattern — Zustand's `subscribe` fires synchronously inside `patchAdvanced`, before React's commit phase, so a ref-mirrored snapshot is one tick stale and silently corrupts `vm.setStageSize` / `vm.setFramerate`.
- **Numeric inputs are commit-only.** `NumberField` in `src/features/settings/SettingsDialog.tsx` is a controlled draft. It writes to the store only on blur or Enter; Escape rolls back without committing. Partial keystrokes (`Number("") = 0`) never reach the store. Edit the `NumberField` component rather than calling `patchAdvanced` from raw inputs.
- **Feature First.** `src/features/<name>/` owns its UI + state hooks. Cross-feature imports go through `src/lib/`, `src/hooks/`, `src/stores/`. New shadcn-style primitives go in `src/components/ui/`, **not** under `features/`.
- **TS strict.** `tsconfig.json` enables `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, plus `verbatimModuleSyntax` semantics. Do **not** relax these to silence the compiler. ESLint: `@typescript-eslint/no-explicit-any` is `error`; prefer `unknown` + narrowing.
- **Component shape.** Function components return `React.JSX.Element` (or `Promise<void>` for async callbacks) — no implicit returns. Hooks, utilities, runtime modules use **named exports**; default exports are reserved for React components.
- **`cva` + `cn`.** `src/components/ui/` primitives use `cva(...)` for variants and `cn(...)` from `src/lib/utils.ts` for class merging. Do not introduce a different variant library.
- **Single env var.** `VITE_GITHUB_REPO_URL` (build-time, via `src/utils/constants.ts` `ENV.githubRepoUrl`). Nothing else is runtime-configurable.
- **No project-root CI workflows.** `.github/workflows/` does not exist. Verify locally.

## Testing

- Tests mirror `src/` under `test/` (e.g. `src/runtime/player.ts` → `test/runtime/player.test.ts`).
- Vitest config: `environment: 'jsdom'`, `globals: true`. `test/setup.ts` polyfills `Blob.arrayBuffer/text`, `window.matchMedia`, and `ResizeObserver` for jsdom — **do not redefine these in individual tests.**
- `src/runtime/player.ts` exports `errorMessage`, `ProjectLoadError`, and `resetScaffoldingMonitors` helpers specifically for unit testing; cover the non-Error / non-string branches when you touch them.
- `useProjectLoader` and other hooks are commonly mocked at the module level with `vi.mock('@/features/project-loader/useProjectLoader', ...)`. See `test/features/stage/ProjectIdInput.test.tsx` for the pattern.
- Single test run: `npx vitest run test/features/settings/SettingsDialog.test.tsx` etc. — useful when iterating on a specific file.

## Debug commands (project-ID input)

The project-ID input accepts `!`-prefixed commands for local state management without opening DevTools:

| Command | Effect |
| --- | --- |
| `!help` | List available commands. |
| `!reset` / `!reset-settings` | Reset theme, volume, advanced, extension allow-list, session deny list. |
| `!reset-advanced` | Reset advanced settings + allow-list only. |
| `!reset-theme` | Reset theme to `system`. |
| `!reset-volume` | Reset master volume to 100. |
| `!clear-extensions` | Clear the persistent extension allow-list. |
| `!clear-storage` | Remove the `tw-viewer:settings:v1` key from `localStorage`. |
| `!dump` | Log current settings to the browser console. |

Implementation: `src/features/project-loader/debug-commands.ts`. Handler lives in `ProjectIdInput.tsx`. Unknown commands produce a `warn`-level entry in `ErrorLogPanel`.

## Specification rules (don't violate)

- **Decision priority for ambiguous specs:**
  1. TurboWarp Scaffolding implementation / README
  2. TurboWarp upstream (turbowarp.org) behavior
  3. Only when (1) and (2) cannot satisfy the static-hosting constraint, add a thin abstraction in this repo.

  **Do not write a custom Scratch VM.** All VM / Runtime / Renderer / Extensions come from the vendored Scaffolding. If you're about to add JS that bypasses it, stop and reconsider.

- **Project ID fetch (CORS-friendly, no proxy).** `src/services/scratch-project.ts` hits the official Scratch API directly:
  - `GET https://api.scratch.mit.edu/projects/{id}` — metadata (field is `project_token`, not `token`)
  - `GET https://projects.scratch.mit.edu/{id}?token={project_token}` — sb3 binary
  - Failures surface through `useErrorLogStore` — **no toast, no dialog.**
  - For real-device smoke tests, `http://localhost:5173/#<project-id>` triggers the load through `useProjectUrlSync` automatically.
- **`twconfig` marker.** Look for the literal token `// _twconfig_` inside a project comment. The JSON that follows is parsed read-only by `src/runtime/twconfig.ts` and merged into `currentAdvanced`. Unknown keys are silently ignored; malformed JSON does not abort the load. Only the supported keys listed in `twconfig.ts` are honored.
- **Storage schema.** `tw-viewer:settings:v1` (`STORAGE_KEYS.settings` in `src/utils/constants.ts`). To bump schema, change the suffix (`v2`, …) and add a migration in `src/lib/persistence.ts`.
- **No toasts, no dialogs for runtime errors.** All errors go through `ErrorLogPanel` at the bottom of the page (`src/features/error-log/`). `severity === 'error'` is the on/off switch.
- **Extension loading flow.** `src/runtime/extension-urls.ts` reads `extensionURLs` from `project.json` before the VM sees the buffer. If any are present and not in the persistent allow-list (`useSettingsStore.allowedExtensionUrls`), `ExtensionPermissionDialog` opens with per-URL switches, sandbox-mode selector, and **Deny All / Allow Selected / Allow All** buttons. Sandbox mode `'disabled'` triggers `stripProjectExtensions`, which removes `extensions` / `extensionURLs` from `project.json` so the project loads without throwing.
- **Prohibited.** No Next.js, no SSR, no custom Scratch VM, no jQuery, no Bootstrap / Material UI / Chakra UI. `any` is banned (enforced by ESLint). No giant single-file components, no Zustand-store bloat (split selectors instead), no hard-coded URLs or numeric upper bounds (route through `src/utils/constants.ts` and `import.meta.env.VITE_GITHUB_REPO_URL`).

## Where to look first when something breaks

| Symptom | Look here first |
| --- | --- |
| `Failed to construct 'ImageData': ...` at project load | Console `[player] loadProject …` lines; `patches/scratch-render+0.1.0.patch`; `vendored/scaffolding/node_modules/scratch-render/src/{RenderWebGL,PenSkin}.js` (~lines 1494 and 475). |
| Loading overlay shows "Loading project…" forever (indeterminate spinner, no counter) | The bar is manually driven in `loadProjectFromArrayBuffer`. Check that the two `setAssetProgress` calls (0/1 → 1/1) are still there. Don't try to remove them — Scaffolding will not emit `ASSET_PROGRESS`. |
| First project's variable monitors still visible after loading a second project | `resetScaffoldingMonitors(attachedScaffolding)` must be called immediately before each `loadProject`. See `src/runtime/player.ts` `loadProjectFromArrayBuffer`. |
| Settings change silently reverts to the previous tick's value (stage size unchanged, FPS dropped to single digits) | `StageView` must not mirror `useSettingsStore.advanced` into a `useRef` — Zustand `subscribe` fires synchronously inside `patchAdvanced` and a stale ref snapshot wins. Pass `state.advanced` directly to `applySettings`. |
| Dev server serves stale scaffold | `rm -rf node_modules/.vite`, then `npm run dev`. |
| `vendored/scaffolding/dist/scaffolding-min.js` looks out of date | `cd vendored/scaffolding && npm run build` (or `prepublishOnly` for production). |
| Tests pass locally but typecheck fails | Look for unused locals / params; `noUnusedLocals` + `noUnusedParameters` are strict. |
| Lost patches after `npm install` | Check that `postinstall` ran and `node_modules/patch-package` exists. Run `npm run apply:scratch-render-patch`. |
| Extension permission dialog doesn't appear | `ExtensionPermissionDialog` registers its request handler in a mount effect and clears it on unmount — confirm the component is mounted and `App.tsx` renders it inside `<ExtensionPermissionDialog />`. |
| `Permission to load extension denied: <id>` at load | URL is not in `allowedExtensionUrls`. Either re-prompt the user or persist via `useSettingsStore.addAllowedExtensionUrl`. |
| `NumberField` accepts a value but the store doesn't update | Inputs must be committed (blur / Enter). Raw `onChange` writing to the store was a regression — restore the controlled-draft pattern in `NumberField`. |