import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalSpace } from '../src/localspace';
import localspace from '../src/index';
import type { ReactNativeAsyncStorage } from '../src/types';
import {
  createReactNativeInstance,
  installReactNativeAsyncStorageDriver,
  reactNativeAsyncStorageDriver,
} from '../src/react-native';

class MemoryAsyncStorage implements ReactNativeAsyncStorage {
  private readonly data = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async getAllKeys(): Promise<string[]> {
    return Array.from(this.data.keys());
  }

  async multiGet(keys: string[]): Promise<Array<[string, string | null]>> {
    return keys.map((key) => [
      key,
      this.data.has(key) ? this.data.get(key)! : null,
    ]);
  }

  async multiSet(keyValuePairs: Array<[string, string]>): Promise<void> {
    for (const [key, value] of keyValuePairs) {
      this.data.set(key, value);
    }
  }

  async multiRemove(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.data.delete(key);
    }
  }

  dumpKeys(): string[] {
    return Array.from(this.data.keys());
  }
}

describe('react native async storage driver', () => {
  let asyncStorage: MemoryAsyncStorage;

  const withReactNativeDriver = async (instance: LocalSpace): Promise<void> => {
    await installReactNativeAsyncStorageDriver(instance);
    await instance.setDriver([instance.REACTNATIVEASYNCSTORAGE]);
  };

  beforeEach(() => {
    asyncStorage = new MemoryAsyncStorage();
  });

  it('creates a ready RN instance in one step', async () => {
    const instance = await createReactNativeInstance(localspace, {
      name: 'rn-helper',
      storeName: 'rn_helper',
      reactNativeAsyncStorage: asyncStorage,
    });

    expect(instance.driver()).toBe(instance.REACTNATIVEASYNCSTORAGE);
    await instance.setItem('token', 'abc');
    expect(await instance.getItem('token')).toBe('abc');
  });

  it('prioritizes RN driver even when custom driver order is provided', async () => {
    const instance = await createReactNativeInstance(localspace, {
      name: 'rn-helper-order',
      storeName: 'rn_helper_order',
      reactNativeAsyncStorage: asyncStorage,
      driver: ['localStorageWrapper'],
    });

    expect(instance.driver()).toBe(instance.REACTNATIVEASYNCSTORAGE);
  });

  it('does not redefine driver on repeated install calls', async () => {
    const instance = new LocalSpace({
      name: 'rn-idempotent-install',
      storeName: 'rn_idempotent_install',
      reactNativeAsyncStorage: asyncStorage,
    });
    const defineDriverSpy = vi.spyOn(instance, 'defineDriver');

    await installReactNativeAsyncStorageDriver(instance);
    const firstInstallCalls = defineDriverSpy.mock.calls.length;
    await installReactNativeAsyncStorageDriver(instance);

    expect(defineDriverSpy).toHaveBeenCalledTimes(firstInstallCalls);
  });

  it('selects React Native AsyncStorage when config injects the adapter', async () => {
    const instance = new LocalSpace({
      name: 'rn-configured',
      storeName: 'rn_store',
      reactNativeAsyncStorage: asyncStorage,
    });

    await withReactNativeDriver(instance);
    await instance.ready();

    expect(instance.driver()).toBe(instance.REACTNATIVEASYNCSTORAGE);

    await instance.setItem('foo', { count: 1 });
    await instance.setItem('bar', 'baz');

    expect(await instance.getItem('foo')).toEqual({ count: 1 });
    expect(await instance.length()).toBe(2);
    expect((await instance.keys()).sort()).toEqual(['bar', 'foo']);
    expect(
      asyncStorage.dumpKeys().every((key) => key.includes('rn-configured/'))
    ).toBe(true);
  });

  it('uses multi* methods for batch APIs when available', async () => {
    const instance = new LocalSpace({
      name: 'rn-batch',
      storeName: 'batch_store',
      reactNativeAsyncStorage: asyncStorage,
    });
    await withReactNativeDriver(instance);
    await instance.ready();

    const multiSetSpy = vi.spyOn(asyncStorage, 'multiSet');
    const multiGetSpy = vi.spyOn(asyncStorage, 'multiGet');
    const multiRemoveSpy = vi.spyOn(asyncStorage, 'multiRemove');

    await instance.setItems({
      first: { id: 1 },
      second: { id: 2 },
    });

    const values = await instance.getItems<{ id: number }>([
      'first',
      'second',
      'missing',
    ]);
    await instance.removeItems(['first', 'second']);

    expect(multiSetSpy).toHaveBeenCalled();
    expect(multiGetSpy).toHaveBeenCalled();
    expect(multiRemoveSpy).toHaveBeenCalled();
    expect(values).toEqual([
      { key: 'first', value: { id: 1 } },
      { key: 'second', value: { id: 2 } },
      { key: 'missing', value: null },
    ]);
    expect(await instance.length()).toBe(0);
  });

  it('dropInstance keeps data isolated by database name', async () => {
    const primary = new LocalSpace({
      name: 'rn-shared',
      storeName: 'a',
      reactNativeAsyncStorage: asyncStorage,
    });
    const secondary = new LocalSpace({
      name: 'rn-shared',
      storeName: 'b',
      reactNativeAsyncStorage: asyncStorage,
    });
    const external = new LocalSpace({
      name: 'rn-other',
      storeName: 'a',
      reactNativeAsyncStorage: asyncStorage,
    });

    await withReactNativeDriver(primary);
    await withReactNativeDriver(secondary);
    await withReactNativeDriver(external);
    await Promise.all([primary.ready(), secondary.ready(), external.ready()]);

    await primary.setItem('key', 'one');
    await secondary.setItem('key', 'two');
    await external.setItem('key', 'three');

    await primary.dropInstance({ name: 'rn-shared' });

    expect(await primary.getItem('key')).toBe(null);
    expect(await secondary.getItem('key')).toBe(null);
    expect(await external.getItem('key')).toBe('three');
  });

  it('falls back to other drivers when injected adapter is malformed', async () => {
    const instance = new LocalSpace({
      name: 'rn-invalid',
      storeName: 'rn_invalid',
      reactNativeAsyncStorage: {} as ReactNativeAsyncStorage,
    });

    await instance.defineDriver(reactNativeAsyncStorageDriver);
    await instance.setDriver([
      instance.REACTNATIVEASYNCSTORAGE,
      instance.LOCALSTORAGE,
    ]);
    await instance.ready();

    expect(instance.driver()).toBe(instance.LOCALSTORAGE);
    await instance.setItem('fallback', 'ok');
    expect(await instance.getItem('fallback')).toBe('ok');
  });
});
