import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encryptionPlugin,
  LocalSpace,
  memoryDriver,
  setDeprecationWarnings,
  type Driver,
  type LocalSpacePlugin,
  type ReactNativeAsyncStorage,
} from '../src';
import reactNativeAsyncStorageDriver from '../src/drivers/react-native-async-storage';
import {
  resetDeprecationWarningsForTests,
  warnDeprecation,
} from '../src/utils/deprecations';

const warnings = () =>
  vi.mocked(console.warn).mock.calls.map(([message]) => String(message));

beforeEach(() => {
  resetDeprecationWarningsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetDeprecationWarningsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('2.1 deprecation warnings', () => {
  it('warns once for explicit legacy size configuration', () => {
    const first = new LocalSpace({ size: 4_980_736 });
    const second = new LocalSpace();
    expect(second.config({ size: 1_000_000 })).toBe(true);
    expect(first.config('size')).toBe(4_980_736);

    expect(warnings()).toEqual([
      '[localspace] Deprecation: the `size` option is ignored by built-in drivers and will be removed in 3.0.',
      '[localspace] Deprecation: `config(options)` is deprecated and will be removed in 3.0; pass options to the constructor or `createInstance()`.',
    ]);
  });

  it('warns once for IndexedDB performance options', () => {
    const first = new LocalSpace({ prewarmTransactions: false });
    const second = new LocalSpace();
    expect(second.config({ connectionIdleMs: 10 })).toBe(true);
    expect(first.config('prewarmTransactions')).toBe(false);

    expect(warnings()).toContain(
      '[localspace] Deprecation: `prewarmTransactions`, `connectionIdleMs`, and `maxConcurrentTransactions` are deprecated and will be removed from the 3.0 public configuration.'
    );
    expect(
      warnings().filter((message) =>
        message.includes('`prewarmTransactions`, `connectionIdleMs`')
      )
    ).toHaveLength(1);
  });

  it('warns for public instance-level custom driver registration', async () => {
    const instance = new LocalSpace();
    const driver: Driver = {
      ...memoryDriver,
      _driver: `deprecated-registration-${Math.random().toString(36).slice(2)}`,
    };

    await instance.defineDriver(driver);
    expect(warnings()).toContain(
      '[localspace] Deprecation: instance-level `defineDriver()` is deprecated and will be replaced by explicit global or construction-scoped driver registration in 3.0.'
    );
  });

  it('does not warn for LocalSpace-owned internal registration', async () => {
    const instance = new LocalSpace();
    const driver: Driver = {
      ...memoryDriver,
      _driver: `internal-registration-${Math.random().toString(36).slice(2)}`,
    };
    await instance._defineDriver(driver);

    expect(
      warnings().some((message) =>
        message.includes('instance-level `defineDriver()`')
      )
    ).toBe(false);
  });

  it('warns when using the weak 2.1 Memory transaction contract', async () => {
    const instance = new LocalSpace({
      name: `weak-memory-${Math.random().toString(36).slice(2)}`,
      storeName: 'store',
    });
    await instance.setDriver([instance.MEMORY]);
    await instance.runTransaction('readonly', async (tx) => tx.keys());

    expect(warnings()).toContain(
      '[localspace] Deprecation: Memory `runTransaction()` in 2.1 provides snapshot rollback without isolation; 3.0 requires store-scoped serializable isolation.'
    );
  });

  it('warns when a requested Storage Bucket falls back', async () => {
    const target = navigator as Navigator & {
      storageBuckets?: { open: () => Promise<never> };
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      target,
      'storageBuckets'
    );
    Object.defineProperty(target, 'storageBuckets', {
      configurable: true,
      value: {
        open: async () => {
          throw new Error('bucket unavailable');
        },
      },
    });
    const instance = new LocalSpace({
      name: `bucket-deprecation-${Math.random().toString(36).slice(2)}`,
      storeName: 'store',
      bucket: { name: 'requested-bucket' },
    });

    try {
      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
    } finally {
      await instance.close();
      if (descriptor) {
        Object.defineProperty(target, 'storageBuckets', descriptor);
      } else {
        delete target.storageBuckets;
      }
    }

    expect(warnings()).toContain(
      '[localspace] Deprecation: a requested Storage Bucket could not be opened and fell back to the default backend; 3.0 rejects instead of falling back.'
    );
  });

  it('preserves the mutable config reference while warning once', () => {
    const instance = new LocalSpace({ name: 'mutable-config-reference' });
    const config = instance.config();
    config.name = 'mutated-for-compatibility';

    expect(instance.config('name')).toBe('mutated-for-compatibility');
    instance.config();
    expect(warnings()).toEqual([
      '[localspace] Deprecation: mutating the object returned by `config()` is deprecated; pass options to createInstance() instead.',
    ]);
  });

  it('preserves destroy lifecycle behavior while warning once', async () => {
    const onInit = vi.fn();
    const onDestroy = vi.fn();
    const instance = new LocalSpace({
      plugins: [{ name: 'legacy-destroy', onInit, onDestroy }],
    });

    await instance.destroy();
    await instance.destroy();

    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([
      '[localspace] Deprecation: `destroy()` is deprecated; use `close()` to release plugins and the active driver.',
    ]);
  });

  it('warns once for matching batch and single hooks on custom plugins', () => {
    const plugin: LocalSpacePlugin = {
      name: 'ttl',
      beforeSet: (_key, value) => value,
      beforeSetItems: (entries) => entries,
    };

    new LocalSpace({ plugins: [plugin] });
    new LocalSpace({ plugins: [plugin] });

    expect(warnings()).toEqual([
      '[localspace] Deprecation: plugin "ttl" defines matching batch and single hooks; define one form per phase before 3.0.',
    ]);
  });

  it('warns once for AES-CBC and AES-CTR migration readers', () => {
    const createLegacyPlugin = (name: 'AES-CBC' | 'AES-CTR') =>
      encryptionPlugin({
        key: '0123456789abcdef0123456789abcdef',
        algorithm:
          name === 'AES-CBC'
            ? { name, iv: new Uint8Array(16) }
            : { name, counter: new Uint8Array(16), length: 64 },
      });

    expect(() => createLegacyPlugin('AES-CBC')).not.toThrow();
    expect(() => createLegacyPlugin('AES-CTR')).not.toThrow();
    expect(warnings()).toEqual([
      '[localspace] Deprecation: AES-CBC encryption is deprecated and read-only; migrate data to AES-GCM.',
    ]);
  });

  it('warns once when React Native storage is auto-detected', async () => {
    const values = new Map<string, string>();
    const adapter: ReactNativeAsyncStorage = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    };
    const globalRecord = globalThis as Record<string, unknown>;
    const previous = globalRecord.__LOCALSPACE_ASYNC_STORAGE__;
    globalRecord.__LOCALSPACE_ASYNC_STORAGE__ = adapter;
    const context = {
      _defaultConfig: { storeName: 'keyvaluepairs' },
      _dbInfo: null,
    };

    try {
      await reactNativeAsyncStorageDriver._initStorage.call(context, {
        name: 'rn-auto-deprecation',
        storeName: 'store',
      });
      await reactNativeAsyncStorageDriver._initStorage.call(context, {
        name: 'rn-auto-deprecation-2',
        storeName: 'store',
      });
    } finally {
      if (previous === undefined) {
        delete globalRecord.__LOCALSPACE_ASYNC_STORAGE__;
      } else {
        globalRecord.__LOCALSPACE_ASYNC_STORAGE__ = previous;
      }
    }

    expect(warnings()).toEqual([
      '[localspace] Deprecation: automatic React Native AsyncStorage detection is deprecated; inject `reactNativeAsyncStorage` explicitly.',
    ]);
  });

  it('can disable all deprecation warnings', async () => {
    setDeprecationWarnings(false);
    const instance = new LocalSpace({ size: 1 });
    instance.config();
    await instance.destroy();

    expect(warnings()).toEqual([]);
  });

  it('does not emit deprecation warnings in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    warnDeprecation('legacy-size-option', 'must stay silent');

    expect(warnings()).toEqual([]);
  });

  it('emits deprecation warnings in Node when NODE_ENV is unset', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    try {
      warnDeprecation('legacy-size-option', 'must remain visible');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }

    expect(warnings()).toEqual([
      '[localspace] Deprecation: must remain visible',
    ]);
  });
});
