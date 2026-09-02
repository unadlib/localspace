import { describe, expect, it, vi } from 'vitest';
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  ttlPlugin,
  type LocalSpacePlugin,
  type PluginContext,
  type PluginIterateSummary,
} from '../src';

const uniqueName = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe('logical query and iteration plugin coverage', () => {
  it.each([
    [
      'Memory',
      (store: ReturnType<typeof localspace.createInstance>) => store.MEMORY,
    ],
    [
      'LocalStorage',
      (store: ReturnType<typeof localspace.createInstance>) =>
        store.LOCALSTORAGE,
    ],
    [
      'IndexedDB',
      (store: ReturnType<typeof localspace.createInstance>) => store.INDEXEDDB,
    ],
  ])(
    'excludes expired TTL entries while retaining stored null values on %s',
    async (_driverName, selectDriver) => {
      const onExpire = vi.fn();
      const name = uniqueName('logical-ttl-query');
      const store = localspace.createInstance({
        name,
        storeName: 'store',
        plugins: [
          ttlPlugin({
            keyTTL: { expired: 5 },
            onExpire,
          }),
        ],
      });
      await store.setDriver([selectDriver(store)]);
      await store.setItems([
        { key: 'expired', value: 'gone' },
        { key: 'stored-null', value: null },
        { key: 'live', value: 'present' },
      ]);
      await sleep(20);

      const logicalKeys = await store.keys();
      expect(logicalKeys.slice().sort()).toEqual(['live', 'stored-null']);
      await expect(store.length()).resolves.toBe(2);
      await expect(store.key(0)).resolves.toBe(logicalKeys[0]);
      await expect(store.key(1)).resolves.toBe(logicalKeys[1]);
      await expect(store.key(2)).resolves.toBeNull();
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(onExpire).toHaveBeenCalledWith('expired', 'gone');

      await store.dropInstance({ name, storeName: 'store' });
      await store.close();
    }
  );

  it('awaits iteration callbacks and exposes only decoded logical values', async () => {
    const summaries: PluginIterateSummary[] = [];
    const observer: LocalSpacePlugin = {
      name: 'iterate-observer',
      afterIterate: (summary, context) => {
        expect(Object.isFrozen(summary)).toBe(true);
        expect(Reflect.ownKeys(context.operationState)).toEqual([]);
        summaries.push(summary);
      },
    };
    const store = localspace.createInstance({
      name: uniqueName('logical-plugin-iterate'),
      storeName: 'store',
      plugins: [
        ttlPlugin({ defaultTTL: 60_000 }),
        compressionPlugin({ threshold: 1 }),
        encryptionPlugin({
          key: '0123456789abcdef0123456789abcdef',
        }),
        observer,
      ],
    });
    await store.setDriver([store.MEMORY]);
    await store.setItems([
      { key: 'a', value: { label: 'first' } },
      { key: 'b', value: { label: 'second' } },
      { key: 'c', value: { label: 'third' } },
    ]);

    const order: string[] = [];
    const result = await store.iterate<{ label: string }, string>(
      async (value, key, iterationNumber) => {
        order.push(`start:${key}:${value.label}:${iterationNumber}`);
        await Promise.resolve();
        order.push(`end:${key}`);
        return key === 'b' ? 'stopped' : undefined;
      }
    );

    expect(result).toBe('stopped');
    expect(order).toEqual([
      'start:a:first:1',
      'end:a',
      'start:b:second:2',
      'end:b',
    ]);
    expect(summaries).toEqual([{ iterations: 2, stopped: true }]);

    await store.close();
  });

  it('notifies every query, clear, and drop observer exactly once', async () => {
    const events: string[] = [];
    const contexts: PluginContext[] = [];
    let observedKeys: readonly string[] | undefined;
    const plugin: LocalSpacePlugin = {
      name: 'complete-observer',
      beforeIterate: (context) => {
        events.push('beforeIterate');
        contexts.push(context);
      },
      afterIterate: (summary, context) => {
        expect(summary).toEqual({ iterations: 1, stopped: false });
        events.push('afterIterate');
        contexts.push(context);
      },
      beforeKeys: (context) => {
        events.push('beforeKeys');
        contexts.push(context);
      },
      afterKeys: (keys, context) => {
        expect(Object.isFrozen(keys)).toBe(true);
        observedKeys = keys;
        events.push('afterKeys');
        contexts.push(context);
      },
      beforeKey: (index, context) => {
        expect(index).toBe(0);
        events.push('beforeKey');
        contexts.push(context);
      },
      afterKey: (index, key, context) => {
        expect([index, key]).toEqual([0, 'value']);
        events.push('afterKey');
        contexts.push(context);
      },
      beforeLength: (context) => {
        events.push('beforeLength');
        contexts.push(context);
      },
      afterLength: (length, context) => {
        expect(length).toBe(1);
        events.push('afterLength');
        contexts.push(context);
      },
      beforeClear: (context) => {
        events.push('beforeClear');
        contexts.push(context);
      },
      afterClear: (context) => {
        events.push('afterClear');
        contexts.push(context);
      },
      beforeDropInstance: (options, context) => {
        expect(Object.isFrozen(options)).toBe(true);
        events.push('beforeDropInstance');
        contexts.push(context);
      },
      afterDropInstance: (options, context) => {
        expect(Object.isFrozen(options)).toBe(true);
        events.push('afterDropInstance');
        contexts.push(context);
      },
    };
    const name = uniqueName('complete-observer');
    const store = localspace.createInstance({
      name,
      storeName: 'store',
      plugins: [plugin],
    });
    await store.setDriver([store.MEMORY]);
    await store.setItem('value', 1);

    const returnedKeys = await store.keys();
    await store.key(0);
    await store.length();
    await store.iterate(async () => {
      await Promise.resolve();
    });
    returnedKeys.push('caller-only');
    expect(observedKeys).toEqual(['value']);

    await store.clear();
    await store.setItem('value', 2);
    await store.dropInstance({ name, storeName: 'store' });

    expect(events).toEqual([
      'beforeKeys',
      'afterKeys',
      'beforeKey',
      'afterKey',
      'beforeLength',
      'afterLength',
      'beforeIterate',
      'afterIterate',
      'beforeClear',
      'afterClear',
      'beforeDropInstance',
      'afterDropInstance',
    ]);
    expect(contexts.map(({ operation }) => operation)).toEqual([
      'keys',
      'keys',
      'key',
      'key',
      'length',
      'length',
      'iterate',
      'iterate',
      'clear',
      'clear',
      'dropInstance',
      'dropInstance',
    ]);

    await store.close();
  });

  it('preserves global priority order for destructive observers', async () => {
    const order: string[] = [];
    const createObserver = (
      name: string,
      priority: number
    ): LocalSpacePlugin => ({
      name,
      priority,
      beforeClear: () => {
        order.push(`${name}:before`);
      },
      afterClear: () => {
        order.push(`${name}:after`);
      },
    });
    const store = localspace.createInstance({
      name: uniqueName('observer-order'),
      plugins: [createObserver('low', 0), createObserver('high', 10)],
    });
    await store.setDriver([store.MEMORY]);

    await store.clear();

    expect(order).toEqual([
      'high:before',
      'low:before',
      'low:after',
      'high:after',
    ]);
    await store.close();
  });

  it('observes the outer transaction lifecycle without exposing its result', async () => {
    const events: string[] = [];
    const contexts: PluginContext[] = [];
    const createObserver = (
      name: string,
      priority: number
    ): LocalSpacePlugin => ({
      name,
      priority,
      beforeRunTransaction: (mode, context) => {
        expect(mode).toBe('readwrite');
        expect(context.transactionScope).toBeUndefined();
        events.push(`${name}:before`);
        contexts.push(context);
      },
      afterRunTransaction: (mode, context) => {
        expect(mode).toBe('readwrite');
        expect(context.transactionScope).toBeUndefined();
        events.push(`${name}:after`);
        contexts.push(context);
      },
    });
    const store = localspace.createInstance({
      name: uniqueName('transaction-observers'),
      plugins: [createObserver('low', 0), createObserver('high', 10)],
    });
    await store.setDriver([store.MEMORY]);

    await expect(
      store.runTransaction('readwrite', async (scope) => {
        events.push('runner');
        await scope.set('committed', true);
        return { privateResult: true };
      })
    ).resolves.toEqual({ privateResult: true });

    expect(events).toEqual([
      'high:before',
      'low:before',
      'runner',
      'low:after',
      'high:after',
    ]);
    expect(contexts.map(({ operation }) => operation)).toEqual([
      'runTransaction',
      'runTransaction',
      'runTransaction',
      'runTransaction',
    ]);

    events.length = 0;
    await expect(
      store.runTransaction('readwrite', async (scope) => {
        await scope.set('rolled-back', true);
        throw new Error('expected rollback');
      })
    ).rejects.toThrow('expected rollback');
    expect(events).toEqual(['high:before', 'low:before']);
    await expect(store.getItem('rolled-back')).resolves.toBeNull();

    await store.close();
  });

  it('reports a strict after-transaction observer without rejecting the commit', async () => {
    const observerError = new Error('commit notification failed');
    const onError = vi.fn();
    const afterRunTransaction = vi.fn(() => {
      throw observerError;
    });
    const store = localspace.createInstance({
      name: uniqueName('transaction-after-observer-error'),
      pluginErrorPolicy: 'strict',
      plugins: [
        {
          name: 'failing-commit-observer',
          afterRunTransaction,
          onError,
        },
      ],
    });
    await store.setDriver([store.MEMORY]);

    await expect(
      store.runTransaction('readwrite', (scope) =>
        scope.set('committed-before-observer', true)
      )
    ).resolves.toBe(true);
    expect(afterRunTransaction).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      observerError,
      expect.objectContaining({
        operation: 'runTransaction',
        stage: 'after',
      })
    );
    await expect(store.getItem('committed-before-observer')).resolves.toBe(
      true
    );

    await store.close();
  });
});
