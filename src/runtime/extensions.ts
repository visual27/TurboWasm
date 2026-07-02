export interface ExtensionRegistrar {
  /** Stable identifier for diagnostics. */
  id: string;
  /** Called once after Scaffolding.setup() completes and before any project is loaded. */
  register(scaffolding: import('@/runtime/scaffolding-types').ScaffoldingInstance): void;
}

const registrars: ExtensionRegistrar[] = [];

export function addExtensionRegistrar(registrar: ExtensionRegistrar): void {
  registrars.push(registrar);
}

export function applyExtensions(
  scaffolding: import('@/runtime/scaffolding-types').ScaffoldingInstance,
): void {
  for (const r of registrars) {
    try {
      r.register(scaffolding);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[extensions] registrar '${r.id}' failed:`, err);
    }
  }
}

export function listExtensionRegistrars(): readonly ExtensionRegistrar[] {
  return registrars;
}