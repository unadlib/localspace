import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  memoryDriver,
  ttlPlugin,
} from '../src';
import type { LocalSpacePlugin } from '../src';

const TRANSFORM_PLUGINS = [
  {
    name: 'encryption',
    create: () => encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
  },
  { name: 'compression', create: () => compressionPlugin({ threshold: 1 }) },
  { name: 'ttl', create: () => ttlPlugin({ defaultTTL: 60_000 }) },
];

const createMemoryStore = async (name: string, plugins: LocalSpacePlugin[]) => {
  const store = localspace.createInstance({
    name,
    storeName: 'store',
    plugins,
  });
  await store.setDriver([store.MEMORY]);
  await store.ready();
  return store;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(TRANSFORM_PLUGINS)(
  '$name plugin operation bypass guard',
  ({ name, create }) => {
    it('rejects runTransaction before invoking the driver or runner', async () => {
      const driverSpy = vi.spyOn(memoryDriver, 'runTransaction');
      const runner = vi.fn(async (scope) => {
        await scope.set('secret', 'plaintext');
      });
      const store = await createMemoryStore(`guard-transaction-${name}`, [
        create(),
      ]);

      await expect(
        store.runTransaction('readwrite', runner)
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        details: {
          operation: 'runTransaction',
          plugins: [name],
          reason: 'storage-transform-plugin-bypass',
        },
      });

      expect(driverSpy).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
    });

    it('rejects iterate before invoking the driver or callback', async () => {
      const driverSpy = vi.spyOn(memoryDriver, 'iterate');
      const callback = vi.fn();
      const store = await createMemoryStore(`guard-iterate-${name}`, [
        create(),
      ]);

      await expect(store.iterate(callback)).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        details: {
          operation: 'iterate',
          plugins: [name],
          reason: 'storage-transform-plugin-bypass',
        },
      });

      expect(driverSpy).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
    });
  }
);

describe('plugin operation bypass guard scope', () => {
  it('does not block observation-only custom plugins', async () => {
    const store = await createMemoryStore('guard-custom-observer', [
      { name: 'observer', afterSet: vi.fn() },
    ]);

    await store.setItem('value', 1);
    await expect(
      store.runTransaction('readonly', (scope) => scope.get('value'))
    ).resolves.toBe(1);

    const values: number[] = [];
    await store.iterate<number, void>((value) => {
      values.push(value);
    });
    expect(values).toEqual([1]);
  });

  it('does not block a disabled built-in transform plugin', async () => {
    const plugin = ttlPlugin({ defaultTTL: 60_000 });
    plugin.enabled = false;
    const store = await createMemoryStore('guard-disabled-transform', [plugin]);

    await store.setItem('value', 1);
    await expect(
      store.runTransaction('readonly', (scope) => scope.get('value'))
    ).resolves.toBe(1);

    const callback = vi.fn();
    await expect(store.iterate(callback)).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledWith(1, 'value', 1);
  });

  it('does not infer built-in capabilities from custom plugin names', async () => {
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const afterSet = vi.fn();
    const store = await createMemoryStore('guard-custom-name-collisions', [
      { name: 'encryption' },
      { name: 'compression' },
      { name: 'ttl', afterSet },
    ]);

    await store.setItem('value', 1);
    await expect(
      store.runTransaction('readonly', (scope) => scope.get('value'))
    ).resolves.toBe(1);

    const values: number[] = [];
    await store.iterate<number, void>((value) => {
      values.push(value);
    });
    expect(values).toEqual([1]);
    expect(afterSet).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it('retains the guard when a built-in plugin is shallow-cloned', async () => {
    const plugin = { ...ttlPlugin({ defaultTTL: 60_000 }) };
    const store = await createMemoryStore('guard-cloned-transform', [plugin]);

    await expect(
      store.runTransaction('readonly', (scope) => scope.get('value'))
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: { plugins: ['ttl'] },
    });
  });
});
