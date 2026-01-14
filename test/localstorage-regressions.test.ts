import { describe, it, expect, beforeEach, vi } from 'vitest';
import localspace from '../src/index';
import type { LocalSpaceInstance } from '../src/types';
import { LocalSpaceError } from '../src/errors';

async function createLocalStorageInstance(
  name: string,
  storeName: string
): Promise<LocalSpaceInstance> {
  const instance = localspace.createInstance({ name, storeName });
  await instance.setDriver([instance.LOCALSTORAGE]);
  await instance.ready();
  return instance;
}

describe('localStorage driver regressions', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('matches localforage dropInstance() behaviour when called without options', async () => {
    const name = `drop-default-${Math.random().toString(36).slice(2)}`;
    const storeName = 'store';
    const instance = await createLocalStorageInstance(name, storeName);

    await instance.setItem('alpha', 'value-a');
    expect(await instance.length()).toBe(1);

    await expect(instance.dropInstance()).resolves.toBeUndefined();

    const freshInstance = await createLocalStorageInstance(name, storeName);
    expect(await freshInstance.length()).toBe(0);
  });

  it('clears all stores for a name when only name is provided', async () => {
    const name = `drop-by-name-${Math.random().toString(36).slice(2)}`;
    const storeA = 'storeA';
    const storeB = 'storeB';

    const instanceA = await createLocalStorageInstance(name, storeA);
    const instanceB = await createLocalStorageInstance(name, storeB);

    await instanceA.setItem('foo', 'alpha');
    await instanceB.setItem('bar', 'beta');

    await expect(instanceA.dropInstance({ name })).resolves.toBeUndefined();

    const freshA = await createLocalStorageInstance(name, storeA);
    const freshB = await createLocalStorageInstance(name, storeB);
    expect(await freshA.length()).toBe(0);
    expect(await freshB.length()).toBe(0);
  });

  it('scopes dropInstance to the provided storeName', async () => {
    const name = `drop-by-store-${Math.random().toString(36).slice(2)}`;
    const storeA = 'storeA';
    const storeB = 'storeB';

    const instanceA = await createLocalStorageInstance(name, storeA);
    const instanceB = await createLocalStorageInstance(name, storeB);

    await instanceA.setItem('foo', 'alpha');
    await instanceB.setItem('bar', 'beta');

    await expect(
      instanceA.dropInstance({ name, storeName: storeA })
    ).resolves.toBeUndefined();

    const freshA = await createLocalStorageInstance(name, storeA);
    const freshB = await createLocalStorageInstance(name, storeB);
    expect(await freshA.length()).toBe(0);
    expect(await freshB.length()).toBe(1);
    expect(await freshB.getItem('bar')).toBe('beta');
  });

  it('maps setItems quota errors to QUOTA_EXCEEDED', async () => {
    const name = `quota-${Math.random().toString(36).slice(2)}`;
    const store = await createLocalStorageInstance(name, 'store');

    const quotaError = new Error('quota hit');
    (quotaError as any).name = 'QuotaExceededError';

    // Pre-existing data that must survive a failed batch
    await store.setItem('existing', 'keep-me');

    const setSpy = vi
      .spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementationOnce(() => {
        throw quotaError;
      });

    let caught: any;
    try {
      await store.setItems([
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' },
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LocalSpaceError);
    expect((caught as LocalSpaceError).code).toBe('QUOTA_EXCEEDED');

    // No partial writes
    expect(await store.getItem('k1')).toBe(null);
    expect(await store.getItem('k2')).toBe(null);
    expect(await store.getItem('existing')).toBe('keep-me');

    await expect(
      store.setItems([{ key: 'k3', value: 'v3' }])
    ).resolves.toBeDefined();

    setSpy.mockRestore();
  });
});
