# `src/features/addons`

This directory is reserved for **future** user-facing addons (Scratch-like
extensions, custom menus, debugger overlays). The interface exists at
`src/runtime/extensions.ts` (`addExtensionRegistrar({ id, register })`) so
a future addon can wire into the Scaffolding runtime without changing the
core, but no addon ships in this commit.

The `README.md` placeholder exists so the directory is tracked in git
even though it contains zero source files — `git` does not track empty
directories, so the file is the smallest possible keep-alive. Once an
addon lands, move its source files here and replace this file with a
proper README describing the addon.