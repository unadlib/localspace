import { describe, expect, it, vi } from 'vitest';
import localspace, { type LocalSpacePlugin } from '../src';
import { normalizeBatchEntries } from '../src/utils/helpers';

const createStore = (plugins: LocalSpacePlugin[]) => {
  const store = localspace.createInstance({
    name: `plugin-pipeline-${Math.random().toString(36).slice(2)}`,
    storeName: 'store',
    plugins,
  });
  return store.setDriver([store.MEMORY]).then(() => store);
};

describe('single-pass plugin pipeline', () => {
  it('exposes only the documented context surface, never driver internals', async () => {
    const operationKeys: string[][] = [];
    const lifecycleKeys: string[][] = [];
    const store = await createStore([
      {
        name: 'context-shape',
        onInit: (context) => {
          lifecycleKeys.push(Object.keys(context).sort());
        },
        afterSet: (_key, _value, context) => {
          operationKeys.push(Object.keys(context).sort());
        },
      },
    ]);

    await store.setItem('key', 'value');

    expect(operationKeys).toEqual([
      [
        'config',
        'driver',
        'instance',
        'metadata',
        'operation',
        'operationState',
      ].sort(),
    ]);
    expect(lifecycleKeys).toEqual([
      [
        'config',
        'driver',
        'instance',
        'lifecycleInstance',
        'metadata',
        'operation',
        'operationState',
      ].sort(),
    ]);
    // The live IndexedDB connection, factory, and internal key prefix reached
    // plugins through `dbInfo` before 3.0. Nothing driver-specific may return.
    for (const keys of [...operationKeys, ...lifecycleKeys]) {
      expect(keys).not.toContain('dbInfo');
    }
  });

  it('keeps operationState plugin-owned apart from documented batch metadata', async () => {
    const singleStateKeys: PropertyKey[][] = [];
    const batchStateKeys: PropertyKey[][] = [];
    const store = await createStore([
      {
        name: 'state-observer',
        afterSet: (_key, _value, context) => {
          singleStateKeys.push(Reflect.ownKeys(context.operationState));
        },
        afterSetItems: (entries, context) => {
          batchStateKeys.push(Reflect.ownKeys(context.operationState).sort());
          return entries;
        },
      },
    ]);

    await store.setItem('single', 'value');
    await store.setItems([{ key: 'batch', value: 'value' }]);

    expect(singleStateKeys).toEqual([[]]);
    expect(batchStateKeys).toEqual([['batchSize', 'isBatch']]);
  });

  it('uses a batch set hook instead of the matching single hook at its priority', async () => {
    const events: string[] = [];
    const middleSingleBefore = vi.fn(<T>(_key: string, value: T) => value);
    const middleSingleAfter = vi.fn();
    const plugins: LocalSpacePlugin[] = [
      {
        name: 'high-single',
        priority: 30,
        beforeSet: (key, value) => {
          events.push(`before:high:${key}`);
          return `${String(value)}:H`;
        },
        afterSet: (key) => {
          events.push(`after:high:${key}`);
        },
      },
      {
        name: 'middle-batch',
        priority: 20,
        beforeSet: middleSingleBefore,
        beforeSetItems: (entries) => {
          events.push('before:middle:batch');
          return normalizeBatchEntries(entries).map(({ key, value }) => ({
            key,
            value: `${String(value)}:B`,
          }));
        },
        afterSet: middleSingleAfter,
        afterSetItems: (entries) => {
          events.push('after:middle:batch');
          return entries;
        },
      },
      {
        name: 'low-single',
        priority: 10,
        beforeSet: (key, value) => {
          events.push(`before:low:${key}`);
          return `${String(value)}:L`;
        },
        afterSet: (key) => {
          events.push(`after:low:${key}`);
        },
      },
    ];
    const store = await createStore(plugins);

    await expect(
      store.setItems([
        { key: 'a', value: 'one' },
        { key: 'b', value: 'two' },
      ])
    ).resolves.toEqual([
      { key: 'a', value: 'one:H:B' },
      { key: 'b', value: 'two:H:B' },
    ]);

    expect(middleSingleBefore).not.toHaveBeenCalled();
    expect(middleSingleAfter).not.toHaveBeenCalled();
    expect(events).toEqual([
      'before:high:a',
      'before:high:b',
      'before:middle:batch',
      'before:low:a',
      'before:low:b',
      'after:low:a',
      'after:low:b',
      'after:middle:batch',
      'after:high:a',
      'after:high:b',
    ]);
    await expect(store.getItems<string>(['a', 'b'])).resolves.toEqual([
      { key: 'a', value: 'one:H:B:L' },
      { key: 'b', value: 'two:H:B:L' },
    ]);
  });

  it('uses a batch get hook instead of the matching single hook while preserving reverse priority', async () => {
    const events: string[] = [];
    const middleSingle = vi.fn(<T>(_key: string, value: T | null) => value);
    const plugins: LocalSpacePlugin[] = [
      {
        name: 'high-single',
        priority: 30,
        afterGet: (key, value) => {
          events.push(`after:high:${key}`);
          return `${String(value)}:H`;
        },
      },
      {
        name: 'middle-batch',
        priority: 20,
        afterGet: middleSingle,
        afterGetItems: (entries) => {
          events.push('after:middle:batch');
          return entries.map(({ key, value }) => ({
            key,
            value: `${String(value)}:B`,
          }));
        },
      },
      {
        name: 'low-single',
        priority: 10,
        afterGet: (key, value) => {
          events.push(`after:low:${key}`);
          return `${String(value)}:L`;
        },
      },
    ];
    const store = await createStore(plugins);
    await store.setItems([
      { key: 'a', value: 'one' },
      { key: 'b', value: 'two' },
    ]);

    await expect(store.getItems<string>(['a', 'b'])).resolves.toEqual([
      { key: 'a', value: 'one:L:B:H' },
      { key: 'b', value: 'two:L:B:H' },
    ]);
    expect(middleSingle).not.toHaveBeenCalled();
    expect(events).toEqual([
      'after:low:a',
      'after:low:b',
      'after:middle:batch',
      'after:high:a',
      'after:high:b',
    ]);

    events.length = 0;
    await expect(store.getItem<string>('a')).resolves.toBe('one:L:H');
    expect(middleSingle).toHaveBeenCalledOnce();
    expect(events).toEqual(['after:low:a', 'after:high:a']);
  });

  it('preserves logical return lineage when a batch hook passes through object values', async () => {
    const batchHook = vi.fn((entries) => entries);
    const store = await createStore([
      {
        name: 'single-object-transform',
        priority: 20,
        beforeSet: (_key, value) => ({
          ...(value as Record<string, unknown>),
          transformed: true,
        }),
      },
      {
        name: 'batch-pass-through',
        priority: 10,
        beforeSetItems: batchHook,
      },
    ]);
    const applicationValue = { application: true };

    await expect(
      store.setItems([{ key: 'object', value: applicationValue }])
    ).resolves.toEqual([{ key: 'object', value: applicationValue }]);
    expect(batchHook).toHaveBeenCalledOnce();
    await expect(store.getItem('object')).resolves.toEqual({
      application: true,
      transformed: true,
    });
  });

  it('uses batch remove hooks as the sole hook for their plugin and maps single-only hooks per key', async () => {
    const events: string[] = [];
    const middleSingleBefore = vi.fn((key: string) => key);
    const middleSingleAfter = vi.fn();
    const plugins: LocalSpacePlugin[] = [
      {
        name: 'high-single',
        priority: 30,
        beforeRemove: (key) => {
          events.push(`before:high:${key}`);
          return key;
        },
        afterRemove: (key) => {
          events.push(`after:high:${key}`);
        },
      },
      {
        name: 'middle-batch',
        priority: 20,
        beforeRemove: middleSingleBefore,
        beforeRemoveItems: (keys) => {
          events.push('before:middle:batch');
          return keys;
        },
        afterRemove: middleSingleAfter,
        afterRemoveItems: () => {
          events.push('after:middle:batch');
        },
      },
      {
        name: 'low-single',
        priority: 10,
        beforeRemove: (key) => {
          events.push(`before:low:${key}`);
          return key;
        },
        afterRemove: (key) => {
          events.push(`after:low:${key}`);
        },
      },
    ];
    const store = await createStore(plugins);
    await store.setItems([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ]);

    await store.removeItems(['a', 'b']);

    expect(middleSingleBefore).not.toHaveBeenCalled();
    expect(middleSingleAfter).not.toHaveBeenCalled();
    expect(events).toEqual([
      'before:high:a',
      'before:high:b',
      'before:middle:batch',
      'before:low:a',
      'before:low:b',
      'after:low:a',
      'after:low:b',
      'after:middle:batch',
      'after:high:a',
      'after:high:b',
    ]);
    await expect(store.keys()).resolves.toEqual([]);
  });
});
