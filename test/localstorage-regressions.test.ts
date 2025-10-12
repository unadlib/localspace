import { describe, it, expect, beforeEach } from 'vitest';
import localspace from '../src/index';
import type { LocalSpaceInstance } from '../src/types';

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
});
