import { describe, expect, it } from 'vitest';
import localspace, { encryptionPlugin } from '../src';
import { getRawMemoryValue, setRawMemoryValue } from './utils/raw-memory';

const KEY = '0123456789abcdef0123456789abcdef';

const createStore = async (
  name: string,
  options: { bindStorageKey?: boolean; storeName?: string } = {}
) => {
  const config = { name, storeName: options.storeName ?? 'secure' };
  const store = localspace.createInstance({
    ...config,
    plugins: [
      encryptionPlugin({ key: KEY, bindStorageKey: options.bindStorageKey }),
    ],
  });
  await store.setDriver([store.MEMORY]);
  return { store, config };
};

describe('encryption storage key binding', () => {
  it('rejects ciphertext moved to another key', async () => {
    const { store, config } = await createStore('bound-keys', {
      bindStorageKey: true,
    });
    await store.setItem('a', 'secret-a');
    await store.setItem('b', 'secret-b');
    await expect(store.getItem('a')).resolves.toBe('secret-a');
    await expect(store.getItems(['a', 'b'])).resolves.toEqual([
      { key: 'a', value: 'secret-a' },
      { key: 'b', value: 'secret-b' },
    ]);

    await setRawMemoryValue(config, 'b', await getRawMemoryValue(config, 'a'));
    await expect(store.getItem('b')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
  });

  it('rejects ciphertext moved to another store', async () => {
    const source = await createStore('bound-stores', { bindStorageKey: true });
    const target = await createStore('bound-stores', {
      bindStorageKey: true,
      storeName: 'other',
    });
    await source.store.setItem('a', 'secret-a');

    await setRawMemoryValue(
      target.config,
      'a',
      await getRawMemoryValue(source.config, 'a')
    );
    await expect(target.store.getItem('a')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
  });

  it('keeps unbound values readable after enabling binding', async () => {
    const unbound = await createStore('bound-upgrade');
    await unbound.store.setItem('a', 'legacy');

    const bound = await createStore('bound-upgrade', { bindStorageKey: true });
    await expect(bound.store.getItem('a')).resolves.toBe('legacy');
    await bound.store.setItem('a', 'rewritten');
    await expect(bound.store.getItem('a')).resolves.toBe('rewritten');
    await expect(unbound.store.getItem('a')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
  });

  it('rejects conflicting additional data', () => {
    expect(() =>
      encryptionPlugin({
        key: KEY,
        bindStorageKey: true,
        algorithm: { name: 'AES-GCM', additionalData: new Uint8Array([1]) },
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
