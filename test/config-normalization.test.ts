import { describe, expect, it } from 'vitest';
import { LocalSpace } from '../src';
import { LocalSpaceError } from '../src/errors';

describe('configuration normalization', () => {
  it('preserves the 2.0 setter namespace while leaving constructor names unchanged', async () => {
    const name = `store-name-compat-${Math.random().toString(36).slice(2)}`;
    const constructed = new LocalSpace({ storeName: 'store&name-v1' });
    const configured = new LocalSpace({ name });
    const legacyWriter = new LocalSpace({
      name,
      storeName: 'store_name_v1',
    });

    expect(configured.config({ storeName: 'store&name-v1' })).toBe(true);
    expect(constructed.config('storeName')).toBe('store&name-v1');
    expect(configured.config('storeName')).toBe('store_name_v1');

    await Promise.all([
      configured.setDriver([configured.MEMORY]),
      legacyWriter.setDriver([legacyWriter.MEMORY]),
    ]);
    await legacyWriter.setItem('persisted', '2.0-setter-data');
    await expect(configured.getItem('persisted')).resolves.toBe(
      '2.0-setter-data'
    );
    await configured.dropInstance();
  });

  it.each([
    ['version', 'invalid'],
    ['version', Number.NaN],
    ['version', 0],
    ['version', 1.5],
    ['maxBatchSize', Number.NaN],
    ['maxBatchSize', Number.POSITIVE_INFINITY],
    ['maxBatchSize', -1],
    ['maxBatchSize', 1.5],
    ['connectionIdleMs', -1],
    ['maxConcurrentTransactions', -1],
  ])('rejects invalid constructor option %s=%s', (key, value) => {
    let error: unknown;
    try {
      new LocalSpace({ [key]: value } as never);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(LocalSpaceError);
    expect(error).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { configKey: key },
    });
  });

  it.each([
    ['name', ''],
    ['name', 42],
    ['storeName', ''],
    ['storeName', 42],
  ])('rejects invalid namespace option %s=%s', (key, value) => {
    expect(() => new LocalSpace({ [key]: value } as never)).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'INVALID_CONFIG',
        details: expect.objectContaining({ configKey: key }),
      })
    );
  });

  it('returns setter validation errors without applying partial config', () => {
    const instance = new LocalSpace({ storeName: 'original' });

    const result = instance.config({
      storeName: 'changed',
      maxBatchSize: Number.NaN,
    });

    expect(result).toBeInstanceOf(LocalSpaceError);
    expect(result).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { configKey: 'maxBatchSize' },
    });
    expect(instance.config('storeName')).toBe('original');
  });

  it('accepts finite positive integer operational limits', () => {
    const instance = new LocalSpace({
      version: 2,
      maxBatchSize: 50,
      connectionIdleMs: 1_000,
      maxConcurrentTransactions: 4,
    });

    expect(instance.config('version')).toBe(2);
    expect(instance.config('maxBatchSize')).toBe(50);
    expect(instance.config('connectionIdleMs')).toBe(1_000);
    expect(instance.config('maxConcurrentTransactions')).toBe(4);
  });

  it('accepts zero as the disabled or unbounded operational limit', async () => {
    const constructed = new LocalSpace({
      maxBatchSize: 0,
      connectionIdleMs: 0,
      maxConcurrentTransactions: 0,
    });
    const configured = new LocalSpace();

    expect(
      configured.config({
        maxBatchSize: 0,
        connectionIdleMs: 0,
        maxConcurrentTransactions: 0,
      })
    ).toBe(true);

    for (const instance of [constructed, configured]) {
      expect(instance.config('maxBatchSize')).toBe(0);
      expect(instance.config('connectionIdleMs')).toBe(0);
      expect(instance.config('maxConcurrentTransactions')).toBe(0);
    }

    await configured.setDriver([configured.MEMORY]);
    await expect(
      configured.setItems([
        { key: 'first', value: 1 },
        { key: 'second', value: 2 },
      ])
    ).resolves.toEqual([
      { key: 'first', value: 1 },
      { key: 'second', value: 2 },
    ]);
    await expect(configured.getItems(['first', 'second'])).resolves.toEqual([
      { key: 'first', value: 1 },
      { key: 'second', value: 2 },
    ]);
    await configured.dropInstance();
  });

  it('clones driver arrays in both configuration paths', async () => {
    const constructorDrivers = ['memoryStorageWrapper'];
    const setterDrivers = ['memoryStorageWrapper'];
    const constructed = new LocalSpace({ driver: constructorDrivers });
    const configured = new LocalSpace();

    const setterResult = configured.config({ driver: setterDrivers });
    constructorDrivers.push('changed');
    setterDrivers.push('changed');

    expect(constructed.config('driver')).toEqual(['memoryStorageWrapper']);
    expect(configured.config('driver')).toEqual(['memoryStorageWrapper']);
    expect(setterResult).toBeInstanceOf(Promise);
    await setterResult;
  });
});
