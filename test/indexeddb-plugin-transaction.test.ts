import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  ttlPlugin,
} from '../src';
import type {
  CompressionCodec,
  LocalSpaceInstance,
  LocalSpacePlugin,
  StorageValue,
  TransactionScope,
} from '../src';

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const createStore = async (
  prefix: string,
  plugins: LocalSpacePlugin[] = []
): Promise<LocalSpaceInstance> => {
  const store = localspace.createInstance({
    name: `${prefix}-${Math.random().toString(36).slice(2)}`,
    storeName: 'store',
    plugins,
    pluginErrorPolicy: 'strict',
  });
  await store.setDriver([store.INDEXEDDB]);
  await store.ready();
  return store;
};

const cleanupStore = async (store: LocalSpaceInstance) => {
  await store.dropInstance().catch(() => undefined);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndexedDB plugin-aware transactions', () => {
  it('keeps the native transaction alive for async compression encode and decode', async () => {
    let originalBytes = new Uint8Array();
    const codec: CompressionCodec = {
      compress: async (bytes) => {
        await delay(10);
        originalBytes = bytes.slice();
        return new Uint8Array([1]);
      },
      decompress: async () => {
        await delay(10);
        return originalBytes.slice();
      },
    };
    const store = await createStore('transaction-async-compression', [
      compressionPlugin({ threshold: 1, codec, algorithm: 'test-codec' }),
    ]);

    try {
      const logicalValue = { payload: 'x'.repeat(2_000) };
      const result = await store.runTransaction('readwrite', async (scope) => {
        await scope.set('compressed', logicalValue);
        await expect(scope.get('compressed')).resolves.toEqual(logicalValue);
        return scope.keys();
      });

      expect(result).toEqual(['compressed']);
      await expect(store.getItem('compressed')).resolves.toEqual(logicalValue);
    } finally {
      await cleanupStore(store);
    }
  });

  it('keeps the native transaction alive for WebCrypto encryption', async () => {
    const store = await createStore('transaction-webcrypto', [
      encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
    ]);

    try {
      await expect(
        store.runTransaction('readwrite', async (scope) => {
          await scope.set('secret', { message: 'plaintext' });
          return scope.get('secret');
        })
      ).resolves.toEqual({ message: 'plaintext' });
      await expect(store.getItem('secret')).resolves.toEqual({
        message: 'plaintext',
      });
    } finally {
      await cleanupStore(store);
    }
  });

  it('passes the logical scope to hooks and awaits async hook work', async () => {
    const seenScopes: TransactionScope[] = [];
    const events: string[] = [];
    const plugin: LocalSpacePlugin = {
      name: 'transaction-observer',
      beforeSet: async (_key, value, context) => {
        await delay(5);
        events.push('beforeSet');
        if (context.transactionScope) {
          seenScopes.push(context.transactionScope);
        }
        return value;
      },
      afterGet: async (_key, value, context) => {
        await delay(5);
        events.push('afterGet');
        if (context.transactionScope) {
          seenScopes.push(context.transactionScope);
        }
        return value;
      },
    };
    const store = await createStore('transaction-plugin-context', [plugin]);

    try {
      let runnerScope: TransactionScope | undefined;
      await store.runTransaction('readwrite', async (scope) => {
        runnerScope = scope;
        await scope.set('key', 'value');
        await expect(scope.get('key')).resolves.toBe('value');
      });

      expect(events).toEqual(['beforeSet', 'afterGet']);
      expect(seenScopes).toEqual([runnerScope, runnerScope]);
    } finally {
      await cleanupStore(store);
    }
  });

  it('runs every transaction-scope hook with the transaction context', async () => {
    const events: string[] = [];
    const record = (event: string, context: { transactionScope?: unknown }) => {
      expect(context.transactionScope).toBeDefined();
      events.push(event);
    };
    const plugin: LocalSpacePlugin = {
      name: 'transaction-hook-matrix',
      beforeSet: (key, value, context) => {
        record(`beforeSet:${key}`, context);
        return value;
      },
      afterSet: (key, _value, context) => {
        record(`afterSet:${key}`, context);
      },
      beforeGet: (key, context) => {
        record(`beforeGet:${key}`, context);
        return key;
      },
      afterGet: (key, value, context) => {
        record(`afterGet:${key}:${context.operation}`, context);
        return value;
      },
      isValueVisible: (key, _value, context) => {
        record(`isValueVisible:${key}:${context.operation}`, context);
        return true;
      },
      beforeRemove: (key, context) => {
        record(`beforeRemove:${key}`, context);
        return key;
      },
      afterRemove: (key, context) => {
        record(`afterRemove:${key}`, context);
      },
      beforeKeys: (context) => record('beforeKeys', context),
      afterKeys: (_keys, context) => record('afterKeys', context),
      beforeIterate: (context) => record('beforeIterate', context),
      afterIterate: (_summary, context) => record('afterIterate', context),
      beforeClear: (context) => record('beforeClear', context),
      afterClear: (context) => record('afterClear', context),
    };
    const store = await createStore('transaction-hook-matrix', [plugin]);

    try {
      await store.runTransaction('readwrite', async (scope) => {
        await scope.set('a', 1);
        await scope.get('a');
        await scope.keys();
        await scope.iterate(() => undefined);
        await scope.remove('a');
        await scope.set('b', 2);
        await scope.clear();
      });

      expect(events).toContain('beforeSet:a');
      expect(events).toContain('afterSet:a');
      expect(events).toContain('beforeGet:a');
      expect(events).toContain('afterGet:a:getItem');
      expect(events).toContain('beforeKeys');
      expect(events).toContain('afterGet:a:keys');
      expect(events).toContain('isValueVisible:a:keys');
      expect(events).toContain('afterKeys');
      expect(events).toContain('beforeIterate');
      expect(events).toContain('afterGet:a:iterate');
      expect(events).toContain('afterIterate');
      expect(events).toContain('beforeRemove:a');
      expect(events).toContain('afterRemove:a');
      expect(events).toContain('beforeClear');
      expect(events).toContain('afterClear');
    } finally {
      await cleanupStore(store);
    }
  });

  it('uses the transaction scope for TTL expiry deletion and notification', async () => {
    const onExpire = vi.fn();
    const store = await createStore('transaction-ttl-expiry', [
      ttlPlugin({ defaultTTL: 1, onExpire }),
    ]);

    try {
      await store.setItem('expired', { value: 1 });
      await delay(5);

      await store.runTransaction('readwrite', async (scope) => {
        await expect(scope.get('expired')).resolves.toBeNull();
        await expect(scope.keys()).resolves.toEqual([]);
      });

      await expect(store.keys()).resolves.toEqual([]);
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(onExpire).toHaveBeenCalledWith('expired', { value: 1 });
    } finally {
      await cleanupStore(store);
    }
  });

  it('streams logical values and awaits transaction iterate callbacks', async () => {
    const store = await createStore('transaction-async-iterate', [
      compressionPlugin({ threshold: 1 }),
    ]);

    try {
      await store.setItems({
        a: 'a'.repeat(2_000),
        b: 'b'.repeat(2_000),
      });
      const values: Array<[string, StorageValue, number]> = [];

      const result = await store.runTransaction('readonly', (scope) =>
        scope.iterate(async (value, key, iteration) => {
          await delay(5);
          values.push([key, value, iteration]);
          return key === 'b' ? 'stopped' : undefined;
        })
      );

      expect(result).toBe('stopped');
      expect(values).toEqual([
        ['a', 'a'.repeat(2_000), 1],
        ['b', 'b'.repeat(2_000), 2],
      ]);
    } finally {
      await cleanupStore(store);
    }
  });
});

describe('IndexedDB transaction keep-alive boundary', () => {
  it('stops keep-alive between scope operations and reports an external-await commit', async () => {
    const store = await createStore('transaction-external-await');

    try {
      await expect(
        store.runTransaction('readwrite', async (scope) => {
          await scope.set('before-gap', 'committed');
          await delay(10);
          await scope.set('after-gap', 'blocked');
        })
      ).rejects.toMatchObject({
        code: 'TRANSACTION_INACTIVE',
        details: {
          operation: 'runTransaction',
          reason: 'transaction-inactive',
          scopeOperation: 'runner',
        },
      });

      await delay(20);
      await expect(store.getItem('before-gap')).resolves.toBe('committed');
      await expect(store.getItem('after-gap')).resolves.toBeNull();
    } finally {
      await cleanupStore(store);
    }
  });
});
