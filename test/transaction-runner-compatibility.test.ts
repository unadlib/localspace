import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import localspace from '../src';
import type { LocalSpaceInstance, LocalSpaceOptions } from '../src/types';
import { resetDeprecationWarningsForTests } from '../src/utils/deprecations';

const timeoutAfter = (ms: number) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('transaction runner timed out')), ms);
  });

const createStore = async (
  driver: 'memory' | 'indexeddb',
  options: LocalSpaceOptions = {}
): Promise<LocalSpaceInstance> => {
  const store = localspace.createInstance({
    name: `transaction-runner-${driver}-${Math.random().toString(36).slice(2)}`,
    storeName: 'store',
    prewarmTransactions: false,
    ...options,
  });
  await store.setDriver([
    driver === 'memory' ? store.MEMORY : store.INDEXEDDB,
  ]);
  await store.ready();
  return store;
};

beforeEach(() => {
  resetDeprecationWarningsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetDeprecationWarningsForTests();
  vi.restoreAllMocks();
});

const transactionScopeWarnings = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map(([message]) => String(message))
    .filter((message) => message.includes('strictTransactions'));

describe.each(['memory', 'indexeddb'] as const)(
  '%s transaction runner compatibility',
  (driver) => {
    it('can await an ordinary instance operation without deadlocking', async () => {
      const store = await createStore(driver);

      try {
        const result = await Promise.race([
          store.runTransaction('readwrite', async () => {
            await store.setItem('ordinary-operation', 'completed');
            await expect(
              store.getItem('ordinary-operation')
            ).resolves.toBe('completed');
            return 'runner-completed';
          }),
          timeoutAfter(500),
        ]);

        expect(result).toBe('runner-completed');
        await expect(store.getItem('ordinary-operation')).resolves.toBe(
          'completed'
        );
        expect(transactionScopeWarnings()).toEqual([
          '[localspace] Deprecation: calling ordinary instance storage APIs from an active `runTransaction()` runner is deprecated; use only the supplied transaction scope. Enable `strictTransactions: true` to reject this 2.1 behavior before upgrading to 3.0.',
        ]);
      } finally {
        await store.dropInstance().catch(() => undefined);
      }
    });

    it('can opt into the 3.0 transaction-scope requirement before side effects', async () => {
      const store = await createStore(driver, { strictTransactions: true });

      try {
        const result = await store.runTransaction(
          'readwrite',
          async (scope) => {
            await expect(
              store.setItem('ordinary-operation', 'blocked')
            ).rejects.toMatchObject({
              code: 'TRANSACTION_SCOPE_REQUIRED',
              details: {
                operation: 'setItem',
                reason: 'transaction-scope-required',
              },
            });
            await scope.set('scoped-operation', 'committed');
            return 'runner-completed';
          }
        );

        expect(result).toBe('runner-completed');
        await expect(store.getItem('ordinary-operation')).resolves.toBeNull();
        await expect(store.getItem('scoped-operation')).resolves.toBe(
          'committed'
        );
        expect(transactionScopeWarnings()).toHaveLength(1);
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
