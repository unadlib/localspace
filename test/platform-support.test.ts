import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDBDriver } from '../src';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('modern browser support boundary', () => {
  it('does not treat a prefixed-only IndexedDB implementation as supported', async () => {
    const prefixedFactory = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('webkitIndexedDB', prefixedFactory);
    vi.stubGlobal('mozIndexedDB', prefixedFactory);
    vi.stubGlobal('OIndexedDB', prefixedFactory);
    vi.stubGlobal('msIndexedDB', prefixedFactory);

    const support = indexedDBDriver._support;
    const supported =
      typeof support === 'function' ? await support() : Boolean(support);

    expect(supported).toBe(false);
  });
});
