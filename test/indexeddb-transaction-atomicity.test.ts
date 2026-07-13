import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import localspace from '../src';
import type { LocalSpaceInstance } from '../src/types';

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('IndexedDB transaction atomicity', () => {
  let store: LocalSpaceInstance;

  beforeEach(async () => {
    store = localspace.createInstance({
      name: `indexeddb-atomic-${Math.random().toString(36).slice(2)}`,
      storeName: 'store',
      prewarmTransactions: false,
    });
    await store.setDriver([store.INDEXEDDB]);
    await store.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.dropInstance().catch(() => undefined);
  });

  it('does not run blob capability detection for readonly transactions', async () => {
    const db = (store as LocalSpaceInstance & { _dbInfo: { db: IDBDatabase } })
      ._dbInfo.db;
    const transactionSpy = vi.spyOn(db, 'transaction');

    await expect(
      store.runTransaction('readonly', async (scope) => {
        await delay(5);
        return scope.keys();
      })
    ).resolves.toEqual([]);

    const detectCalls = transactionSpy.mock.calls.filter(([storeNames]) =>
      Array.isArray(storeNames)
        ? storeNames.includes('local-forage-detect-blob-support')
        : storeNames === 'local-forage-detect-blob-support'
    );
    expect(detectCalls).toHaveLength(0);
  });

  it('aborts writes when an asynchronous runner rejects after a delay', async () => {
    await store.setItem('value', 'original');

    await expect(
      store.runTransaction('readwrite', async (scope) => {
        await scope.set('value', 'modified');
        await delay(20);
        throw new Error('late runner failure');
      })
    ).rejects.toThrow('late runner failure');

    await expect(store.getItem('value')).resolves.toBe('original');
  });

  it('keeps the transaction active across arbitrary awaited work', async () => {
    await store.runTransaction('readwrite', async (scope) => {
      await scope.set('first', 1);
      await delay(20);
      await scope.set('second', 2);
    });

    await expect(store.getItems(['first', 'second'])).resolves.toEqual([
      { key: 'first', value: 1 },
      { key: 'second', value: 2 },
    ]);
  });

  it('settles once when the runner and transaction fail together', async () => {
    const result = store.runTransaction('readwrite', async (scope) => {
      await scope.set('uncloneable', () => undefined);
      return 'unreachable';
    });

    await expect(
      Promise.race([
        result,
        delay(500).then(() => {
          throw new Error('transaction did not settle');
        }),
      ])
    ).rejects.not.toThrow('transaction did not settle');
    await expect(store.getItem('uncloneable')).resolves.toBeNull();
  });
});
