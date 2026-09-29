import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalSpace } from '../src/localspace';
import { ttlPlugin } from '../src/index';

describe('localStorage iterate with concurrent mutation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('visits every entry when the iterator removes the current key', async () => {
    const store = new LocalSpace({
      name: 'iterate-remove',
      driver: 'localStorageWrapper',
    });
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const key of keys) {
      await store.setItem(key, key);
    }

    const visited: string[] = [];
    await store.iterate(async (_value, key) => {
      visited.push(key);
      await store.removeItem(key);
    });

    expect(visited.sort()).toEqual(keys);
    expect(await store.keys()).toEqual([]);
  });

  it('skips entries removed before they are reached', async () => {
    const store = new LocalSpace({
      name: 'iterate-skip-removed',
      driver: 'localStorageWrapper',
    });
    for (const key of ['a', 'b', 'c']) {
      await store.setItem(key, key);
    }

    const visited: Array<[string, unknown]> = [];
    await store.iterate(async (value, key) => {
      visited.push([key, value]);
      if (visited.length === 1) {
        for (const other of ['a', 'b', 'c']) {
          if (other !== key) await store.removeItem(other);
        }
      }
    });

    expect(visited).toHaveLength(1);
  });

  it('keeps live TTL entries that follow expired ones', async () => {
    const store = new LocalSpace({
      name: 'iterate-ttl',
      driver: 'localStorageWrapper',
      plugins: [ttlPlugin({ keyTTL: { a: 5, c: 5 } })],
    });
    for (const key of ['a', 'b', 'c', 'd']) {
      await store.setItem(key, key);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));

    const visited: string[] = [];
    await store.iterate((_value, key) => {
      visited.push(key);
    });

    expect(visited.sort()).toEqual(['b', 'd']);
    expect((await store.keys()).sort()).toEqual(['b', 'd']);
  });
});

describe('localStorage removal with unstable native key order', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Chromium may reorder localStorage keys after a removal; reverse the
  // native order on every removal to model that.
  const reorderKeysAfterRemoval = () => {
    let removals = 0;
    const removeItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key: string
    ) {
      removals += 1;
      removeItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'key').mockImplementation(function (
      this: Storage,
      index: number
    ) {
      const keys = Object.keys(this).sort();
      if (removals % 2 === 1) keys.reverse();
      return keys[index] ?? null;
    });
  };

  for (const operation of ['clear', 'dropInstance'] as const) {
    it(`${operation}() removes every entry`, async () => {
      const store = new LocalSpace({
        name: `unstable-order-${operation}`,
        storeName: 'items',
        driver: 'localStorageWrapper',
      });
      for (const key of ['a', 'b', 'c', 'd', 'e']) {
        await store.setItem(key, key);
      }
      reorderKeysAfterRemoval();

      await store[operation]();

      expect(
        Object.keys(localStorage).filter((key) =>
          key.startsWith(`unstable-order-${operation}/`)
        )
      ).toEqual([]);
    });
  }
});
