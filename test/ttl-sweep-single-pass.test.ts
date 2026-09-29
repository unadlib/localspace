import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { LocalSpace } from '../src/localspace';
import { encryptionPlugin, ttlPlugin } from '../src/index';

describe('TTL background sweep', () => {
  it('reads every stored entry once per sweep', async () => {
    const subtle = webcrypto.subtle as unknown as SubtleCrypto;
    const decrypt = vi.fn(subtle.decrypt.bind(subtle));
    const countingSubtle = new Proxy(subtle, {
      get: (target, property) => {
        if (property === 'decrypt') return decrypt;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let expired = 0;
    let sweepExpired!: () => void;
    const swept = new Promise<void>((resolve) => {
      sweepExpired = resolve;
    });
    const store = new LocalSpace({
      name: 'ttl-sweep-single-pass',
      driver: 'memoryStorageWrapper',
      plugins: [
        ttlPlugin({
          keyTTL: { old1: 5, old2: 5 },
          cleanupInterval: 25,
          onExpire: () => {
            expired += 1;
            if (expired === 2) sweepExpired();
          },
        }),
        encryptionPlugin({ key: 'k'.repeat(32), subtle: countingSubtle }),
      ],
    });
    await store.setItems([
      { key: 'old1', value: 1 },
      { key: 'old2', value: 2 },
      { key: 'live1', value: 3 },
      { key: 'live2', value: 4 },
      { key: 'live3', value: 5 },
    ]);
    decrypt.mockClear();

    await swept;
    await store.close();

    expect(decrypt).toHaveBeenCalledTimes(5);
  });
});
