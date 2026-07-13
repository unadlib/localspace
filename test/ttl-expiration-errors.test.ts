import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, { ttlPlugin } from '../src';
import { LocalSpaceError } from '../src/errors';

const createMemoryPair = async (
  name: string,
  onExpire: (key: string, value: unknown) => Promise<void> | void,
  pluginErrorPolicy: 'strict' | 'lenient'
) => {
  const store = localspace.createInstance({
    name,
    storeName: 'ttl',
    plugins: [ttlPlugin({ defaultTTL: 10, onExpire })],
    pluginErrorPolicy,
  });
  const raw = localspace.createInstance({ name, storeName: 'ttl' });
  await Promise.all([
    store.setDriver([store.MEMORY]),
    raw.setDriver([raw.MEMORY]),
  ]);
  return { store, raw };
};

const expireAfterWrite = () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return () => {
    now = 2_000;
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TTL expiration callback errors', () => {
  it('returns null under lenient policy and never exposes the TTL envelope', async () => {
    const expire = expireAfterWrite();
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const onExpire = vi.fn(() => {
      throw new Error('notification failed');
    });
    const { store, raw } = await createMemoryPair(
      'ttl-expire-lenient',
      onExpire,
      'lenient'
    );
    await store.setItem('session', 'secret');
    expire();

    await expect(store.getItem('session')).resolves.toBeNull();
    expect(onExpire).toHaveBeenCalledWith('session', 'secret');
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('TTL onExpire callback failed'),
      expect.any(LocalSpaceError)
    );
    await expect(raw.getItem('session')).resolves.toBeNull();
  });

  it('removes the item before propagating a strict callback error', async () => {
    const expire = expireAfterWrite();
    const onExpire = vi.fn(() => {
      throw new Error('notification failed');
    });
    const { store, raw } = await createMemoryPair(
      'ttl-expire-strict',
      onExpire,
      'strict'
    );
    await store.setItem('session', 'secret');
    expire();

    const error = await store.getItem('session').catch((cause) => cause);
    expect(error).toBeInstanceOf(LocalSpaceError);
    expect(error).toMatchObject({
      code: 'OPERATION_FAILED',
      details: { key: 'session', operation: 'ttl.onExpire' },
    });
    expect(onExpire).toHaveBeenCalledOnce();
    await expect(raw.getItem('session')).resolves.toBeNull();
  });

  it('removes a batch before invoking callbacks and continues after lenient failures', async () => {
    const expire = expireAfterWrite();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let rawStore: Awaited<ReturnType<typeof createMemoryPair>>['raw'];
    const callbackObservations: Array<{ key: string; stored: unknown }> = [];
    const onExpire = vi.fn(async (key: string) => {
      callbackObservations.push({ key, stored: await rawStore.getItem(key) });
      throw new Error(`notification failed for ${key}`);
    });
    const { store, raw } = await createMemoryPair(
      'ttl-expire-batch-lenient',
      onExpire,
      'lenient'
    );
    rawStore = raw;
    await store.setItems([
      { key: 'first', value: 'one' },
      { key: 'second', value: 'two' },
    ]);
    expire();

    await expect(store.getItems(['first', 'second'])).resolves.toEqual([
      { key: 'first', value: null },
      { key: 'second', value: null },
    ]);
    expect(onExpire).toHaveBeenCalledTimes(2);
    expect(callbackObservations).toEqual([
      { key: 'first', stored: null },
      { key: 'second', stored: null },
    ]);
  });

  it('keeps batch entries deleted when strict callback notification fails', async () => {
    const expire = expireAfterWrite();
    const onExpire = vi.fn(() => {
      throw new Error('notification failed');
    });
    const { store, raw } = await createMemoryPair(
      'ttl-expire-batch-strict',
      onExpire,
      'strict'
    );
    await store.setItems([
      { key: 'first', value: 'one' },
      { key: 'second', value: 'two' },
    ]);
    expire();

    await expect(store.getItems(['first', 'second'])).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    await expect(raw.getItems(['first', 'second'])).resolves.toEqual([
      { key: 'first', value: null },
      { key: 'second', value: null },
    ]);
  });
});
