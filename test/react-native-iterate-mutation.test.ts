import { describe, expect, it } from 'vitest';
import localspace from '../src/index';
import { createReactNativeInstance } from '../src/react-native';
import type { ReactNativeAsyncStorage } from '../src/types';

const createAsyncStorage = (): ReactNativeAsyncStorage => {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
    getAllKeys: async () => Array.from(data.keys()),
  };
};

describe('React Native iterate with concurrent removal', () => {
  it('skips keys removed before they are reached', async () => {
    const store = await createReactNativeInstance(localspace, {
      name: 'rn-iterate-removal',
      reactNativeAsyncStorage: createAsyncStorage(),
    });
    for (const key of ['a', 'b', 'c']) {
      await store.setItem(key, key);
    }

    const visited: Array<[string, unknown]> = [];
    await store.iterate(async (value, key) => {
      visited.push([key, value]);
      if (visited.length === 1) {
        await store.removeItems(['a', 'b', 'c'].filter((k) => k !== key));
      }
    });

    expect(visited).toEqual([[visited[0][0], visited[0][0]]]);
  });
});
