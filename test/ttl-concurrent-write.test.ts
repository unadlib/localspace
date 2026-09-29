import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { LocalSpace } from '../src/localspace';
import { encryptionPlugin, ttlPlugin } from '../src/index';

// Holds the next decrypt open so a write can land between the driver read of
// an expired value and TTL's removal of it.
const createGatedSubtle = () => {
  const subtle = webcrypto.subtle as unknown as SubtleCrypto;
  let gate: { reached: () => void; released: Promise<void> } | null = null;
  const gated = new Proxy(subtle, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'decrypt') {
        return async (...args: Parameters<SubtleCrypto['decrypt']>) => {
          const current = gate;
          if (current) {
            gate = null;
            current.reached();
            await current.released;
          }
          return target.decrypt(...args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const hold = () => {
    let release!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    gate = {
      reached,
      released: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    return { reached: reachedPromise, release };
  };
  return { subtle: gated, hold };
};

const drivers = [
  'asyncStorage',
  'memoryStorageWrapper',
  'localStorageWrapper',
] as const;

describe('TTL expiry with concurrent writes', () => {
  for (const driver of drivers) {
    it(`keeps a fresh value written after the expired read (${driver})`, async () => {
      const { subtle, hold } = createGatedSubtle();
      const onExpire = vi.fn();
      const store = new LocalSpace({
        name: `ttl-concurrent-${driver}`,
        driver,
        plugins: [
          ttlPlugin({ defaultTTL: 40, onExpire }),
          encryptionPlugin({ key: 'k'.repeat(32), subtle }),
        ],
      });
      await store.setItem('session', 'old');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const gate = hold();
      const read = store.getItem('session');
      await gate.reached;
      await store.setItem('session', 'fresh');
      gate.release();

      await expect(read).resolves.toBeNull();
      await expect(store.getItem('session')).resolves.toBe('fresh');
      expect(onExpire).not.toHaveBeenCalled();
      await store.close();
    });
  }

  it('keeps fresh values written during an expired batch read', async () => {
    const { subtle, hold } = createGatedSubtle();
    const onExpire = vi.fn();
    const store = new LocalSpace({
      name: 'ttl-concurrent-batch',
      driver: 'asyncStorage',
      plugins: [
        ttlPlugin({ defaultTTL: 40, onExpire }),
        encryptionPlugin({ key: 'k'.repeat(32), subtle }),
      ],
    });
    await store.setItems([
      { key: 'first', value: 'old' },
      { key: 'second', value: 'old' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const gate = hold();
    const read = store.getItems(['first', 'second']);
    await gate.reached;
    await store.setItem('first', 'fresh');
    gate.release();

    await expect(read).resolves.toEqual([
      { key: 'first', value: null },
      { key: 'second', value: null },
    ]);
    await expect(store.getItem('first')).resolves.toBe('fresh');
    await expect(store.keys()).resolves.toEqual(['first']);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith('second', 'old');
    await store.close();
  });
});
