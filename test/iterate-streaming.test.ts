import { describe, expect, it, vi } from 'vitest';
import localspace, {
  LocalSpace,
  ttlPlugin,
  type Driver,
  type LocalSpacePlugin,
  type StorageValue,
} from '../src';

const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const createCountingDriver = (
  name: string,
  itemCount: number,
  onVisit: () => void
): Driver => {
  const values = new Map<string, StorageValue>(
    Array.from({ length: itemCount }, (_, index) => [`key-${index}`, index])
  );
  return {
    _driver: name,
    _support: true,
    _initStorage: async () => undefined,
    getItem: async <T extends StorageValue>(key: string) =>
      (values.get(key) as T | undefined) ?? null,
    setItem: async <T extends StorageValue>(key: string, value: T) => {
      values.set(key, value);
      return value;
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
    clear: async () => {
      values.clear();
    },
    length: async () => values.size,
    key: async (index: number) => [...values.keys()][index] ?? null,
    keys: async () => [...values.keys()],
    iterate: async <T extends StorageValue, U>(
      iterator: (
        value: T,
        key: string,
        iterationNumber: number
      ) => U | Promise<U>
    ) => {
      let iterationNumber = 1;
      for (const [key, value] of values) {
        onVisit();
        const result = await iterator(value as T, key, iterationNumber++);
        if (result !== undefined) return result;
      }
      return undefined;
    },
  };
};

describe('bounded and asynchronous iteration', () => {
  it.each([
    ['without plugins', []],
    [
      'with plugins',
      [{ name: 'iterate-observer', beforeIterate: () => undefined }],
    ],
  ] as Array<[string, LocalSpacePlugin[]]>)(
    'stops the driver at the first requested item %s',
    async (_label, plugins) => {
      let rawVisits = 0;
      const driver = createCountingDriver(
        uniqueName('counting-iterate'),
        1_000,
        () => {
          rawVisits += 1;
        }
      );
      const store = new LocalSpace({
        driver: driver._driver,
        drivers: [driver],
        plugins,
      });

      await expect(store.iterate(() => 'stop')).resolves.toBe('stop');
      expect(rawVisits).toBe(1);
      await store.close();
    }
  );

  it.each(['MEMORY', 'LOCALSTORAGE', 'INDEXEDDB'] as const)(
    'awaits callbacks that continue on %s',
    async (driverConstant) => {
      const name = uniqueName(`async-iterate-${driverConstant}`);
      const store = localspace.createInstance({ name, storeName: 'store' });
      await store.setDriver([store[driverConstant]]);
      await store.setItems([
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
        { key: 'c', value: 3 },
      ]);

      const visited: string[] = [];
      await store.iterate(async (_value, key) => {
        await Promise.resolve();
        visited.push(key);
      });

      expect(visited).toHaveLength(3);
      await store.dropInstance({ name, storeName: 'store' });
      await store.close();
    }
  );

  it('bounds IndexedDB cursor reads before an early stop', async () => {
    const name = uniqueName('bounded-idb-iterate');
    const store = localspace.createInstance({ name, storeName: 'store' });
    await store.setDriver([store.INDEXEDDB]);
    const itemCount = 200;
    await store.setItems(
      Array.from({ length: itemCount }, (_, index) => ({
        key: `key-${String(index).padStart(3, '0')}`,
        value: index,
      }))
    );
    const continueSpy = vi.spyOn(IDBCursor.prototype, 'continue');

    await expect(store.iterate(() => 'stop')).resolves.toBe('stop');

    expect(continueSpy.mock.calls.length).toBeLessThan(itemCount - 1);
    continueSpy.mockClear();
    await expect(
      store.runTransaction('readonly', (scope) =>
        scope.iterate(() => 'transaction-stop')
      )
    ).resolves.toBe('transaction-stop');
    expect(continueSpy.mock.calls.length).toBeLessThan(itemCount - 1);
    continueSpy.mockRestore();
    await store.dropInstance({ name, storeName: 'store' });
    await store.close();
  });

  it('lets TTL remove an expired Memory item during streaming iteration', async () => {
    const name = uniqueName('ttl-streaming-iterate');
    const store = localspace.createInstance({
      name,
      storeName: 'store',
      plugins: [ttlPlugin({ defaultTTL: 1 })],
    });
    await store.setDriver([store.MEMORY]);
    await store.setItem('expired', 'value');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const callback = vi.fn();

    await expect(
      Promise.race([
        store.iterate(callback),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('iteration timed out')), 500)
        ),
      ])
    ).resolves.toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    await expect(store.length()).resolves.toBe(0);
    await store.close();
  });

  it('rolls back when an IndexedDB transaction iterator throws synchronously', async () => {
    const name = uniqueName('throwing-transaction-iterate');
    const store = localspace.createInstance({ name, storeName: 'store' });
    await store.setDriver([store.INDEXEDDB]);
    await store.setItem('seed', true);

    await expect(
      store.runTransaction('readwrite', async (scope) => {
        await scope.set('rolled-back', true);
        await scope.iterate(() => {
          throw new Error('iterator failed');
        });
      })
    ).rejects.toThrow('iterator failed');
    await expect(store.getItem('rolled-back')).resolves.toBeNull();

    await store.dropInstance({ name, storeName: 'store' });
    await store.close();
  });
});
