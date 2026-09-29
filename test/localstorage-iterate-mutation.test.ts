import { beforeEach, describe, expect, it } from 'vitest';
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
