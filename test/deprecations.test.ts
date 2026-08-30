import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encryptionPlugin,
  LocalSpace,
  setDeprecationWarnings,
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

describe('migration deprecation warnings', () => {
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

  it('accepts matching batch and single hooks without a migration warning', () => {
    const plugin: LocalSpacePlugin = {
      name: 'ttl',
      beforeSet: (_key, value) => value,
      beforeSetItems: (entries) => entries,
    };

    new LocalSpace({ plugins: [plugin] });
    new LocalSpace({ plugins: [plugin] });

    expect(warnings()).toEqual([]);
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
    warnDeprecation('weak-memory-transaction', 'must stay silent');

    expect(warnings()).toEqual([]);
  });

  it('does not emit deprecation warnings in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    warnDeprecation('weak-memory-transaction', 'must stay silent');

    expect(warnings()).toEqual([]);
  });

  it('emits deprecation warnings in Node when NODE_ENV is unset', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    try {
      warnDeprecation('weak-memory-transaction', 'must remain visible');
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
