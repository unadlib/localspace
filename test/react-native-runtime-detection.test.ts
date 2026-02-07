import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNativeAsyncStorage } from '../src/types';

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
}

type GlobalRecord = Record<string, unknown>;

const clearGlobalRuntimeBindings = (globalRecord: GlobalRecord): void => {
  delete globalRecord.require;
  delete globalRecord.AsyncStorage;
  delete globalRecord.ReactNativeAsyncStorage;
  delete globalRecord.__LOCALSPACE_ASYNC_STORAGE__;
};

const restoreGlobalRuntimeBinding = (
  globalRecord: GlobalRecord,
  key:
    | 'require'
    | 'AsyncStorage'
    | 'ReactNativeAsyncStorage'
    | '__LOCALSPACE_ASYNC_STORAGE__',
  value: unknown
): void => {
  if (value === undefined) {
    delete globalRecord[key];
    return;
  }

  globalRecord[key] = value;
};

describe('react native runtime detection', () => {
  let originalRequire: unknown;
  let originalAsyncStorage: unknown;
  let originalReactNativeAsyncStorage: unknown;
  let originalLocalspaceAsyncStorage: unknown;

  beforeEach(() => {
    vi.resetModules();

    const globalRecord = globalThis as GlobalRecord;
    originalRequire = globalRecord.require;
    originalAsyncStorage = globalRecord.AsyncStorage;
    originalReactNativeAsyncStorage = globalRecord.ReactNativeAsyncStorage;
    originalLocalspaceAsyncStorage = globalRecord.__LOCALSPACE_ASYNC_STORAGE__;

    clearGlobalRuntimeBindings(globalRecord);
  });

  afterEach(() => {
    const globalRecord = globalThis as GlobalRecord;
    restoreGlobalRuntimeBinding(globalRecord, 'require', originalRequire);
    restoreGlobalRuntimeBinding(
      globalRecord,
      'AsyncStorage',
      originalAsyncStorage
    );
    restoreGlobalRuntimeBinding(
      globalRecord,
      'ReactNativeAsyncStorage',
      originalReactNativeAsyncStorage
    );
    restoreGlobalRuntimeBinding(
      globalRecord,
      '__LOCALSPACE_ASYNC_STORAGE__',
      originalLocalspaceAsyncStorage
    );
    vi.restoreAllMocks();
  });

  it('detects runtime async storage from global injection', async () => {
    const runtimeStorage = new MemoryAsyncStorage();
    (globalThis as GlobalRecord).__LOCALSPACE_ASYNC_STORAGE__ = runtimeStorage;

    const { LocalSpace } = await import('../src/localspace');
    const { installReactNativeAsyncStorageDriver } = await import(
      '../src/react-native'
    );

    const instance = new LocalSpace({
      name: 'rn-runtime-global',
      storeName: 'kv',
    });

    await installReactNativeAsyncStorageDriver(instance);
    await instance.setDriver([instance.REACTNATIVEASYNCSTORAGE]);
    await instance.ready();

    await instance.setItem('token', 'abc');
    expect(await instance.getItem('token')).toBe('abc');
    expect(instance.driver()).toBe(instance.REACTNATIVEASYNCSTORAGE);
  });

  it('detects async storage from runtime require module', async () => {
    const runtimeStorage = new MemoryAsyncStorage();
    const runtimeRequire = vi.fn((moduleName: string) => {
      if (moduleName === '@react-native-async-storage/async-storage') {
        return { default: runtimeStorage };
      }
      throw new Error(`Cannot find module "${moduleName}"`);
    });
    (globalThis as GlobalRecord).require = runtimeRequire;

    const { LocalSpace } = await import('../src/localspace');
    const { installReactNativeAsyncStorageDriver } = await import(
      '../src/react-native'
    );

    const instance = new LocalSpace({
      name: 'rn-runtime-require',
      storeName: 'kv',
    });

    await installReactNativeAsyncStorageDriver(instance);
    await instance.setDriver([instance.REACTNATIVEASYNCSTORAGE]);
    await instance.ready();
    await instance.setItem('flag', true);

    expect(await instance.getItem('flag')).toBe(true);
    expect(instance.driver()).toBe(instance.REACTNATIVEASYNCSTORAGE);
    expect(runtimeRequire).toHaveBeenCalledWith(
      '@react-native-async-storage/async-storage'
    );
  });

  it('falls back when RN runtime adapter is unavailable', async () => {
    (globalThis as GlobalRecord).require = vi.fn(() => {
      throw new Error('module not found');
    });

    const { LocalSpace } = await import('../src/localspace');
    const { installReactNativeAsyncStorageDriver } = await import(
      '../src/react-native'
    );

    const instance = new LocalSpace({
      name: 'rn-runtime-fallback',
      storeName: 'kv',
    });

    await installReactNativeAsyncStorageDriver(instance);
    await instance.setDriver([
      instance.REACTNATIVEASYNCSTORAGE,
      instance.LOCALSTORAGE,
    ]);
    await instance.ready();

    expect(instance.driver()).toBe(instance.LOCALSTORAGE);
  });

  it('createReactNativeInstance rejects when no runtime adapter is found', async () => {
    (globalThis as GlobalRecord).require = vi.fn(() => {
      throw new Error('module not found');
    });

    const { LocalSpace } = await import('../src/localspace');
    const { createReactNativeInstance } = await import('../src/react-native');

    const base = new LocalSpace();
    await expect(
      createReactNativeInstance(base, {
        name: 'rn-helper-no-runtime',
        storeName: 'kv',
      } as any)
    ).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
    });
  });
});
