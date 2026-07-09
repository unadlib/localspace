import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace from '../src';
import {
  SizeLimitExceededError,
  SizeLimitMeasurementError,
  sizeLimitPlugin,
} from '../examples/size-limit-plugin';

const createStore = async (maxBytes: number, onLimitExceeded = vi.fn()) => {
  const store = localspace.createInstance({
    name: `size-limit-example-${Math.random().toString(36).slice(2)}`,
    plugins: [sizeLimitPlugin({ maxBytes, onLimitExceeded })],
  });
  await store.setDriver(store.MEMORY);
  await store.ready();
  return { store, onLimitExceeded };
};

describe('size limit plugin example', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a single write under the default lenient plugin policy', async () => {
    const { store, onLimitExceeded } = await createStore(60);

    await store.setItem('first', 'a'.repeat(20));
    await expect(
      store.setItem('second', 'b'.repeat(50))
    ).rejects.toBeInstanceOf(SizeLimitExceededError);

    expect(onLimitExceeded).toHaveBeenCalledOnce();
    expect(await store.getItem('second')).toBeNull();
  });

  it('still rejects the write when the limit callback fails', async () => {
    const callbackFailure = new Error('notification failed');
    const onLimitExceeded = vi.fn(async () => {
      throw callbackFailure;
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { store } = await createStore(60, onLimitExceeded);

    await store.setItem('first', 'a'.repeat(20));
    await expect(
      store.setItem('second', 'b'.repeat(50))
    ).rejects.toBeInstanceOf(SizeLimitExceededError);

    expect(consoleError).toHaveBeenCalledWith(
      '[localspace example] size limit notification handler failed',
      callbackFailure
    );
    expect(await store.getItem('second')).toBeNull();
  });

  it('rejects values whose serialized size cannot be measured', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { store } = await createStore(1_000);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    await expect(store.setItem('cyclic', cyclic)).rejects.toBeInstanceOf(
      SizeLimitMeasurementError
    );

    expect(consoleError).toHaveBeenCalled();
    expect(await store.getItem('cyclic')).toBeNull();
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
