import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, {
  compressionPlugin,
  encryptionPlugin,
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
  '$name transaction pipeline',
  ({ name, create }) => {
    it('applies the storage transform inside runTransaction', async () => {
      const logicalValue = name === 'compression' ? 'x'.repeat(2_000) : 'value';
      const runner = vi.fn(async (scope) => {
        await scope.set('secret', logicalValue);
        await expect(scope.get('secret')).resolves.toBe(logicalValue);
      });
      const storeName = `transaction-pipeline-${name}`;
      const store = await createMemoryStore(storeName, [create()]);
      const rawStore = await createMemoryStore(storeName, []);

      await expect(store.runTransaction('readwrite', runner)).resolves.toBe(
        undefined
      );

      expect(runner).toHaveBeenCalledTimes(1);
      await expect(store.getItem('secret')).resolves.toBe(logicalValue);
      const rawValue = await rawStore.getItem('secret');
      expect(rawValue).not.toEqual(logicalValue);
      if (name === 'ttl') {
        expect(rawValue).toMatchObject({ __ls_ttl: true });
      } else {
        expect(rawValue).toMatchObject({
          __localspace__: {
            namespace: 'localspace.plugin',
            kind: name,
            version: 1,
          },
        });
      }
    });

    it('decodes logical values before invoking iterate callbacks', async () => {
      const callback = vi.fn();
      const store = await createMemoryStore(`guard-iterate-${name}`, [
        create(),
      ]);
      await store.setItem('secret', 'plaintext');

      await expect(store.iterate(callback)).resolves.toBeUndefined();

      expect(callback).toHaveBeenCalledWith('plaintext', 'secret', 1);
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

  it('retains transaction behavior when a built-in plugin is shallow-cloned', async () => {
    const plugin = { ...ttlPlugin({ defaultTTL: 60_000 }) };
    const store = await createMemoryStore('guard-cloned-transform', [plugin]);

    await store.runTransaction('readwrite', (scope) =>
      scope.set('value', 'logical')
    );
    await expect(
      store.runTransaction('readonly', (scope) => scope.get('value'))
    ).resolves.toBe('logical');
  });
});
