import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNativeAsyncStorage } from '../src/types';

const adapter = (): ReactNativeAsyncStorage => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
  getAllKeys: vi.fn(async () => []),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('react native explicit adapter boundary', () => {
  it('ignores runtime globals and rejects before falling back to another driver', async () => {
    const runtimeAdapter = adapter();
    const runtimeRequire = vi.fn(() => ({ default: runtimeAdapter }));
    vi.stubGlobal('AsyncStorage', runtimeAdapter);
    vi.stubGlobal('ReactNativeAsyncStorage', runtimeAdapter);
    vi.stubGlobal('__LOCALSPACE_ASYNC_STORAGE__', runtimeAdapter);
    vi.stubGlobal('require', runtimeRequire);

    const { LocalSpace } = await import('../src/localspace');
    const { installReactNativeAsyncStorageDriver } =
      await import('../src/react-native');
    await installReactNativeAsyncStorageDriver();
    const instance = new LocalSpace({
      name: 'rn-no-runtime-detection',
      storeName: 'kv',
    });

    try {
      await instance.setDriver([
        instance.REACTNATIVEASYNCSTORAGE,
        instance.LOCALSTORAGE,
      ]);
      await expect(instance.ready()).rejects.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        details: {
          configKey: 'reactNativeAsyncStorage',
          operation: 'initialize',
          reason: 'adapter-not-configured',
        },
      });
      expect(instance.driver()).toBe(instance.REACTNATIVEASYNCSTORAGE);
      expect(runtimeRequire).not.toHaveBeenCalled();
      expect(runtimeAdapter.getItem).not.toHaveBeenCalled();
      expect(runtimeAdapter.setItem).not.toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it('uses only the construction-scoped adapter', async () => {
    const runtimeAdapter = adapter();
    const configuredAdapter = adapter();
    vi.stubGlobal('__LOCALSPACE_ASYNC_STORAGE__', runtimeAdapter);
    vi.stubGlobal(
      'require',
      vi.fn(() => ({ default: runtimeAdapter }))
    );

    const { LocalSpace } = await import('../src/localspace');
    const { installReactNativeAsyncStorageDriver } =
      await import('../src/react-native');
    await installReactNativeAsyncStorageDriver();
    const instance = new LocalSpace({
      name: 'rn-configured-only',
      storeName: 'kv',
      reactNativeAsyncStorage: configuredAdapter,
    });

    try {
      await instance.setDriver([instance.REACTNATIVEASYNCSTORAGE]);
      await instance.ready();
      await instance.setItem('token', 'abc');

      expect(configuredAdapter.setItem).toHaveBeenCalledWith(
        'rn-configured-only/kv/token',
        expect.any(String)
      );
      expect(runtimeAdapter.setItem).not.toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it('makes the react-native entry reject a missing adapter', async () => {
    const { LocalSpace } = await import('../src/localspace');
    const { createReactNativeInstance } = await import('../src/react-native');
    const base = new LocalSpace();

    try {
      await expect(
        createReactNativeInstance(base, {
          name: 'rn-helper-missing-adapter',
          storeName: 'kv',
        } as any)
      ).rejects.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        details: {
          configKey: 'reactNativeAsyncStorage',
          reason: 'adapter-not-configured',
        },
      });
    } finally {
      await base.close();
    }
  });
});
