// Polyfill jsdom's File/Blob with arrayBuffer() and text() methods.
// jsdom does not yet implement arrayBuffer()/text() on its Blob wrapper.

import '@testing-library/jest-dom/vitest';

interface JsdomBlob {
  size: number;
  type: string;
  slice(start?: number, end?: number, contentType?: string): JsdomBlob;
  [key: symbol]: unknown;
}

function getInternalBuffer(blob: JsdomBlob): Buffer | null {
  const symbols = Object.getOwnPropertySymbols(blob);
  for (const sym of symbols) {
    const val = (blob as unknown as Record<symbol, unknown>)[sym];
    if (val && typeof val === 'object' && '_buffer' in (val as Record<string, unknown>)) {
      const buf = (val as { _buffer: unknown })._buffer;
      if (Buffer.isBuffer(buf)) return buf;
    }
  }
  return null;
}

function ensureBlobPolyfills(): void {
  if (typeof globalThis.Blob === 'undefined') return;
  const proto = globalThis.Blob.prototype as unknown as Record<string, unknown>;
  if (typeof proto.arrayBuffer === 'function' && typeof proto.text === 'function') return;
  if (typeof proto.arrayBuffer !== 'function') {
    Object.defineProperty(proto, 'arrayBuffer', {
      value: function arrayBufferPolyfill(this: JsdomBlob): Promise<ArrayBuffer> {
        const buf = getInternalBuffer(this);
        if (buf) {
          const ab = new ArrayBuffer(buf.byteLength);
          new Uint8Array(ab).set(buf);
          return Promise.resolve(ab);
        }
        return Promise.resolve(new ArrayBuffer(0));
      },
      writable: true,
      configurable: true,
    });
  }
  if (typeof proto.text !== 'function') {
    Object.defineProperty(proto, 'text', {
      value: function textPolyfill(this: JsdomBlob): Promise<string> {
        const buf = getInternalBuffer(this);
        if (buf) return Promise.resolve(buf.toString('utf-8'));
        return Promise.resolve('');
      },
      writable: true,
      configurable: true,
    });
  }
}

ensureBlobPolyfills();

// Polyfill matchMedia for jsdom (needed by useTheme hook).
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// Polyfill ResizeObserver for jsdom (needed by StageView/Stage container).
if (typeof globalThis.ResizeObserver === 'undefined') {
  class MockResizeObserver {
    public constructor(_cb: ResizeObserverCallback) {
      // noop constructor
    }
    public observe(): void {
      /* noop */
    }
    public unobserve(): void {
      /* noop */
    }
    public disconnect(): void {
      /* noop */
    }
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver;
}

export {};
