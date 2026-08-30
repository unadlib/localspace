import { describe, expect, it, vi } from 'vitest';
import localspace, {
  LocalSpace,
  type LocalSpaceInstance,
  type LocalSpaceOptions,
  type StorageValue,
} from '../src';
import { inspectStorageValue } from '../src/core/storage-value';
import { canonicalizeStorageValue } from '../src/core/stored-record';

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

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

describe('3.0 StorageValue contract', () => {
  it('exports, canonicalizes, and copies the supported recursive value type', async () => {
    const nullPrototype = Object.create(null) as Record<string, StorageValue>;
    nullPrototype.enabled = true;
    const binary = new Uint16Array([1, 2]);
    const unordered = { z: 1, a: 2 };
    const values: StorageValue[] = [
      null,
      false,
      0,
      -0,
      'value',
      [1, { nested: 'value' }],
      nullPrototype,
      new ArrayBuffer(4),
      binary,
      unordered,
    ];
    if (typeof BigInt64Array !== 'undefined') {
      values.push(new BigInt64Array([1n]));
    }

    const instance = await createMemoryInstance();
    await expect(
      instance.setItems(
        values.map((value, index) => ({ key: String(index), value }))
      )
    ).resolves.toHaveLength(values.length);

    binary[0] = 99;
    unordered.a = 99;
    await expect(instance.getItem<number>('3')).resolves.toSatisfy(
      (value) => value === 0 && !Object.is(value, -0)
    );
    const storedBinary = await instance.getItem<Uint16Array>('8');
    expect(storedBinary?.constructor.name).toBe('Uint16Array');
    expect(Array.from(storedBinary ?? [])).toEqual([1, 2]);
    const storedObject = await instance.getItem<Record<string, number>>('9');
    expect(storedObject).toEqual({ a: 2, z: 1 });
    expect(Object.keys(storedObject ?? {})).toEqual(['a', 'z']);
    expect(
      Object.getPrototypeOf(canonicalizeStorageValue(nullPrototype))
    ).toBeNull();
  });

  it('rejects unsupported values by default before plugin initialization or storage', async () => {
    const onInit = vi.fn();
    const name = uniqueName('invalid-item');
    const instance = await createMemoryInstance({
      name,
      plugins: [{ name: 'observer', onInit }],
    });

    await expect(
      instance.setItem('profile', {
        nested: { lastSeen: new Date('2026-08-31T00:00:00.000Z') },
      } as never)
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        operation: 'setItem',
        key: 'profile',
        valueSource: 'application',
        valuePath: '$.nested.lastSeen',
        valueType: 'Date',
      },
    });

    expect(onInit).not.toHaveBeenCalled();

    const reader = await createMemoryInstance({ name }, false);
    await expect(reader.getItem('profile')).resolves.toBeNull();
  });

  it.each(['MEMORY', 'INDEXEDDB', 'LOCALSTORAGE'] as const)(
    'enforces item validation before the %s driver',
    async (driverKey) => {
      const instance = localspace.createInstance({
        name: uniqueName(`strict-${driverKey.toLowerCase()}`),
        storeName: 'store',
      });
      await instance.setDriver([instance[driverKey]]);
      await instance.ready();
      await instance.clear();

      await expect(
        instance.setItem('date', new Date() as never)
      ).rejects.toMatchObject({
        code: 'SERIALIZATION_FAILED',
        details: { operation: 'setItem', key: 'date', valueType: 'Date' },
      });
      await expect(instance.keys()).resolves.toEqual([]);
    }
  );

  it('validates a complete batch before writing or initializing plugins', async () => {
    const onInit = vi.fn();
    const instance = await createMemoryInstance({
      plugins: [{ name: 'observer', onInit }],
    });

    await expect(
      instance.setItems([
        { key: 'valid', value: { count: 1 } },
        { key: 'invalid', value: new Set([1]) },
      ] as never)
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        operation: 'setItems',
        key: 'invalid',
        valueType: 'Set',
      },
    });
    expect(onInit).not.toHaveBeenCalled();
    await expect(instance.keys()).resolves.toEqual([]);
  });

  it('rejects unsupported plugin output before the driver side effect', async () => {
    const instance = await createMemoryInstance({
      plugins: [
        {
          name: 'invalid-output',
          priority: 10,
          beforeSet: () => new Date() as never,
        },
        {
          name: 'would-mask-invalid-output',
          beforeSet: () => 'masked',
        },
      ],
    });

    await expect(instance.setItem('key', 'value')).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        operation: 'setItem',
        key: 'key',
        valueSource: 'plugin-output',
        plugin: 'invalid-output',
        valueType: 'Date',
      },
    });
    await expect(instance.keys()).resolves.toEqual([]);
  });

  it('rejects unsupported batch-plugin output before the driver side effect', async () => {
    const instance = await createMemoryInstance({
      plugins: [
        {
          name: 'invalid-batch-output',
          priority: 10,
          beforeSetItems: () =>
            [{ key: 'key', value: new Map([['invalid', true]]) }] as never,
        },
        {
          name: 'would-mask-invalid-batch-output',
          beforeSetItems: () => [{ key: 'key', value: 'masked' }],
        },
      ],
    });

    await expect(
      instance.setItems([{ key: 'key', value: 'value' }])
    ).rejects.toMatchObject({
      code: 'SERIALIZATION_FAILED',
      details: {
        operation: 'setItems',
        key: 'key',
        valueSource: 'plugin-output',
        plugin: 'invalid-batch-output',
        valueType: 'Map',
      },
    });
    await expect(instance.keys()).resolves.toEqual([]);
  });

  it('validates transaction-scope writes and lets the driver roll back', async () => {
    const instance = await createMemoryInstance();

    await expect(
      instance.runTransaction('readwrite', async (tx) => {
        await tx.set('first', 1);
        await tx.set('invalid', undefined as never);
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

  it('wraps IndexedDB transaction scopes with the same validator', async () => {
    const instance = localspace.createInstance({
      name: uniqueName('strict-indexeddb-transaction'),
      storeName: 'store',
    });
    await instance.setDriver([instance.INDEXEDDB]);
    await instance.ready();
    await instance.clear();

    await expect(
      instance.runTransaction('readwrite', async (tx) => {
        await tx.set('first', 1);
        await tx.set('invalid', new Map([['key', 'value']]) as never);
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
    const instance = await createMemoryInstance();

    await expect(
      instance.setItem('accessor', value as never)
    ).rejects.toMatchObject({
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

  it('rejects typed arrays backed by shared memory', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;

    expect(
      inspectStorageValue(new Uint8Array(new SharedArrayBuffer(4)))
    ).toEqual({
      path: '$',
      reason: 'binary views backed by shared memory are not supported',
      valueType: 'Uint8Array',
    });
  });

  it('rejects objects that forge a supported binary tag', () => {
    const forged = {
      [Symbol.toStringTag]: 'Uint8Array',
      byteLength: 4,
      buffer: new ArrayBuffer(4),
    };

    expect(inspectStorageValue(forged)).not.toBeNull();
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

  it('rejects the removed strictValues option at construction', () => {
    expect(() => new LocalSpace({ strictValues: true } as never)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        details: { configKey: 'strictValues', reason: 'removed-option' },
      })
    );
  });
});
