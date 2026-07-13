import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import localspace from '../src';
import type { LocalSpaceInstance } from '../src/types';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const waitForScheduling = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('memory transaction isolation', () => {
  let primary: LocalSpaceInstance;
  let secondary: LocalSpaceInstance;

  beforeEach(async () => {
    const name = `memory-isolation-${Math.random().toString(36).slice(2)}`;
    primary = localspace.createInstance({ name, storeName: 'store' });
    secondary = localspace.createInstance({ name, storeName: 'store' });
    await Promise.all([
      primary.setDriver([primary.MEMORY]),
      secondary.setDriver([secondary.MEMORY]),
    ]);
    await primary.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await primary.dropInstance().catch(() => undefined);
  });

  it('does not let rollback overwrite a concurrent successful write', async () => {
    await primary.setItem('counter', 0);
    const transactionWrote = deferred();
    const finishTransaction = deferred();

    const transaction = primary.runTransaction('readwrite', async (scope) => {
      await scope.set('counter', 1);
      transactionWrote.resolve();
      await finishTransaction.promise;
      throw new Error('rollback');
    });

    await transactionWrote.promise;
    let externalWriteFinished = false;
    const externalWrite = secondary.setItem('counter', 2).then(() => {
      externalWriteFinished = true;
    });

    await waitForScheduling();
    expect(externalWriteFinished).toBe(false);
    finishTransaction.resolve();

    await expect(transaction).rejects.toThrow('rollback');
    await externalWrite;
    await expect(primary.getItem('counter')).resolves.toBe(2);
  });

  it('hides uncommitted transaction values from ordinary readers', async () => {
    await primary.setItem('status', 'committed');
    const transactionWrote = deferred();
    const finishTransaction = deferred();

    const transaction = primary.runTransaction('readwrite', async (scope) => {
      await scope.set('status', 'pending');
      transactionWrote.resolve();
      await finishTransaction.promise;
    });

    await transactionWrote.promise;
    await expect(secondary.getItem('status')).resolves.toBe('committed');
    finishTransaction.resolve();
    await transaction;
    await expect(secondary.getItem('status')).resolves.toBe('pending');
  });

  it('serializes concurrent transactions without losing updates', async () => {
    await primary.setItem('counter', 0);

    const first = primary.runTransaction('readwrite', async (scope) => {
      const value = (await scope.get<number>('counter')) ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await scope.set('counter', value + 1);
      return value + 1;
    });
    const second = secondary.runTransaction('readwrite', async (scope) => {
      const value = (await scope.get<number>('counter')) ?? 0;
      await scope.set('counter', value + 10);
      return value + 10;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 11]);
    await expect(primary.getItem('counter')).resolves.toBe(11);
  });

  it('keeps a readonly transaction on one consistent snapshot', async () => {
    await primary.setItem('value', 1);
    const firstReadFinished = deferred();
    const finishRead = deferred();

    const snapshot = primary.runTransaction('readonly', async (scope) => {
      const before = await scope.get<number>('value');
      firstReadFinished.resolve();
      await finishRead.promise;
      const after = await scope.get<number>('value');
      return { before, after };
    });

    await firstReadFinished.promise;
    let externalWriteFinished = false;
    const externalWrite = secondary.setItem('value', 2).then(() => {
      externalWriteFinished = true;
    });
    await waitForScheduling();
    expect(externalWriteFinished).toBe(false);

    finishRead.resolve();
    await expect(snapshot).resolves.toEqual({ before: 1, after: 1 });
    await externalWrite;
    await expect(primary.getItem('value')).resolves.toBe(2);
  });
});
