import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, { compressionPlugin, LocalSpace } from '../src';
import { LocalSpaceError } from '../src/errors';
import type { Driver } from '../src/types';

const createFailingDriver = (
  name: string,
  initializationError: Error
): Driver => ({
  _driver: name,
  _support: true,
  _initStorage: async () => {
    throw initializationError;
  },
  iterate: async () => undefined as never,
  getItem: async () => null,
  setItem: async (_key, value) => value,
  removeItem: async () => undefined,
  clear: async () => undefined,
  length: async () => 0,
  key: async () => null,
  keys: async () => [],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stable error contracts', () => {
  it('retains every driver initialization failure', async () => {
    const firstName = `failing-first-${Math.random().toString(36).slice(2)}`;
    const secondName = `failing-second-${Math.random().toString(36).slice(2)}`;
    const firstError = new DOMException(
      'browser-specific initialization message',
      'InvalidStateError'
    );
    const secondError = new Error('adapter initialization failed');
    const instance = new LocalSpace();
    await instance.defineDriver(createFailingDriver(firstName, firstError));
    await instance.defineDriver(createFailingDriver(secondName, secondError));
    await instance.setDriver([firstName, secondName]);

    const error = await instance.ready().catch((cause) => cause);
    const repeatedReadyError = await instance.ready().catch((cause) => cause);
    const operationError = await instance
      .getItem('key')
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(LocalSpaceError);
    expect(error).toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      message: 'No available storage method found.',
      details: {
        attemptedDrivers: [firstName, secondName],
        driverErrors: [
          {
            driver: firstName,
            name: 'InvalidStateError',
            message: 'browser-specific initialization message',
          },
          {
            driver: secondName,
            name: 'Error',
            message: 'adapter initialization failed',
          },
        ],
      },
      cause: [firstError, secondError],
    });
    expect(repeatedReadyError).toBe(error);
    expect(operationError).toBe(error);
  });

  it('cleans up synchronous driver initialization failures', async () => {
    const driverName = `failing-sync-${Math.random().toString(36).slice(2)}`;
    const initializationError = new Error('synchronous initialization failed');
    const cleanupError = new Error('cleanup also failed');
    const closeStorage = vi.fn((): Promise<void> => {
      throw cleanupError;
    });
    const driver: Driver = {
      ...createFailingDriver(driverName, initializationError),
      _initStorage: () => {
        throw initializationError;
      },
      _closeStorage: closeStorage,
    };
    const instance = new LocalSpace();
    await instance.defineDriver(driver);
    await instance.setDriver([driverName]);

    const error = await instance.ready().catch((cause) => cause);

    expect(closeStorage).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      details: {
        attemptedDrivers: [driverName],
        driverErrors: [
          {
            driver: driverName,
            name: 'Error',
            message: 'synchronous initialization failed',
          },
        ],
      },
      cause: [initializationError],
    });

    await instance.close();
    expect(closeStorage).toHaveBeenCalledTimes(1);
  });

  it('maps IndexedDB quota failures to QUOTA_EXCEEDED with a stable message', async () => {
    const store = localspace.createInstance({
      name: `indexeddb-quota-${Math.random().toString(36).slice(2)}`,
      storeName: 'store',
      prewarmTransactions: false,
    });
    await store.setDriver([store.INDEXEDDB]);
    await store.ready();
    const quotaError = new DOMException(
      'engine-specific quota wording',
      'QuotaExceededError'
    );
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw quotaError;
    });

    const error = await store.setItem('key', 'value').catch((cause) => cause);

    expect(error).toBeInstanceOf(LocalSpaceError);
    expect(error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: 'IndexedDB quota exceeded during setItem.',
      details: {
        driver: store.INDEXEDDB,
        operation: 'setItem',
        key: 'key',
        causeName: 'QuotaExceededError',
        causeMessage: 'engine-specific quota wording',
      },
      cause: quotaError,
    });
    await store.dropInstance();
  });

  it('does not expose IndexedDB DOMException wording as the public message', async () => {
    const store = localspace.createInstance({
      name: `indexeddb-error-${Math.random().toString(36).slice(2)}`,
      storeName: 'store',
      prewarmTransactions: false,
    });
    await store.setDriver([store.INDEXEDDB]);
    await store.ready();
    const dataError = new DOMException('engine-specific wording', 'DataError');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw dataError;
    });

    const error = await store.setItem('key', 'value').catch((cause) => cause);

    expect(error).toMatchObject({
      code: 'OPERATION_FAILED',
      message: 'IndexedDB setItem failed.',
      details: {
        causeName: 'DataError',
        causeMessage: 'engine-specific wording',
      },
    });
    await store.dropInstance();
  });

  it('does not let compression serialization failures fall back to plaintext', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const name = `compression-fail-closed-${Math.random()
      .toString(36)
      .slice(2)}`;
    const store = localspace.createInstance({
      name,
      storeName: 'store',
      plugins: [compressionPlugin({ threshold: 0 })],
    });
    const raw = localspace.createInstance({ name, storeName: 'store' });
    await Promise.all([
      store.setDriver([store.MEMORY]),
      raw.setDriver([raw.MEMORY]),
    ]);
    const circular: { value: string; self?: unknown } = { value: 'plaintext' };
    circular.self = circular;

    await expect(store.setItem('secret', circular)).rejects.toBeInstanceOf(
      LocalSpaceError
    );
    await expect(raw.getItem('secret')).resolves.toBeNull();
  });
});
