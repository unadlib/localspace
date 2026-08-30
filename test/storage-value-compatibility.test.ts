import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import localspace, {
  LocalSpace,
  type LocalSpaceInstance,
  type LocalSpaceOptions,
  type StorageValue,
} from '../src';
import { inspectStorageValue } from '../src/core/storage-value';
import { resetDeprecationWarningsForTests } from '../src/utils/deprecations';

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const warnings = () =>
  vi.mocked(console.warn).mock.calls.map(([message]) => String(message));

async function createMemoryInstance(
  options: LocalSpaceOptions = {},
  clear = true
): Promise<LocalSpaceInstance> {
  const instance = localspace.createInstance({
    name: uniqueName('storage-value'),
    storeName: 'store',
    ...options,
  });
  await instance.setDriver([instance.MEMORY]);
  await instance.ready();
  if (clear) {
    await instance.clear();
  }
  return instance;
}

beforeEach(() => {
  resetDeprecationWarningsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetDeprecationWarningsForTests();
  vi.restoreAllMocks();
});

describe('2.1 StorageValue migration contract', () => {
  it('exports and accepts the supported recursive value type', async () => {
    const nullPrototype = Object.create(null) as Record<string, StorageValue>;
    nullPrototype.enabled = true;
    const values: StorageValue[] = [
      null,
      false,
      0,
      -0,
      'value',
      [1, { nested: 'value' }],
      nullPrototype,
      new ArrayBuffer(4),
      new Uint16Array([1, 2]),
    ];
    if (typeof BigInt64Array !== 'undefined') {
      values.push(new BigInt64Array([1n]));
    }

    const instance = await createMemoryInstance({ strictValues: true });
    await expect(
      instance.setItems(
        values.map((value, index) => ({ key: String(index), value }))
      )
    ).resolves.toHaveLength(values.length);
    expect(warnings()).toEqual([]);
  });

  it('warns once without changing legacy writes by default', async () => {
    const instance = await createMemoryInstance();
    const date = new Date('2026-08-31T00:00:00.000Z');

    await expect(instance.setItem('date', date)).resolves.toEqual(date);
    await expect(
      instance.setItem('map', new Map([['key', 1]]))
    ).resolves.toEqual(new Map([['key', 1]]));

    expect(warnings()).toEqual([
      '[localspace] Deprecation: Value at $ is outside the LocalSpace 3.0 StorageValue contract: only plain objects are supported. Convert it before upgrading to 3.0, or enable `strictValues: true` to reject it now.',
    ]);
  });

  it('rejects an unsupported item before plugin initialization or storage', async () => {
    const onInit = vi.fn();
    const name = uniqueName('strict-item');
    const instance = await createMemoryInstance({
      name,
      strictValues: true,
      plugins: [{ name: 'observer', onInit }],
    });

    await expect(
      instance.setItem('profile', {
        nested: { lastSeen: new Date('2026-08-31T00:00:00.000Z') },
      })
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        operation: 'setItem',
        key: 'profile',
        valuePath: '$.nested.lastSeen',
        valueType: 'Date',
      },
    });

    expect(onInit).not.toHaveBeenCalled();

    const reader = await createMemoryInstance({ name }, false);
    await expect(reader.getItem('profile')).resolves.toBeNull();
  });

  it.each(['MEMORY', 'INDEXEDDB', 'LOCALSTORAGE'] as const)(
    'enforces strict item validation before the %s driver',
    async (driverKey) => {
      const instance = localspace.createInstance({
        name: uniqueName(`strict-${driverKey.toLowerCase()}`),
        storeName: 'store',
        strictValues: true,
      });
      await instance.setDriver([instance[driverKey]]);
      await instance.ready();
      await instance.clear();

      await expect(instance.setItem('date', new Date())).rejects.toMatchObject({
        code: 'SERIALIZATION_FAILED',
        details: { operation: 'setItem', key: 'date', valueType: 'Date' },
      });
      await expect(instance.keys()).resolves.toEqual([]);
    }
  );

  it('validates a complete batch before writing any entry', async () => {
    const instance = await createMemoryInstance({ strictValues: true });

    await expect(
      instance.setItems([
        { key: 'valid', value: { count: 1 } },
        { key: 'invalid', value: new Set([1]) },
      ])
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        operation: 'setItems',
        key: 'invalid',
        valueType: 'Set',
      },
    });
    await expect(instance.keys()).resolves.toEqual([]);
  });

  it('validates transaction-scope writes and lets the driver roll back', async () => {
    const instance = await createMemoryInstance({ strictValues: true });

    await expect(
      instance.runTransaction('readwrite', async (tx) => {
        await tx.set('first', 1);
        await tx.set('invalid', undefined);
      })
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        operation: 'runTransaction',
        key: 'invalid',
        valuePath: '$',
        valueType: 'undefined',
      },
    });
    await expect(instance.keys()).resolves.toEqual([]);
  });

  it('wraps IndexedDB transaction scopes with the same strict validator', async () => {
    const instance = localspace.createInstance({
      name: uniqueName('strict-indexeddb-transaction'),
      storeName: 'store',
      strictValues: true,
    });
    await instance.setDriver([instance.INDEXEDDB]);
    await instance.ready();
    await instance.clear();

    await expect(
      instance.runTransaction('readwrite', async (tx) => {
        await tx.set('first', 1);
        await tx.set('invalid', new Map([['key', 'value']]));
      })
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        operation: 'runTransaction',
        key: 'invalid',
        valueType: 'Map',
      },
    });
    await expect(instance.keys()).resolves.toEqual([]);
  });

  it('does not invoke accessors while diagnosing values', async () => {
    const getter = vi.fn(() => 'secret');
    const value = {} as Record<string, unknown>;
    Object.defineProperty(value, 'secret', {
      enumerable: true,
      get: getter,
    });
    const instance = await createMemoryInstance({ strictValues: true });

    await expect(instance.setItem('accessor', value)).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        valuePath: '$.secret',
        valueReason: 'accessor properties are not supported',
      },
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['non-finite number', Number.NaN, 'numbers must be finite'],
    ['sparse array', Array(1), 'sparse arrays are not supported'],
    ['scalar bigint', 1n, 'bigint values are not supported'],
    [
      'class instance',
      new (class Value {})(),
      'only plain objects are supported',
    ],
  ])('identifies %s deterministically', (_name, value, reason) => {
    expect(inspectStorageValue(value)).toMatchObject({ reason });
  });

  it('rejects cycles with the failing path', () => {
    const value: { child?: unknown } = {};
    value.child = value;

    expect(inspectStorageValue(value)).toEqual({
      path: '$.child',
      reason: 'cyclic references are not supported',
      valueType: 'Object',
    });
  });

  it('validates strictValues configuration before applying it', () => {
    expect(() => new LocalSpace({ strictValues: 'yes' } as never)).toThrow();

    const instance = localspace.createInstance();
    const result = instance.config({ strictValues: 1 } as never);
    expect(result).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { configKey: 'strictValues' },
    });
    expect(instance.config('strictValues')).toBeUndefined();
  });
});
