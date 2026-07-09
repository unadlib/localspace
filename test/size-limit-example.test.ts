import { describe, expect, it, vi } from 'vitest';
import localspace from '../src';
import {
  SizeLimitExceededError,
  sizeLimitPlugin,
} from '../examples/size-limit-plugin';

const createStore = async (maxBytes: number, onLimitExceeded = vi.fn()) => {
  const store = localspace.createInstance({
    name: `size-limit-example-${Math.random().toString(36).slice(2)}`,
    plugins: [sizeLimitPlugin({ maxBytes, onLimitExceeded })],
    pluginErrorPolicy: 'strict',
  });
  await store.setDriver(store.MEMORY);
  await store.ready();
  return { store, onLimitExceeded };
};

describe('size limit plugin example', () => {
  it('rejects a single write that would exceed the application limit', async () => {
    const { store, onLimitExceeded } = await createStore(60);

    await store.setItem('first', 'a'.repeat(20));
    await expect(
      store.setItem('second', 'b'.repeat(50))
    ).rejects.toBeInstanceOf(SizeLimitExceededError);

    expect(onLimitExceeded).toHaveBeenCalledOnce();
    expect(await store.getItem('second')).toBeNull();
  });

  it('checks the final value for duplicate keys in a batch', async () => {
    const { store } = await createStore(60);

    await store.setItems([
      { key: 'same', value: 'a'.repeat(100) },
      { key: 'same', value: 'b'.repeat(20) },
    ]);

    expect(await store.getItem('same')).toBe('b'.repeat(20));
  });

  it('rescans storage after clear instead of relying on stale metadata', async () => {
    const { store } = await createStore(60);

    await store.setItem('old', 'a'.repeat(40));
    await store.clear();
    await store.setItem('new', 'b'.repeat(40));

    expect(await store.getItem('new')).toBe('b'.repeat(40));
  });
});
