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
} from '../src';

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const createIndexedDbStore = async (
  name: string,
  plugins: LocalSpacePlugin[] = []
): Promise<LocalSpaceInstance> => {
  const store = localspace.createInstance({
    name,
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
  await store.close().catch(() => undefined);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndexedDB transaction isolation and failure races', () => {
  it('serializes read-modify-write transactions across instances', async () => {
    const name = uniqueName('idb-competing-instances');
    const first = await createIndexedDbStore(name);
    const second = await createIndexedDbStore(name);
    await first.setItem('counter', 0);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondSettled = false;

    try {
      const firstTransaction = first.runTransaction(
        'readwrite',
        async (scope) => {
          const current = (await scope.get<number>('counter')) ?? 0;
          await scope.iterate(async (_value, key) => {
            if (key === 'counter') {
              firstEntered.resolve();
              await releaseFirst.promise;
              return 'release';
            }
            return undefined;
          });
          await scope.set('counter', current + 1);
          return current + 1;
        }
      );
      await firstEntered.promise;

      const secondTransaction = second
        .runTransaction('readwrite', async (scope) => {
          const current = (await scope.get<number>('counter')) ?? 0;
          await scope.set('counter', current + 1);
          return current + 1;
        })
        .finally(() => {
          secondSettled = true;
        });
      await delay(10);
      expect(secondSettled).toBe(false);

      releaseFirst.resolve();
      await expect(firstTransaction).resolves.toBe(1);
      await expect(secondTransaction).resolves.toBe(2);
      await expect(first.getItem('counter')).resolves.toBe(2);
    } finally {
      await cleanupStore(first);
      await second.close().catch(() => undefined);
    }
  });

  it('reports an explicit driver abort and rolls back every write', async () => {
    let capturedTransaction: IDBTransaction | undefined;
    let abortOnSet = false;
    const abortingPlugin: LocalSpacePlugin = {
      name: 'abort-transaction',
      beforeSet: async (_key, value) => {
        if (abortOnSet) {
          capturedTransaction?.abort();
          await delay(10);
        }
        return value;
      },
    };
    const store = await createIndexedDbStore(uniqueName('idb-explicit-abort'), [
      abortingPlugin,
    ]);

    try {
      await store.setItem('preserved', 'before');
      const db = (
        store as LocalSpaceInstance & { _dbInfo: { db: IDBDatabase } }
      )._dbInfo.db;
      const transactionHost = db as IDBDatabase & {
        transaction(
          storeNames: string | string[],
          mode?: IDBTransactionMode,
          options?: IDBTransactionOptions
        ): IDBTransaction;
      };
      const originalTransaction = transactionHost.transaction.bind(db);
      vi.spyOn(transactionHost, 'transaction').mockImplementation(
        (storeNames, mode, options) => {
          const transaction = options
            ? originalTransaction(storeNames, mode, options)
            : originalTransaction(storeNames, mode);
          if (mode === 'readwrite') {
            capturedTransaction = transaction;
          }
          return transaction;
        }
      );
      abortOnSet = true;

      await expect(
        store.runTransaction('readwrite', async (scope) => {
          await scope.set('preserved', 'during');
          await scope.set('new', 'during');
        })
      ).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
        details: {
          operation: 'runTransaction',
          reason: 'transaction-aborted',
        },
      });

      await delay(20);
      await expect(store.getItem('preserved')).resolves.toBe('before');
      await expect(store.getItem('new')).resolves.toBeNull();
    } finally {
      await cleanupStore(store);
    }
  });

  it('rolls back prior writes when async compression fails', async () => {
    let compressionCalls = 0;
    const codec: CompressionCodec = {
      compress: async () => {
        compressionCalls += 1;
        await delay(5);
        if (compressionCalls === 2) {
          throw new Error('codec failed');
        }
        return new Uint8Array([1]);
      },
      decompress: async (bytes) => bytes,
    };
    const store = await createIndexedDbStore(
      uniqueName('idb-compression-rollback'),
      [compressionPlugin({ threshold: 1, codec, algorithm: 'failing-test' })]
    );

    try {
      await expect(
        store.runTransaction('readwrite', async (scope) => {
          await scope.set('first', 'a'.repeat(2_000));
          await scope.set('second', 'b'.repeat(2_000));
        })
      ).rejects.toMatchObject({ code: 'OPERATION_FAILED' });

      await expect(store.getItem('first')).resolves.toBeNull();
      await expect(store.getItem('second')).resolves.toBeNull();
    } finally {
      await cleanupStore(store);
    }
  });

  it('rolls back writes when an async iterate callback rejects', async () => {
    const store = await createIndexedDbStore(
      uniqueName('idb-iterate-rollback')
    );

    try {
      await store.setItem('preserved', 'before');
      await expect(
        store.runTransaction('readwrite', async (scope) => {
          await scope.set('staged', 'during');
          await scope.iterate(async () => {
            await delay(5);
            throw new Error('iterator failed');
          });
        })
      ).rejects.toThrow('iterator failed');

      await expect(store.getItem('preserved')).resolves.toBe('before');
      await expect(store.getItem('staged')).resolves.toBeNull();
    } finally {
      await cleanupStore(store);
    }
  });

  it('rolls back TTL deletion when onExpire rejects in strict mode', async () => {
    const onExpire = vi.fn(async () => {
      throw new Error('notification failed');
    });
    const name = uniqueName('idb-ttl-rollback');
    const store = await createIndexedDbStore(name, [
      ttlPlugin({ defaultTTL: 1, onExpire }),
    ]);
    const raw = await createIndexedDbStore(name);

    try {
      await store.setItem('expired', { value: 1 });
      await delay(5);

      await expect(
        store.runTransaction('readwrite', (scope) => scope.get('expired'))
      ).rejects.toMatchObject({ code: 'OPERATION_FAILED' });

      expect(onExpire).toHaveBeenCalledTimes(1);
      await expect(raw.getItem('expired')).resolves.toMatchObject({
        __localspace__: {
          namespace: 'localspace.plugin',
          kind: 'ttl',
          version: 1,
        },
      });
    } finally {
      await cleanupStore(store);
      await raw.close().catch(() => undefined);
    }
  });

  it('keeps combined transforms logical and atomic during async iteration', async () => {
    const name = uniqueName('idb-combined-transaction');
    const store = await createIndexedDbStore(name, [
      ttlPlugin({ defaultTTL: 60_000 }),
      compressionPlugin({ threshold: 1 }),
      encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
    ]);
    const raw = await createIndexedDbStore(name);

    try {
      const entries: Array<[string, unknown, number]> = [];
      const result = await store.runTransaction('readwrite', async (scope) => {
        await scope.set('a', { payload: 'a'.repeat(2_000) });
        await scope.set('b', { payload: 'b'.repeat(2_000) });
        const stopped = await scope.iterate(async (value, key, iteration) => {
          await delay(5);
          entries.push([key, value, iteration]);
          return key === 'b' ? 'stopped' : undefined;
        });
        return { keys: await scope.keys(), stopped };
      });

      expect(result).toEqual({ keys: ['a', 'b'], stopped: 'stopped' });
      expect(entries).toEqual([
        ['a', { payload: 'a'.repeat(2_000) }, 1],
        ['b', { payload: 'b'.repeat(2_000) }, 2],
      ]);
      await expect(store.getItem('a')).resolves.toEqual({
        payload: 'a'.repeat(2_000),
      });
      await expect(raw.getItem('a')).resolves.toMatchObject({
        __localspace__: {
          namespace: 'localspace.plugin',
          kind: 'encryption',
          version: 1,
        },
      });
    } finally {
      await cleanupStore(store);
      await raw.close().catch(() => undefined);
    }
  });

  it('blocks close while an externally-awaited runner is still unwinding', async () => {
    const store = await createIndexedDbStore(
      uniqueName('idb-close-inactive-runner')
    );
    const entered = deferred();
    const releaseRunner = deferred();
    const runnerFinished = deferred();

    const transaction = store.runTransaction('readwrite', async (scope) => {
      try {
        await scope.set('before-gap', 'committed');
        entered.resolve();
        await releaseRunner.promise;
        await scope.set('after-gap', 'blocked');
      } finally {
        runnerFinished.resolve();
      }
    });
    await entered.promise;
    await expect(transaction).rejects.toMatchObject({
      code: 'TRANSACTION_INACTIVE',
    });

    await expect(store.close()).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        operation: 'close',
        reason: 'active-operations',
        activeTransactionRunners: 1,
      },
    });

    releaseRunner.resolve();
    await runnerFinished.promise;
    await delay(0);
    await expect(store.close()).resolves.toBeUndefined();

    const cleanup = await createIndexedDbStore(
      (store.config('name') as string) ?? ''
    );
    await cleanupStore(cleanup);
  });
});
