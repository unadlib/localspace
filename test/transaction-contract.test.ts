import { describe, expect, it, vi } from 'vitest';
import localspace from '../src';
import type {
  LocalSpaceInstance,
  LocalSpacePlugin,
  StorageValue,
  TransactionScope,
} from '../src/types';

type TransactionDriver = 'memory' | 'indexeddb';

const timeoutAfter = (ms: number) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('transaction runner timed out')), ms);
  });

const createStore = async (
  driver: TransactionDriver,
  plugins: LocalSpacePlugin[] = []
): Promise<LocalSpaceInstance> => {
  const store = localspace.createInstance({
    name: `transaction-contract-${driver}-${Math.random().toString(36).slice(2)}`,
    storeName: 'store',
    plugins,
    pluginErrorPolicy: 'strict',
  });
  await store.setDriver([driver === 'memory' ? store.MEMORY : store.INDEXEDDB]);
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
      const operations: Array<
        [string, (instance: LocalSpaceInstance) => Promise<unknown>]
      > = [
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
        ['setItems', (instance) => instance.setItems({ ordinary: 'blocked' })],
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

    it('rejects an ordinary operation issued in the same tick as the runner', async () => {
      // Admission order, rather than driver timing, decides which call owns the
      // transaction window.
      for (let attempt = 0; attempt < 3; attempt++) {
        const store = await createStore(driver);

        try {
          const [transaction, ordinary] = await Promise.allSettled([
            store.runTransaction('readwrite', async (scope) => {
              await scope.set('scoped', 'committed');
              return 'runner-completed';
            }),
            store.setItem('ordinary', 'blocked'),
          ]);

          expect(transaction).toMatchObject({
            status: 'fulfilled',
            value: 'runner-completed',
          });
          expect(ordinary).toMatchObject({
            status: 'rejected',
            reason: {
              code: 'TRANSACTION_SCOPE_REQUIRED',
              details: {
                operation: 'setItem',
                reason: 'transaction-scope-required',
              },
            },
          });
          await expect(store.getItem('ordinary')).resolves.toBeNull();
          await expect(store.getItem('scoped')).resolves.toBe('committed');
        } finally {
          await cleanupStore(store);
        }
      }
    });

    it('rejects every overlapping transaction deterministically', async () => {
      const store = await createStore(driver);

      try {
        await store.setItem('counter', 0);

        const increment = (amount: number) =>
          store.runTransaction('readwrite', async (scope) => {
            const current = (await scope.get<number>('counter')) ?? 0;
            await scope.set('counter', current + amount);
            return current;
          });

        const results = await Promise.race([
          Promise.allSettled([increment(1), increment(10)]),
          timeoutAfter(1000),
        ]);

        expect(results.map((result) => result.status)).toEqual([
          'fulfilled',
          'rejected',
        ]);
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: {
            code: 'TRANSACTION_SCOPE_REQUIRED',
            details: {
              operation: 'runTransaction',
              reason: 'transaction-scope-required',
            },
          },
        });
        await expect(store.getItem('counter')).resolves.toBe(1);

        await expect(increment(10)).resolves.toBe(1);
        await expect(store.getItem('counter')).resolves.toBe(11);
      } finally {
        await cleanupStore(store);
      }
    });

    it('rejects a nested transaction rather than queueing it behind its own runner', async () => {
      const store = await createStore(driver);

      try {
        const result = await Promise.race([
          store.runTransaction('readwrite', async (scope) => {
            await expect(
              store.runTransaction('readwrite', () => 'inner')
            ).rejects.toMatchObject({
              code: 'TRANSACTION_SCOPE_REQUIRED',
              details: {
                operation: 'runTransaction',
                reason: 'transaction-scope-required',
              },
            });
            await scope.set('scoped', 'committed');
            return 'runner-completed';
          }),
          timeoutAfter(500),
        ]);

        expect(result).toBe('runner-completed');
        await expect(store.getItem('scoped')).resolves.toBe('committed');
      } finally {
        await cleanupStore(store);
      }
    });

    it('rejects an unrelated transaction started after the runner is executing', async () => {
      const store = await createStore(driver);
      let enterRunner!: () => void;
      const runnerEntered = new Promise<void>((resolve) => {
        enterRunner = resolve;
      });
      let releaseRunner!: () => void;
      const runnerHeld = new Promise<void>((resolve) => {
        releaseRunner = resolve;
      });

      try {
        const first = store.runTransaction('readwrite', async (scope) => {
          await scope.set('scoped', 'committed');
          enterRunner();
          await runnerHeld;
          return 'runner-completed';
        });

        await runnerEntered;
        const overlapping = store.runTransaction(
          'readwrite',
          () => 'unrelated'
        );
        await expect(overlapping).rejects.toMatchObject({
          code: 'TRANSACTION_SCOPE_REQUIRED',
          details: {
            operation: 'runTransaction',
            reason: 'transaction-scope-required',
          },
        });

        releaseRunner();
        await expect(Promise.race([first, timeoutAfter(500)])).resolves.toBe(
          'runner-completed'
        );
      } finally {
        releaseRunner();
        await cleanupStore(store);
      }
    });

    it('rejects transaction reentry from plugin initialization without deadlocking', async () => {
      let shouldReenter = true;
      let nestedError: unknown;
      const nestedRunner = vi.fn(() => 'nested');
      const outerRunner = vi.fn(() => 'outer');
      const plugin: LocalSpacePlugin = {
        name: 'transaction-init-reentry',
        async onInit(context) {
          if (!shouldReenter) return;
          shouldReenter = false;
          try {
            await context.instance.runTransaction('readonly', nestedRunner);
          } catch (error) {
            nestedError = error;
          }
        },
      };
      const store = await createStore(driver, [plugin]);

      try {
        await expect(
          Promise.race([
            store.runTransaction('readonly', outerRunner),
            timeoutAfter(500),
          ])
        ).resolves.toBe('outer');
        expect(nestedError).toMatchObject({
          code: 'OPERATION_FAILED',
          details: {
            operation: 'runTransaction',
            reason: 'lifecycle-reentrancy',
            lifecycle: 'plugin-init',
          },
        });
        expect(nestedRunner).not.toHaveBeenCalled();
        expect(outerRunner).toHaveBeenCalledTimes(1);
      } finally {
        await cleanupStore(store);
      }
    });

    it('rejects transaction reentry from a before observer without deadlocking', async () => {
      let shouldReenter = true;
      let nestedError: unknown;
      const nestedRunner = vi.fn(() => 'nested');
      const outerRunner = vi.fn(() => 'outer');
      const plugin: LocalSpacePlugin = {
        name: 'transaction-before-reentry',
        async beforeRunTransaction(_mode, context) {
          if (!shouldReenter) return;
          shouldReenter = false;
          try {
            await context.instance.runTransaction('readonly', nestedRunner);
          } catch (error) {
            nestedError = error;
          }
        },
      };
      const store = await createStore(driver, [plugin]);

      try {
        await expect(
          Promise.race([
            store.runTransaction('readonly', outerRunner),
            timeoutAfter(500),
          ])
        ).resolves.toBe('outer');
        expect(nestedError).toMatchObject({
          code: 'TRANSACTION_SCOPE_REQUIRED',
          details: {
            operation: 'runTransaction',
            reason: 'transaction-scope-required',
          },
        });
        expect(nestedRunner).not.toHaveBeenCalled();
        expect(outerRunner).toHaveBeenCalledTimes(1);
      } finally {
        await cleanupStore(store);
      }
    });

    it('keeps the transaction window active through after observers', async () => {
      let shouldReenter = true;
      let nestedError: unknown;
      const nestedRunner = vi.fn(() => 'nested');
      const plugin: LocalSpacePlugin = {
        name: 'transaction-after-reentry',
        async afterRunTransaction(_mode, context) {
          if (!shouldReenter) return;
          shouldReenter = false;
          try {
            await context.instance.runTransaction('readonly', nestedRunner);
          } catch (error) {
            nestedError = error;
          }
        },
      };
      const store = await createStore(driver, [plugin]);

      try {
        await expect(
          Promise.race([
            store.runTransaction('readwrite', (scope) =>
              scope.set('committed', 'value')
            ),
            timeoutAfter(500),
          ])
        ).resolves.toBe('value');
        expect(nestedError).toMatchObject({
          code: 'TRANSACTION_SCOPE_REQUIRED',
          details: {
            operation: 'runTransaction',
            reason: 'transaction-scope-required',
          },
        });
        expect(nestedRunner).not.toHaveBeenCalled();
        await expect(store.getItem('committed')).resolves.toBe('value');
      } finally {
        await cleanupStore(store);
      }
    });

    it('does not claim a window for invalid transaction arguments', async () => {
      const store = await createStore(driver);
      const runner = vi.fn();

      try {
        const [transaction, ordinary] = await Promise.allSettled([
          store.runTransaction('versionchange' as never, runner),
          store.setItem('ordinary', 'stored'),
        ]);

        expect(transaction).toMatchObject({
          status: 'rejected',
          reason: {
            code: 'INVALID_ARGUMENT',
            details: { transactionMode: 'versionchange' },
          },
        });
        expect(ordinary).toMatchObject({
          status: 'fulfilled',
          value: 'stored',
        });
        expect(runner).not.toHaveBeenCalled();
        await expect(store.getItem('ordinary')).resolves.toBe('stored');

        const [missingRunner, nextOrdinary] = await Promise.allSettled([
          store.runTransaction('readonly', undefined as never),
          store.setItem('next', 'also-stored'),
        ]);
        expect(missingRunner).toMatchObject({
          status: 'rejected',
          reason: {
            code: 'INVALID_ARGUMENT',
            details: { reason: 'invalid-transaction-runner' },
          },
        });
        expect(nextOrdinary).toMatchObject({
          status: 'fulfilled',
          value: 'also-stored',
        });
        await expect(store.getItem('next')).resolves.toBe('also-stored');
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

        const scopeOperations: Array<[string, () => Promise<unknown>]> = [
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
      const db = (
        store as LocalSpaceInstance & { _dbInfo: { db: IDBDatabase } }
      )._dbInfo.db;
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
