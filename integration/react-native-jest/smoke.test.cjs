const localspacePkg = require('localspace');
const { LocalSpace } = localspacePkg;
const { createReactNativeInstance } = require('localspace/react-native');
const asyncStorageModule = require('@react-native-async-storage/async-storage');
const AsyncStorage = asyncStorageModule.default ?? asyncStorageModule;

describe('localspace + react-native async storage integration smoke', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('supports create/set/get/remove flow', async () => {
    const base = new LocalSpace();
    const store = await createReactNativeInstance(base, {
      name: 'rn-it-smoke',
      storeName: 'kv',
      reactNativeAsyncStorage: AsyncStorage,
    });

    await store.setItem('token', 'abc');
    expect(await store.getItem('token')).toBe('abc');

    await store.removeItem('token');
    expect(await store.getItem('token')).toBeNull();
  });

  it('supports batch flows', async () => {
    const base = new LocalSpace();
    const store = await createReactNativeInstance(base, {
      name: 'rn-it-batch',
      storeName: 'kv',
      reactNativeAsyncStorage: AsyncStorage,
    });

    await store.setItems({
      one: 1,
      two: 2,
    });

    const result = await store.getItems(['one', 'two', 'missing']);
    expect(result).toEqual([
      { key: 'one', value: 1 },
      { key: 'two', value: 2 },
      { key: 'missing', value: null },
    ]);
  });
});
