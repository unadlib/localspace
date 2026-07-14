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

describe('2.1 deprecation warnings', () => {
  it('warns once for explicit legacy size configuration', () => {
    const first = new LocalSpace({ size: 4_980_736 });
    const second = new LocalSpace();
    expect(second.config({ size: 1_000_000 })).toBe(true);
    expect(first.config('size')).toBe(4_980_736);

    expect(warnings()).toEqual([
      '[localspace] Deprecation: the `size` option is ignored by built-in drivers and will be removed in 3.0.',
    ]);
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
