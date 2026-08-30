import { describe, expect, it, vi } from 'vitest';
import localspace from '../src';
import type {
  LocalSpaceInstance,
  StorageValue,
  TransactionScope,
} from '../src/types';

type TransactionDriver = 'memory' | 'indexeddb';

const timeoutAfter = (ms: number) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('transaction runner timed out')), ms);
  });

const createStore = async (
  driver: TransactionDriver
): Promise<LocalSpaceInstance> => {
  const store = localspace.createInstance({
    name: `transaction-contract-${driver}-${Math.random().toString(36).slice(2)}`,
    storeName: 'store',
  });
  await store.setDriver([
    driver === 'memory' ? store.MEMORY : store.INDEXEDDB,
  ]);
  await store.ready();
  return store;
};

const cleanupStore = async (store: LocalSpaceInstance) => {
  await store.dropInstance().catch(() => undefined);
};

describe.each(['memory', 'indexeddb'] as const)(
  '%s shared transaction contract',
  (driver) => {
    it('uses one scope for reads, writes, iteration, removal, clear, and the runner result', async () => {
      const store = await createStore(driver);

      try {
        const result = await store.runTransaction(
          'readwrite',
          async (scope) => {
            await expect(scope.set('a', { count: 1 })).resolves.toEqual({
              count: 1,
            });
            await scope.set('b', 2);
            await expect(scope.get('a')).resolves.toEqual({ count: 1 });
            await expect(scope.keys()).resolves.toEqual(['a', 'b']);

            const entries: Array<[string, StorageValue, number]> = [];
            const stopped = await scope.iterate((value, key, iteration) => {
              entries.push([key, value, iteration]);
              return key === 'b' ? 'stopped' : undefined;
            });
            expect(stopped).toBe('stopped');
            expect(entries).toEqual([
              ['a', { count: 1 }, 1],
              ['b', 2, 2],
            ]);

            await scope.remove('a');
            await expect(scope.get('a')).resolves.toBeNull();
            await scope.clear();
            await expect(scope.keys()).resolves.toEqual([]);
            await scope.set('committed', 'value');
            return { committed: true };
          }
        );

        expect(result).toEqual({ committed: true });
        await expect(store.getItem('committed')).resolves.toBe('value');
      } finally {
        await cleanupStore(store);
      }
    });

    it('rejects every ordinary facade operation while the runner is active', async () => {
      const store = await createStore(driver);
      const nestedRunner = vi.fn();
      const operations: Array<[
        string,
        (instance: LocalSpaceInstance) => Promise<unknown>,
      ]> = [
        ['clear', (instance) => instance.clear()],
        ['getItem', (instance) => instance.getItem('seed')],
        ['getItems', (instance) => instance.getItems(['seed'])],
        ['iterate', (instance) => instance.iterate(() => undefined)],
        ['key', (instance) => instance.key(0)],
        ['keys', (instance) => instance.keys()],
        ['length', (instance) => instance.length()],
        ['removeItem', (instance) => instance.removeItem('seed')],
        ['removeItems', (instance) => instance.removeItems(['seed'])],
        [
          'runTransaction',
          (instance) => instance.runTransaction('readonly', nestedRunner),
        ],
        ['setItem', (instance) => instance.setItem('ordinary', 'blocked')],
        [
          'setItems',
          (instance) => instance.setItems({ ordinary: 'blocked' }),
        ],
        ['dropInstance', (instance) => instance.dropInstance()],
      ];

      try {
        await store.setItem('seed', 'preserved');
        const result = await Promise.race([
          store.runTransaction('readwrite', async (scope) => {
            await expect(scope.get('seed')).resolves.toBe('preserved');

            for (const [operation, invoke] of operations) {
              await expect(invoke(store)).rejects.toMatchObject({
                code: 'TRANSACTION_SCOPE_REQUIRED',
                details: {
                  operation,
                  reason: 'transaction-scope-required',
                },
              });
            }

            await scope.set('scoped', 'committed');
            return 'runner-completed';
          }),
          timeoutAfter(500),
        ]);

        expect(result).toBe('runner-completed');
        expect(nestedRunner).not.toHaveBeenCalled();
        await expect(store.getItem('seed')).resolves.toBe('preserved');
        await expect(store.getItem('ordinary')).resolves.toBeNull();
        await expect(store.getItem('scoped')).resolves.toBe('committed');
      } finally {
        await cleanupStore(store);
      }
    });

    it('invalidates every scope operation when the runner settles', async () => {
      const store = await createStore(driver);
      let capturedScope: TransactionScope | undefined;

      try {
        await store.runTransaction('readonly', (scope) => {
          capturedScope = scope;
          return 'done';
        });

        const scopeOperations: Array<[
          string,
          () => Promise<unknown>,
        ]> = [
          ['get', () => capturedScope!.get('key')],
          ['set', () => capturedScope!.set('key', 'value')],
          ['remove', () => capturedScope!.remove('key')],
          ['keys', () => capturedScope!.keys()],
          ['iterate', () => capturedScope!.iterate(() => undefined)],
          ['clear', () => capturedScope!.clear()],
        ];

        for (const [scopeOperation, invoke] of scopeOperations) {
          await expect(invoke()).rejects.toMatchObject({
            code: 'TRANSACTION_SCOPE_REQUIRED',
            details: {
              operation: 'runTransaction',
              reason: 'transaction-scope-inactive',
              scopeOperation,
            },
          });
        }
      } finally {
        await cleanupStore(store);
      }
    });

    it('rolls back scope writes when the runner rejects', async () => {
      const store = await createStore(driver);

      try {
        await store.setItem('preserved', 'before');

        await expect(
          store.runTransaction('readwrite', async (scope) => {
            await scope.set('preserved', 'during');
            await scope.set('new', 'during');
            throw new Error('runner failed');
          })
        ).rejects.toThrow('runner failed');

        await expect(store.getItem('preserved')).resolves.toBe('before');
        await expect(store.getItem('new')).resolves.toBeNull();
      } finally {
        await cleanupStore(store);
      }
    });

    it('enforces readonly mode for every scope write operation', async () => {
      const store = await createStore(driver);

      try {
        await store.setItem('preserved', 'value');
        await store.runTransaction('readonly', async (scope) => {
          await expect(scope.set('new', 'value')).rejects.toMatchObject({
            code: 'TRANSACTION_READONLY',
          });
          await expect(scope.remove('preserved')).rejects.toMatchObject({
            code: 'TRANSACTION_READONLY',
          });
          await expect(scope.clear()).rejects.toMatchObject({
            code: 'TRANSACTION_READONLY',
          });
        });

        await expect(store.getItem('preserved')).resolves.toBe('value');
        await expect(store.getItem('new')).resolves.toBeNull();
      } finally {
        await cleanupStore(store);
      }
    });
  }
);

describe('IndexedDB transaction compatibility optimizations', () => {
  it('does not run blob capability detection for readonly transactions', async () => {
    const store = await createStore('indexeddb');

    try {
      const db = (store as LocalSpaceInstance & { _dbInfo: { db: IDBDatabase } })
        ._dbInfo.db;
      const transactionSpy = vi.spyOn(db, 'transaction');

      await expect(
        store.runTransaction('readonly', (scope) => scope.keys())
      ).resolves.toEqual([]);

      const detectCalls = transactionSpy.mock.calls.filter(([storeNames]) =>
        Array.isArray(storeNames)
          ? storeNames.includes('local-forage-detect-blob-support')
          : storeNames === 'local-forage-detect-blob-support'
      );
      expect(detectCalls).toHaveLength(0);
    } finally {
      await cleanupStore(store);
    }
  });
});
