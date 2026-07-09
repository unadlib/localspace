import { beforeEach, describe, expect, it, vi } from 'vitest';
import localspace, { memoryDriver } from '../src/index';
import type { LocalSpaceInstance } from '../src/types';

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

async function createMemoryInstance(
  name = uniqueName('memory'),
  storeName = 'store'
): Promise<LocalSpaceInstance> {
  const instance = localspace.createInstance({ name, storeName });
  await instance.setDriver([instance.MEMORY]);
  await instance.ready();
  await instance.clear();
  return instance;
}

describe('memory driver', () => {
  let name: string;

  beforeEach(() => {
    name = uniqueName('memory-test');
  });

  it('exports a built-in opt-in memory driver', async () => {
    const instance = localspace.createInstance({ name, storeName: 'store' });

    expect(memoryDriver._driver).toBe(instance.MEMORY);
    expect(instance.supports(instance.MEMORY)).toBe(true);

    await instance.setDriver([instance.MEMORY]);
    await instance.ready();

    expect(instance.driver()).toBe(instance.MEMORY);
  });

  it('stores, reads, removes, and clears values', async () => {
    const instance = await createMemoryInstance(name);

    await expect(instance.setItem('string', 'value')).resolves.toBe('value');
    await expect(instance.setItem('undefined', undefined)).resolves.toBe(null);
    await expect(instance.getItem('string')).resolves.toBe('value');
    await expect(instance.getItem('missing')).resolves.toBe(null);
    await expect(instance.getItem('undefined')).resolves.toBe(null);

    await instance.removeItem('string');
    await expect(instance.getItem('string')).resolves.toBe(null);

    await instance.setItem('a', 1);
    await instance.setItem('b', 2);
    await expect(instance.length()).resolves.toBe(3);
    await instance.clear();
    await expect(instance.length()).resolves.toBe(0);
  });

  it('clones values when storing and reading', async () => {
    const instance = await createMemoryInstance(name);
    const original = { nested: { count: 1 } };

    await instance.setItem('object', original);
    original.nested.count = 2;

    const firstRead = await instance.getItem<typeof original>('object');
    expect(firstRead).toEqual({ nested: { count: 1 } });

    firstRead!.nested.count = 3;
    await expect(instance.getItem('object')).resolves.toEqual({
      nested: { count: 1 },
    });
  });

  it('keeps stores shared by name/storeName and isolated by storeName', async () => {
    const storeA = await createMemoryInstance(name, 'shared');
    const storeB = localspace.createInstance({ name, storeName: 'shared' });
    const isolated = await createMemoryInstance(name, 'isolated');

    await storeB.setDriver([storeB.MEMORY]);
    await storeB.ready();

    await storeA.setItem('key', 'shared-value');
    await isolated.setItem('key', 'isolated-value');

    await expect(storeB.getItem('key')).resolves.toBe('shared-value');
    await expect(isolated.getItem('key')).resolves.toBe('isolated-value');
  });

  it('supports batch APIs in input order', async () => {
    const instance = await createMemoryInstance(name);

    await expect(
      instance.setItems([
        { key: 'a', value: 1 },
        { key: 'b', value: undefined },
        { key: 'c', value: 3 },
      ])
    ).resolves.toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: null },
      { key: 'c', value: 3 },
    ]);

    await expect(
      instance.getItems(['c', 'missing', 'a', 'b'])
    ).resolves.toEqual([
      { key: 'c', value: 3 },
      { key: 'missing', value: null },
      { key: 'a', value: 1 },
      { key: 'b', value: null },
    ]);

    await instance.removeItems(['a', 'c']);
    await expect(instance.keys()).resolves.toEqual(['b']);
  });

  it('supports transaction helpers and rolls back failed readwrite transactions', async () => {
    const instance = await createMemoryInstance(name);
    await instance.setItem('counter', 1);

    await expect(
      instance.runTransaction('readwrite', async (tx) => {
        const current = (await tx.get<number>('counter')) ?? 0;
        await tx.set('counter', current + 1);
        return tx.get<number>('counter');
      })
    ).resolves.toBe(2);

    await expect(
      instance.runTransaction('readwrite', async (tx) => {
        await tx.set('counter', 99);
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');

    await expect(instance.getItem('counter')).resolves.toBe(2);

    await expect(
      instance.runTransaction('readonly', async (tx) => {
        await tx.set('counter', 3);
      })
    ).rejects.toMatchObject({ code: 'TRANSACTION_READONLY' });
  });

  it('rejects unsupported transaction modes without invoking the runner', async () => {
    const instance = await createMemoryInstance(name);
    const runner = vi.fn();

    await expect(
      instance.runTransaction('versionchange' as never, runner)
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { transactionMode: 'versionchange' },
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('drops the current store or all stores for a name', async () => {
    const storeA = await createMemoryInstance(name, 'a');
    const storeB = await createMemoryInstance(name, 'b');

    await storeA.setItem('key', 'a');
    await storeB.setItem('key', 'b');

    await storeA.dropInstance();
    await expect(storeA.getItem('key')).resolves.toBe(null);
    await expect(storeB.getItem('key')).resolves.toBe('b');

    await storeA.setItem('key', 'a2');
    await storeA.dropInstance({ name });

    await expect(storeA.getItem('key')).resolves.toBe(null);
    await expect(storeB.getItem('key')).resolves.toBe(null);
  });

  it('can be used as an explicit fallback driver', async () => {
    const instance = localspace.createInstance({ name, storeName: 'fallback' });

    await instance.setDriver(['missing-driver', instance.MEMORY] as string[]);
    await instance.ready();
    await instance.setItem('key', 'value');

    expect(instance.driver()).toBe(instance.MEMORY);
    await expect(instance.getItem('key')).resolves.toBe('value');
  });

  it('takes over when an earlier supported driver fails during initialization', async () => {
    const instance = localspace.createInstance({
      name,
      storeName: 'init-fallback',
    });
    const failingDriverName = uniqueName('supported-but-blocked');
    const failingDriver = {
      _driver: failingDriverName,
      _initStorage: vi.fn().mockRejectedValue(new Error('storage blocked')),
      _support: true,
      iterate: vi.fn().mockResolvedValue(undefined),
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockImplementation(async (_key, value) => value),
      removeItem: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      length: vi.fn().mockResolvedValue(0),
      key: vi.fn().mockResolvedValue(null),
      keys: vi.fn().mockResolvedValue([]),
    };

    await instance.defineDriver(failingDriver);
    await instance.setDriver([failingDriverName, instance.MEMORY]);
    await instance.ready();
    await instance.setItem('key', 'value');

    expect(instance.driver()).toBe(instance.MEMORY);
    expect(failingDriver._initStorage).toHaveBeenCalled();
    await expect(instance.getItem('key')).resolves.toBe('value');
  });
});
