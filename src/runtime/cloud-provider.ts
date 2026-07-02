/**
 * Pluggable Cloud Variables provider interface.
 *
 * In v1 this is a no-op (the Scaffolding internal cloud manager is used).
 * Future versions can register a real provider via `setCloudProvider`.
 */
export interface CloudProvider {
  readonly id: string;
  connect?(): void;
  disconnect?(): void;
  postVariable?(name: string, value: string | number | boolean): void;
  onUpdate?(listener: (name: string, value: string | number | boolean) => void): () => void;
}

export const noopCloudProvider: CloudProvider = {
  id: 'noop',
};

let activeProvider: CloudProvider = noopCloudProvider;

export function setCloudProvider(provider: CloudProvider): void {
  activeProvider = provider;
}

export function getCloudProvider(): CloudProvider {
  return activeProvider;
}

export function resetCloudProvider(): void {
  activeProvider = noopCloudProvider;
}