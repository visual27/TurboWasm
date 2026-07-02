# Addons (reserved)

This folder is reserved for a future implementation of TurboWarp-style Addons.

The runtime integration point lives in `src/runtime/extensions.ts`:

```ts
import { addExtensionRegistrar, type ExtensionRegistrar } from '@/runtime/extensions';

addExtensionRegistrar({
  id: 'my-addon',
  register(scaffolding) {
    // Register custom blocks / UI / runtime hooks here.
  },
});
```

`applyExtensions()` is invoked exactly once per player instance, immediately after `scaffolding.setup()` completes and before any project is loaded. Registrars that throw are logged via `console.warn` and do not abort the registration of subsequent registrars.

Addons themselves (UI surfaces, settings persistence, per-project feature toggles) are intentionally not implemented in v0.1.