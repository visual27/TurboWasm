/// <reference types="vite/client" />

declare module '@turbowarp/scaffolding' {
  // We treat the module's exports as a namespace exposing the Scaffolding class.
  // Concrete typing lives in src/runtime/scaffolding-types.ts and is referenced manually.
  // Using `unknown` here to satisfy the bundler's `any` ban while keeping the surface narrow.
  const Scaffolding: new () => import('@/runtime/scaffolding-types').ScaffoldingInstance;
  export { Scaffolding };
}