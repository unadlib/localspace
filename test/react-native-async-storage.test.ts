import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalSpace } from '../src/localspace';
import localspace, { ttlPlugin } from '../src/index';
import type { ReactNativeAsyncStorage } from '../src/types';
import {
  createReactNativeInstance,
  installReactNativeAsyncStorageDriver,
  reactNativeAsyncStorageDriver,
} from '../src/react-native';
import {
  createStorageValueContractFixture,
  expectStorageValueContract,
} from './utils/storage-value-contract';

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
    await installReactNativeAsyncStorageDriver();
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

  it('allows idempotent explicit realm registration', async () => {
    const instance = new LocalSpace({
      name: 'rn-idempotent-install',
      storeName: 'rn_idempotent_install',
      reactNativeAsyncStorage: asyncStorage,
    });

    await installReactNativeAsyncStorageDriver();
    await installReactNativeAsyncStorageDriver();

    await expect(
      instance.getDriver(instance.REACTNATIVEASYNCSTORAGE)
    ).resolves.toMatchObject({
      _driver: instance.REACTNATIVEASYNCSTORAGE,
    });
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
      asyncStorage
        .dumpKeys()
        .filter((key) => !key.startsWith('localspace:stores:'))
        .every((key) => key.includes('rn-configured/'))
    ).toBe(true);
  });

  it('validates every write before adapter side effects', async () => {
    const setItemSpy = vi.spyOn(asyncStorage, 'setItem');
    const multiSetSpy = vi.spyOn(asyncStorage, 'multiSet');
    const instance = await createReactNativeInstance(localspace, {
      name: 'rn-storage-value-validation',
      storeName: 'rn_storage_value_validation',
      reactNativeAsyncStorage: asyncStorage,
    });

    await expect(
      instance.setItem('date', new Date() as never)
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: expect.objectContaining({ valuePath: '$' }),
    });
    await expect(
      instance.setItems([
        { key: 'valid', value: 'not-written' },
        { key: 'map', value: new Map() as never },
      ])
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: expect.objectContaining({ key: 'map', valuePath: '$' }),
    });

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(multiSetSpy).not.toHaveBeenCalled();
    expect(asyncStorage.dumpKeys()).toEqual([]);
    await instance.close();
  });

  it('round-trips the complete StorageValue corpus through AsyncStorage', async () => {
    const instance = await createReactNativeInstance(localspace, {
      name: 'rn-storage-value-binary',
      storeName: 'rn_storage_value_binary',
      reactNativeAsyncStorage: asyncStorage,
    });
    const fixture = createStorageValueContractFixture();

    await instance.setItem('contract', fixture.value);
    expectStorageValueContract(await instance.getItem('contract'), fixture);
    await instance.close();
  });

  it('uses multi* methods for batch APIs when available', async () => {
    const multiSetSpy = vi.spyOn(asyncStorage, 'multiSet');
    const multiGetSpy = vi.spyOn(asyncStorage, 'multiGet');
    const multiRemoveSpy = vi.spyOn(asyncStorage, 'multiRemove');
    const instance = new LocalSpace({
      name: 'rn-batch',
      storeName: 'batch_store',
      reactNativeAsyncStorage: asyncStorage,
    });
    await withReactNativeDriver(instance);
    await instance.ready();

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

  it('exposes a TTL-filtered logical key view', async () => {
    const instance = new LocalSpace({
      name: 'rn-logical-ttl',
      storeName: 'rn_logical_ttl',
      reactNativeAsyncStorage: asyncStorage,
      plugins: [ttlPlugin({ keyTTL: { expired: 5 } })],
    });
    await withReactNativeDriver(instance);
    await instance.ready();
    await instance.setItems([
      { key: 'expired', value: 'gone' },
      { key: 'stored-null', value: null },
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    await expect(instance.keys()).resolves.toEqual(['stored-null']);
    await expect(instance.key(0)).resolves.toBe('stored-null');
    await expect(instance.length()).resolves.toBe(1);

    await instance.close();
  });

  it('rejects runTransaction without invoking the runner', async () => {
    const instance = new LocalSpace({
      name: 'rn-no-transaction',
      storeName: 'rn_no_transaction',
      reactNativeAsyncStorage: asyncStorage,
    });
    await withReactNativeDriver(instance);
    await instance.ready();
    const runner = vi.fn();

    await expect(
      instance.runTransaction('readwrite', runner)
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: { operation: 'runTransaction' },
    });
    expect(runner).not.toHaveBeenCalled();
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

  it('rejects a malformed adapter without falling back to another driver', async () => {
    const instance = new LocalSpace({
      name: 'rn-invalid',
      storeName: 'rn_invalid',
      reactNativeAsyncStorage: {} as ReactNativeAsyncStorage,
      drivers: [reactNativeAsyncStorageDriver],
    });

    await instance.setDriver([
      instance.REACTNATIVEASYNCSTORAGE,
      instance.LOCALSTORAGE,
    ]);
    await expect(instance.ready()).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: {
        configKey: 'reactNativeAsyncStorage',
        operation: 'initialize',
        reason: 'adapter-invalid',
      },
    });
    expect(instance.driver()).toBe(instance.REACTNATIVEASYNCSTORAGE);
    await instance.close();
  });

  it('rejects an adapter without query capability during selection', async () => {
    const values = new Map<string, string>();
    const incompleteAdapter = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    };
    const instance = new LocalSpace({
      name: 'rn-minimal-capabilities',
      storeName: 'rn_minimal_capabilities',
      reactNativeAsyncStorage:
        incompleteAdapter as unknown as ReactNativeAsyncStorage,
      drivers: [reactNativeAsyncStorageDriver],
    });

    await instance.setDriver([instance.REACTNATIVEASYNCSTORAGE]);
    await expect(instance.ready()).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: {
        configKey: 'reactNativeAsyncStorage',
        operation: 'initialize',
        reason: 'adapter-invalid',
      },
    });
    expect(instance.driver()).toBe(instance.REACTNATIVEASYNCSTORAGE);
    await instance.close();
  });
});
