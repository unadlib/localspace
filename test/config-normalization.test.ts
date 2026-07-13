import { describe, expect, it } from 'vitest';
import { LocalSpace } from '../src';
import { LocalSpaceError } from '../src/errors';

describe('configuration normalization', () => {
  it('preserves storeName identically in the constructor and setter', () => {
    const constructed = new LocalSpace({ storeName: 'store&name-v1' });
    const configured = new LocalSpace();

    expect(configured.config({ storeName: 'store&name-v1' })).toBe(true);
    expect(constructed.config('storeName')).toBe('store&name-v1');
    expect(configured.config('storeName')).toBe('store&name-v1');
  });

  it.each([
    ['version', 'invalid'],
    ['version', Number.NaN],
    ['version', 0],
    ['version', 1.5],
    ['maxBatchSize', Number.NaN],
    ['maxBatchSize', Number.POSITIVE_INFINITY],
    ['maxBatchSize', 0],
    ['maxBatchSize', 1.5],
    ['connectionIdleMs', -1],
    ['maxConcurrentTransactions', 0],
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
