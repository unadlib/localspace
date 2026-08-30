import { describe, expect, it, vi } from 'vitest';
import { LocalSpace, type LocalSpacePlugin } from '../src';
import { LocalSpaceError } from '../src/errors';

describe('immutable configuration', () => {
  it.each([
    ['version', 'invalid'],
    ['version', Number.NaN],
    ['version', 0],
    ['version', 1.5],
    ['maxBatchSize', Number.NaN],
    ['maxBatchSize', Number.POSITIVE_INFINITY],
    ['maxBatchSize', -1],
    ['maxBatchSize', 1.5],
    ['strictValues', 'yes'],
  ])('rejects invalid constructor option %s=%s', (key, value) => {
    expect(() => new LocalSpace({ [key]: value } as never)).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'INVALID_CONFIG',
        details: expect.objectContaining({ configKey: key }),
      })
    );
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

  it('rejects the removed size option at runtime', () => {
    expect(() => new LocalSpace({ size: 4_980_736 } as never)).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'INVALID_CONFIG',
        details: expect.objectContaining({
          configKey: 'size',
          reason: 'removed-option',
        }),
      })
    );
  });

  it('accepts supported finite operational limits', () => {
    const instance = new LocalSpace({ version: 2, maxBatchSize: 50 });

    expect(instance.config('version')).toBe(2);
    expect(instance.config('maxBatchSize')).toBe(50);
  });

  it('does not expose internal IndexedDB tuning state in config snapshots', () => {
    const instance = new LocalSpace({
      prewarmTransactions: false,
      connectionIdleMs: 10,
      maxConcurrentTransactions: 1,
    } as never);
    const snapshot = instance.config() as Record<string, unknown>;

    expect(snapshot).not.toHaveProperty('prewarmTransactions');
    expect(snapshot).not.toHaveProperty('connectionIdleMs');
    expect(snapshot).not.toHaveProperty('maxConcurrentTransactions');
  });

  it('detaches and deeply freezes every nested public config value', () => {
    const drivers = ['memoryStorageWrapper'];
    const bucket = { name: 'app-bucket', durability: 'strict' as const };
    const adapter = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
    };
    const originalGetItem = adapter.getItem;
    const instance = new LocalSpace({
      driver: drivers,
      bucket,
      reactNativeAsyncStorage: adapter,
    });

    drivers.push('changed');
    bucket.name = 'changed';
    adapter.getItem = vi.fn(async () => 'changed');

    const snapshot = instance.config();
    const adapterSnapshot = snapshot.reactNativeAsyncStorage!;

    expect(snapshot.driver).toEqual(['memoryStorageWrapper']);
    expect(snapshot.bucket?.name).toBe('app-bucket');
    expect(adapterSnapshot.getItem).not.toBe(adapter.getItem);
    expect(adapterSnapshot.getItem).not.toBe(originalGetItem);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.driver)).toBe(true);
    expect(Object.isFrozen(snapshot.bucket)).toBe(true);
    expect(Object.isFrozen(adapterSnapshot)).toBe(true);
    expect(() => {
      (snapshot as { name?: string }).name = 'mutated';
    }).toThrow(TypeError);
    expect(instance.config('name')).toBe('localforage');
  });

  it('throws when JavaScript callers use the removed config setter', () => {
    const instance = new LocalSpace({ name: 'original' });

    expect(() =>
      (instance.config as unknown as (options: object) => unknown)({
        name: 'changed',
      })
    ).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'INVALID_ARGUMENT',
        details: expect.objectContaining({
          operation: 'config',
          reason: 'setter-removed',
        }),
      })
    );
    expect(instance.config('name')).toBe('original');
  });
});

describe('pre-ready plugin registration', () => {
  const observer = (name: string, beforeSet = vi.fn()): LocalSpacePlugin => ({
    name,
    beforeSet: (_key, value) => {
      beforeSet();
      return value;
    },
  });

  it('allows use() before readiness and locks it synchronously on ready()', async () => {
    const instance = new LocalSpace({ driver: 'memoryStorageWrapper' });
    instance.use(observer('early'));

    const readiness = instance.ready();
    expect(() => instance.use(observer('late'))).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'CONFIG_LOCKED',
        details: expect.objectContaining({
          operation: 'use',
          reason: 'instance-started',
        }),
      })
    );

    await readiness;
    await instance.close();
  });

  it('locks use() synchronously when a storage operation starts', async () => {
    const instance = new LocalSpace({ driver: 'memoryStorageWrapper' });
    const write = instance.setItem('key', 'value');

    expect(() => instance.use(observer('late'))).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'CONFIG_LOCKED',
        details: expect.objectContaining({ operation: 'use' }),
      })
    );

    await write;
    await instance.close();
  });

  it('rejects duplicate plugin names atomically', async () => {
    const duplicate = observer('duplicate');
    expect(
      () => new LocalSpace({ plugins: [duplicate, observer('duplicate')] })
    ).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'INVALID_CONFIG',
        details: expect.objectContaining({
          configKey: 'plugins',
          reason: 'duplicate-plugin',
        }),
      })
    );

    const afterSet = vi.fn();
    const instance = new LocalSpace({
      driver: 'memoryStorageWrapper',
      plugins: [duplicate],
    });
    expect(() =>
      instance.use([
        { name: 'would-be-partial', afterSet },
        observer('duplicate'),
      ])
    ).toThrowError(
      expect.objectContaining<Partial<LocalSpaceError>>({
        code: 'INVALID_CONFIG',
      })
    );

    await instance.setItem('key', 'value');
    expect(afterSet).not.toHaveBeenCalled();
    await instance.close();
  });
});
