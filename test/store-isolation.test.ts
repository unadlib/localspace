import { beforeEach, describe, expect, it } from 'vitest';
import localspace from '../src/index';
import { LocalSpace } from '../src/localspace';
import { createReactNativeInstance } from '../src/react-native';
import type { ReactNativeAsyncStorage } from '../src/types';

class MemoryAsyncStorage implements ReactNativeAsyncStorage {
  readonly data = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.data.delete(key);
  }

  async getAllKeys(): Promise<string[]> {
    return Array.from(this.data.keys());
  }
}

describe('localStorage store isolation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const create = (storeName?: string) =>
    new LocalSpace({
      name: 'isolation',
      driver: 'localStorageWrapper',
      ...(storeName ? { storeName } : {}),
    });

  it('keeps named stores out of default-store scans', async () => {
    const defaults = create();
    const users = create('users');
    await defaults.setItem('a', 1);
    await users.setItem('u1', 'alice');

    expect(await defaults.keys()).toEqual(['a']);
    expect(await defaults.length()).toBe(1);
    expect(await defaults.key(0)).toBe('a');
    const visited: string[] = [];
    await defaults.iterate((_value, key) => {
      visited.push(key);
    });
    expect(visited).toEqual(['a']);

    await defaults.clear();
    expect(await users.getItem('u1')).toBe('alice');
    expect(await users.keys()).toEqual(['u1']);
  });

  it('keeps named stores when dropping the default store', async () => {
    const defaults = create();
    const users = create('users');
    await defaults.setItem('a', 1);
    await users.setItem('u1', 'alice');

    await defaults.dropInstance();

    expect(await defaults.keys()).toEqual([]);
    expect(await users.getItem('u1')).toBe('alice');
  });

  it('re-registers a named store after another instance drops the registry', async () => {
    const defaults = create();
    const users = create('users');
    await users.setItem('u1', 'alice');

    await defaults.dropInstance({ name: 'isolation' });
    await users.setItem('u2', 'bob');
    await defaults.setItem('a', 1);

    expect(await defaults.keys()).toEqual(['a']);
    await defaults.clear();
    expect(await users.getItem('u2')).toBe('bob');
  });

  it('releases the registry when a store or database is dropped', async () => {
    const defaults = create();
    const users = create('users');
    await users.setItem('u1', 'alice');
    expect(localStorage.getItem('localspace:stores:isolation')).toBe(
      JSON.stringify(['users'])
    );

    await users.dropInstance({ name: 'isolation', storeName: 'users' });
    expect(localStorage.getItem('localspace:stores:isolation')).toBeNull();

    await create('orders').setItem('o1', 1);
    await defaults.dropInstance({ name: 'isolation' });
    expect(localStorage.getItem('localspace:stores:isolation')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

describe('React Native store isolation', () => {
  it('registers named stores whose first writes run concurrently', async () => {
    const asyncStorage = new MemoryAsyncStorage();
    // Yield between registry reads and writes so the updates interleave.
    const getItem = asyncStorage.getItem.bind(asyncStorage);
    asyncStorage.getItem = async (key) => {
      const value = await getItem(key);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return value;
    };
    const [defaults, users, orders] = await Promise.all(
      [undefined, 'users', 'orders'].map((storeName) =>
        createReactNativeInstance(localspace, {
          name: 'rn-concurrent-registration',
          ...(storeName ? { storeName } : {}),
          reactNativeAsyncStorage: asyncStorage,
        })
      )
    );

    await Promise.all([users.setItem('u1', 'alice'), orders.setItem('o1', 1)]);
    await defaults.setItem('a', 1);

    expect(await defaults.keys()).toEqual(['a']);
    expect(
      JSON.parse(
        asyncStorage.data.get('localspace:stores:rn-concurrent-registration')!
      ).sort()
    ).toEqual(['orders', 'users']);
  });

  it('keeps named stores out of default-store scans', async () => {
    const asyncStorage = new MemoryAsyncStorage();
    const defaults = await createReactNativeInstance(localspace, {
      name: 'rn-isolation',
      reactNativeAsyncStorage: asyncStorage,
    });
    const users = await createReactNativeInstance(localspace, {
      name: 'rn-isolation',
      storeName: 'users',
      reactNativeAsyncStorage: asyncStorage,
    });
    await defaults.setItem('a', 1);
    await users.setItem('u1', 'alice');

    expect(await defaults.keys()).toEqual(['a']);
    await defaults.clear();
    expect(await users.getItem('u1')).toBe('alice');

    await defaults.dropInstance();
    expect(await users.getItem('u1')).toBe('alice');

    await users.dropInstance({ name: 'rn-isolation', storeName: 'users' });
    expect(Array.from(asyncStorage.data.keys())).toEqual([]);
  });

  it('re-registers a named store after another instance drops the registry', async () => {
    const asyncStorage = new MemoryAsyncStorage();
    const create = (storeName?: string) =>
      createReactNativeInstance(localspace, {
        name: 'rn-reregister',
        ...(storeName ? { storeName } : {}),
        reactNativeAsyncStorage: asyncStorage,
      });
    const defaults = await create();
    const users = await create('users');
    await users.setItem('u1', 'alice');

    await defaults.dropInstance({ name: 'rn-reregister' });
    await users.setItem('u2', 'bob');
    await defaults.setItem('a', 1);

    expect(await defaults.keys()).toEqual(['a']);
    await defaults.clear();
    expect(await users.getItem('u2')).toBe('bob');
  });
});
