import { describe, expect, it } from 'vitest';
import localspace from '../src';
import type { LocalSpaceInstance } from '../src';

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const createStore = async (
  name: string,
  storeName = 'store'
): Promise<LocalSpaceInstance> => {
  const store = localspace.createInstance({ name, storeName });
  await store.setDriver([store.MEMORY]);
  await store.ready();
  return store;
};

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

describe('Memory realm/store transaction scheduling', () => {
  it('queues ordinary operations from another instance behind a transaction', async () => {
    const name = uniqueName('memory-ordinary-queue');
    const first = await createStore(name);
    const second = await createStore(name);
    const entered = deferred();
    const release = deferred();
    let writeSettled = false;
    let readSettled = false;

    const transaction = first.runTransaction('readwrite', async (scope) => {
      await scope.set('inside', 'transaction');
      entered.resolve();
      await release.promise;
      return 'committed';
    });
    await entered.promise;

    const queuedWrite = second.setItem('outside', 'ordinary').finally(() => {
      writeSettled = true;
    });
    const queuedRead = second.getItem('inside').finally(() => {
      readSettled = true;
    });
    await delay(10);
    expect(writeSettled).toBe(false);
    expect(readSettled).toBe(false);

    release.resolve();
    await expect(transaction).resolves.toBe('committed');
    await expect(queuedWrite).resolves.toBe('ordinary');
    await expect(queuedRead).resolves.toBe('transaction');
    await expect(first.getItem('outside')).resolves.toBe('ordinary');
  });

  it('discards a failed working copy before a queued writer runs', async () => {
    const name = uniqueName('memory-rollback-queue');
    const first = await createStore(name);
    const second = await createStore(name);
    await first.setItem('counter', 0);
    const entered = deferred();
    const release = deferred();

    const transaction = first.runTransaction('readwrite', async (scope) => {
      await scope.set('counter', 99);
      await scope.set('transaction-only', true);
      entered.resolve();
      await release.promise;
      throw new Error('rollback');
    });
    await entered.promise;
    const queuedWrite = second.setItem('counter', 2);

    release.resolve();
    await expect(transaction).rejects.toThrow('rollback');
    await expect(queuedWrite).resolves.toBe(2);
    await expect(first.getItem('counter')).resolves.toBe(2);
    await expect(first.getItem('transaction-only')).resolves.toBeNull();
  });

  it('serializes transactions from competing instances without lost updates', async () => {
    const name = uniqueName('memory-competing-transactions');
    const first = await createStore(name);
    const second = await createStore(name);
    await first.setItem('counter', 0);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;

    const increment = (
      store: LocalSpaceInstance,
      onRead?: (value: number) => Promise<void> | void
    ) =>
      store.runTransaction('readwrite', async (scope) => {
        const current = (await scope.get<number>('counter')) ?? 0;
        await onRead?.(current);
        await scope.set('counter', current + 1);
        return current + 1;
      });

    const firstTransaction = increment(first, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const secondTransaction = increment(second, () => {
      secondEntered = true;
    });
    await delay(10);
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    await expect(firstTransaction).resolves.toBe(1);
    await expect(secondTransaction).resolves.toBe(2);
    await expect(first.getItem('counter')).resolves.toBe(2);
  });

  it('uses the same exclusive scheduler for readonly transactions', async () => {
    const name = uniqueName('memory-readonly-queue');
    const first = await createStore(name);
    const second = await createStore(name);
    await first.setItem('value', 'before');
    const entered = deferred();
    const release = deferred();
    let writeSettled = false;

    const transaction = first.runTransaction('readonly', async (scope) => {
      await expect(scope.get('value')).resolves.toBe('before');
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const queuedWrite = second.setItem('value', 'after').finally(() => {
      writeSettled = true;
    });
    await delay(10);
    expect(writeSettled).toBe(false);

    release.resolve();
    await transaction;
    await queuedWrite;
    await expect(first.getItem('value')).resolves.toBe('after');
  });

  it('does not coordinate different store namespaces', async () => {
    const name = uniqueName('memory-store-isolation');
    const blockedStore = await createStore(name, 'blocked');
    const independentStore = await createStore(name, 'independent');
    const entered = deferred();
    const release = deferred();

    const transaction = blockedStore.runTransaction(
      'readwrite',
      async (scope) => {
        await scope.set('value', 'blocked');
        entered.resolve();
        await release.promise;
      }
    );
    await entered.promise;

    await expect(
      Promise.race([
        independentStore.setItem('value', 'independent'),
        delay(100).then(() => {
          throw new Error('independent store was blocked');
        }),
      ])
    ).resolves.toBe('independent');

    release.resolve();
    await transaction;
    await expect(blockedStore.getItem('value')).resolves.toBe('blocked');
    await expect(independentStore.getItem('value')).resolves.toBe(
      'independent'
    );
  });

  it('queues clear and drop operations behind the namespace transaction', async () => {
    const name = uniqueName('memory-destructive-queue');
    const first = await createStore(name);
    const second = await createStore(name);
    await first.setItem('preserved-until-release', true);
    const entered = deferred();
    const release = deferred();
    let clearSettled = false;

    const transaction = first.runTransaction('readonly', async (scope) => {
      await scope.keys();
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const clearing = second.clear().finally(() => {
      clearSettled = true;
    });
    await delay(10);
    expect(clearSettled).toBe(false);

    release.resolve();
    await transaction;
    await clearing;
    await expect(first.keys()).resolves.toEqual([]);

    await first.setItem('drop-me', true);
    await second.dropInstance();
    await expect(first.keys()).resolves.toEqual([]);
  });
});
