import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSpace } from '../src/localspace';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndexedDB transaction keep-alive', () => {
  it('keeps transactions alive with bounded count probes', async () => {
    const store = new LocalSpace({
      name: 'keep-alive-probe',
      driver: 'asyncStorage',
    });
    await store.setItems(
      Array.from({ length: 50 }, (_, index) => ({
        key: `k${index}`,
        value: index,
      }))
    );

    const count = vi.spyOn(IDBObjectStore.prototype, 'count');
    await store.runTransaction('readwrite', async (scope) => {
      for (let index = 0; index < 10; index++) {
        await scope.set(
          `k${index}`,
          (await scope.get<number>(`k${index}`))! + 1
        );
      }
    });

    expect(count).toHaveBeenCalled();
    for (const call of count.mock.calls) {
      expect(call).toEqual([['localspace.keep-alive']]);
    }
    count.mockRestore();
    await expect(store.getItem('k9')).resolves.toBe(10);
    await expect(store.length()).resolves.toBe(50);
    await store.close();
  });
});
