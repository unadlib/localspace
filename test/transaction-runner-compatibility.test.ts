import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace from '../src';
import type { LocalSpaceInstance } from '../src/types';

const timeoutAfter = (ms: number) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('transaction runner timed out')), ms);
  });

const createStore = async (
  driver: 'memory' | 'indexeddb'
): Promise<LocalSpaceInstance> => {
  const store = localspace.createInstance({
    name: `transaction-runner-${driver}-${Math.random().toString(36).slice(2)}`,
    storeName: 'store',
    prewarmTransactions: false,
  });
  await store.setDriver([
    driver === 'memory' ? store.MEMORY : store.INDEXEDDB,
  ]);
  await store.ready();
  return store;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(['memory', 'indexeddb'] as const)(
  '%s transaction runner compatibility',
  (driver) => {
    it('can await an ordinary instance operation without deadlocking', async () => {
      const store = await createStore(driver);

      try {
        const result = await Promise.race([
          store.runTransaction('readwrite', async () => {
            await store.setItem('ordinary-operation', 'completed');
            return 'runner-completed';
          }),
          timeoutAfter(500),
        ]);

        expect(result).toBe('runner-completed');
        await expect(store.getItem('ordinary-operation')).resolves.toBe(
          'completed'
        );
      } finally {
        await store.dropInstance().catch(() => undefined);
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
      await store.dropInstance().catch(() => undefined);
    }
  });
});
