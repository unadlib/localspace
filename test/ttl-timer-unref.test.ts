import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSpace } from '../src/localspace';
import { ttlPlugin } from '../src/index';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TTL cleanup timer', () => {
  it('does not keep the process alive', async () => {
    const unref = vi.fn();
    const timer = { unref };
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      timer as unknown as ReturnType<typeof setInterval>
    );
    const clear = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(() => undefined);

    const store = new LocalSpace({
      name: 'ttl-timer-unref',
      driver: 'memoryStorageWrapper',
      plugins: [ttlPlugin({ defaultTTL: 1000, cleanupInterval: 60_000 })],
    });
    await store.setItem('a', 1);

    expect(unref).toHaveBeenCalledTimes(1);
    await store.close();
    expect(clear).toHaveBeenCalledWith(timer);
  });
});
