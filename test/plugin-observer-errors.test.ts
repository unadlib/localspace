import { describe, expect, it, vi } from 'vitest';
import localspace, {
  type LocalSpacePlugin,
  type PluginErrorInfo,
} from '../src';

const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('settled plugin observer failures', () => {
  it('reports after-hook failures without replacing successful outcomes', async () => {
    const reported: PluginErrorInfo[] = [];
    const fail = (hook: string): never => {
      throw new Error(`${hook} failed`);
    };
    const plugin: LocalSpacePlugin = {
      name: 'failing-after-observers',
      onError: (_error, info) => {
        reported.push(info);
      },
      afterSet: () => fail('afterSet'),
      afterSetItems: () => fail('afterSetItems'),
      afterRemove: () => fail('afterRemove'),
      afterRemoveItems: () => fail('afterRemoveItems'),
      afterIterate: () => fail('afterIterate'),
      afterKeys: () => fail('afterKeys'),
      afterKey: () => fail('afterKey'),
      afterLength: () => fail('afterLength'),
      afterClear: () => fail('afterClear'),
      afterDropInstance: () => fail('afterDropInstance'),
      afterRunTransaction: () => fail('afterRunTransaction'),
    };
    const name = uniqueName('settled-observer-errors');
    const store = localspace.createInstance({
      name,
      storeName: 'store',
      driver: 'memoryStorageWrapper',
      pluginErrorPolicy: 'strict',
      plugins: [plugin],
    });

    await expect(store.setItem('a', 1)).resolves.toBe(1);
    await expect(store.keys()).resolves.toEqual(['a']);
    await expect(store.key(0)).resolves.toBe('a');
    await expect(store.length()).resolves.toBe(1);
    await expect(store.iterate(() => 'stop')).resolves.toBe('stop');
    await expect(
      store.setItems([
        { key: 'b', value: 2 },
        { key: 'c', value: 3 },
      ])
    ).resolves.toEqual([
      { key: 'b', value: 2 },
      { key: 'c', value: 3 },
    ]);
    await expect(store.removeItem('a')).resolves.toBeUndefined();
    await expect(store.removeItems(['b'])).resolves.toBeUndefined();
    await expect(
      store.runTransaction('readwrite', (scope) => scope.set('tx', true))
    ).resolves.toBe(true);
    await expect(store.getItem('tx')).resolves.toBe(true);
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.setItem('drop', true)).resolves.toBe(true);
    await expect(
      store.dropInstance({ name, storeName: 'store' })
    ).resolves.toBeUndefined();
    await expect(store.getItem('drop')).resolves.toBeNull();

    expect(
      reported.map(({ operation, stage }) => `${operation}:${stage}`)
    ).toEqual([
      'setItem:after',
      'keys:after',
      'key:after',
      'length:after',
      'iterate:after',
      'setItems:after',
      'removeItem:after',
      'removeItems:after',
      'setItem:after',
      'runTransaction:after',
      'clear:after',
      'setItem:after',
      'dropInstance:after',
    ]);
    await store.close();
  });

  it('still lets strict before observers prevent a mutation', async () => {
    const beforeClear = vi.fn(() => {
      throw new Error('beforeClear failed');
    });
    const store = localspace.createInstance({
      name: uniqueName('strict-before-observer'),
      driver: 'memoryStorageWrapper',
      pluginErrorPolicy: 'strict',
      plugins: [{ name: 'strict-before-observer', beforeClear }],
    });
    await store.setItem('preserved', true);

    await expect(store.clear()).rejects.toThrow('beforeClear failed');
    await expect(store.getItem('preserved')).resolves.toBe(true);
    expect(beforeClear).toHaveBeenCalledTimes(1);
    await store.close();
  });
});
