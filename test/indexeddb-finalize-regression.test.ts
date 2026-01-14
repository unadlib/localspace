import { describe, it, expect, vi } from 'vitest';
import indexeddbDriver from '../src/drivers/indexeddb';
import type { DbInfo } from '../src/types';

class FakeTransaction {
  private listeners: Record<string, Array<(...args: any[]) => void>> =
    Object.create(null);

  addEventListener(event: string, handler: (...args: any[]) => void) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(handler);
  }

  trigger(event: string) {
    for (const handler of this.listeners[event] ?? []) {
      handler();
    }
  }
}

describe('IndexedDB createTransaction finalize', () => {
  it('runs finalize only once when error and abort both fire', () => {
    vi.useFakeTimers();

    const testHooks = (indexeddbDriver as any).__test__;
    expect(testHooks?.createTransaction).toBeDefined();
    expect(testHooks?.getDbContext).toBeDefined();

    const tx = new FakeTransaction();
    const fakeDb = {
      transaction: vi.fn(() => tx),
    } as any;

    const dbInfo: DbInfo = {
      name: 'finalize-test',
      storeName: 'store',
      db: fakeDb,
    };

    testHooks.createTransaction(
      dbInfo,
      'readwrite',
      (err: Error | null, returnedTx?: IDBTransaction) => {
        expect(err).toBeNull();
        expect(returnedTx).toBe(tx);
      }
    );

    const dbContext = testHooks.getDbContext(dbInfo);
    const pendingFirst = vi.fn();
    const pendingSecond = vi.fn();
    dbContext.pendingTransactions.push(pendingFirst, pendingSecond);

    tx.trigger('error');
    tx.trigger('abort');
    vi.runAllTimers();

    expect(pendingFirst).toHaveBeenCalledTimes(1);
    expect(pendingSecond).not.toHaveBeenCalled();
    expect(dbContext.pendingTransactions).toHaveLength(1);
    expect(dbContext.activeTransactions).toBe(0);
  });

  it('respects maxConcurrentTransactions and drains pending', () => {
    vi.useFakeTimers();
    const testHooks = (indexeddbDriver as any).__test__;
    expect(testHooks?.createTransaction).toBeDefined();

    const tx1 = new FakeTransaction();
    const tx2 = new FakeTransaction();
    const fakeDb = {
      transaction: vi
        .fn()
        .mockImplementationOnce(() => tx1)
        .mockImplementationOnce(() => tx2),
    } as any;

    const dbInfo: any = {
      name: 'pending-test',
      storeName: 'store',
      db: fakeDb,
      maxConcurrentTransactions: 1,
    };

    const callbacks: Array<IDBTransaction | undefined> = [];

    testHooks.createTransaction(
      dbInfo,
      'readwrite',
      (_err: Error | null, tx?: IDBTransaction) => callbacks.push(tx)
    );
    testHooks.createTransaction(
      dbInfo,
      'readwrite',
      (_err: Error | null, tx?: IDBTransaction) => callbacks.push(tx)
    );

    const dbContext = testHooks.getDbContext(dbInfo);
    expect(dbContext.activeTransactions).toBe(1);
    expect(dbContext.pendingTransactions).toHaveLength(1);
    expect(callbacks).toHaveLength(1);

    tx1.trigger('complete');
    vi.runAllTimers();

    expect(dbContext.activeTransactions).toBe(1);
    expect(dbContext.pendingTransactions).toHaveLength(0);
    expect(callbacks).toHaveLength(2);
    expect(callbacks[1]).toBe(tx2);
  });
});
