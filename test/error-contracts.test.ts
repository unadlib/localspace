import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, {
  compressionPlugin,
  LocalSpace,
  memoryDriver,
} from '../src';
import { LocalSpaceError } from '../src/errors';
import type { Driver, LocalSpaceConfig } from '../src/types';

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
    const closeStorage = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw cleanupError;
      })
      .mockResolvedValue(undefined);
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
    expect(closeStorage).toHaveBeenCalledTimes(2);
  });

  it('retries failed initialization cleanup without repeating active cleanup', async () => {
    const failedDriverName = `failing-fallback-${Math.random()
      .toString(36)
      .slice(2)}`;
    const fallbackDriverName = `successful-fallback-${Math.random()
      .toString(36)
      .slice(2)}`;
    const initializationError = new Error('initialization failed');
    const initialCleanupError = new Error('initial cleanup failed');
    const closeRetryError = new Error('close retry failed');
    const retainedCleanupOwner = `${failedDriverName}-retained`;
    let releaseRetainedCleanup!: () => void;
    let markRetainedCleanupStarted!: () => void;
    const retainedCleanupGate = new Promise<void>((resolve) => {
      releaseRetainedCleanup = resolve;
    });
    const retainedCleanupStarted = new Promise<void>((resolve) => {
      markRetainedCleanupStarted = resolve;
    });
    const failedCleanupDbOwners: Array<string | undefined> = [];
    const failedCleanupDrivers: Array<string | null> = [];
    const failedCleanupConfiguredDrivers: Array<LocalSpaceConfig['driver']> =
      [];
    let failedInitializationReceiver: LocalSpace | undefined;
    const failedCleanupReceivers: LocalSpace[] = [];
    let failedCleanupAttempts = 0;
    const failedDriverClose = vi.fn(async function (this: LocalSpace) {
      const captureContext = () => {
        const dbInfo = (
          this as unknown as { _dbInfo: { owner?: string } | null }
        )._dbInfo;
        failedCleanupDbOwners.push(dbInfo?.owner);
        failedCleanupDrivers.push(this.driver());
        failedCleanupConfiguredDrivers.push(this.config('driver'));
        failedCleanupReceivers.push(this);
      };
      captureContext();
      failedCleanupAttempts++;
      if (failedCleanupAttempts === 1) {
        throw initialCleanupError;
      }
      if (failedCleanupAttempts === 2) {
        (this as unknown as { _dbInfo: { owner: string } })._dbInfo = {
          owner: retainedCleanupOwner,
        };
        throw closeRetryError;
      }
      markRetainedCleanupStarted();
      await retainedCleanupGate;
      captureContext();
    });
    const fallbackCleanupDbOwners: Array<string | undefined> = [];
    const fallbackCleanupDrivers: Array<string | null> = [];
    const fallbackCleanupConfiguredDrivers: Array<LocalSpaceConfig['driver']> =
      [];
    const fallbackDriverClose = vi.fn(async function (this: LocalSpace) {
      const dbInfo = (this as unknown as { _dbInfo: { owner?: string } | null })
        ._dbInfo;
      fallbackCleanupDbOwners.push(dbInfo?.owner);
      fallbackCleanupDrivers.push(this.driver());
      fallbackCleanupConfiguredDrivers.push(this.config('driver'));
    });
    const failedDriver: Driver = {
      ...createFailingDriver(failedDriverName, initializationError),
      _initStorage: async function (this: LocalSpace) {
        failedInitializationReceiver = this;
        (this as unknown as { _dbInfo: { owner: string } })._dbInfo = {
          owner: failedDriverName,
        };
        throw initializationError;
      },
      _closeStorage: failedDriverClose,
    };
    const fallbackDriver: Driver = {
      ...memoryDriver,
      _driver: fallbackDriverName,
      _support: true,
      _initStorage: async function () {
        (this as unknown as { _dbInfo: { owner: string } })._dbInfo = {
          owner: fallbackDriverName,
        };
      },
      _closeStorage: fallbackDriverClose,
    };
    const instance = new LocalSpace({
      name: `retain-failed-cleanup-${Math.random().toString(36).slice(2)}`,
    });
    await instance.defineDriver(failedDriver);
    await instance.defineDriver(fallbackDriver);
    await instance.setDriver([failedDriverName, fallbackDriverName]);

    await instance.ready();
    expect(instance.driver()).toBe(fallbackDriverName);
    expect(failedDriverClose).toHaveBeenCalledTimes(1);

    await expect(instance.close()).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      cause: closeRetryError,
      details: {
        driver: failedDriverName,
        operation: 'close',
        reason: 'driver-initialization-cleanup',
        pendingDrivers: [failedDriverName],
      },
    });
    expect(failedDriverClose).toHaveBeenCalledTimes(2);
    expect(fallbackDriverClose).toHaveBeenCalledTimes(1);

    const retryingClose = instance.close();
    await retainedCleanupStarted;
    expect(instance.driver()).toBe(fallbackDriverName);
    expect(instance.config('driver')).toBe(fallbackDriverName);
    releaseRetainedCleanup();
    await retryingClose;
    expect(failedDriverClose).toHaveBeenCalledTimes(3);
    expect(fallbackDriverClose).toHaveBeenCalledTimes(1);
    expect(failedCleanupDbOwners).toEqual([
      failedDriverName,
      failedDriverName,
      retainedCleanupOwner,
      retainedCleanupOwner,
    ]);
    expect(failedCleanupDrivers).toEqual([
      failedDriverName,
      failedDriverName,
      failedDriverName,
      failedDriverName,
    ]);
    expect(failedCleanupConfiguredDrivers).toEqual([
      failedDriverName,
      failedDriverName,
      failedDriverName,
      failedDriverName,
    ]);
    expect(fallbackCleanupDbOwners).toEqual([fallbackDriverName]);
    expect(fallbackCleanupDrivers).toEqual([fallbackDriverName]);
    expect(fallbackCleanupConfiguredDrivers).toEqual([fallbackDriverName]);
    expect(failedCleanupReceivers).toEqual([
      failedInitializationReceiver,
      failedInitializationReceiver,
      failedInitializationReceiver,
      failedInitializationReceiver,
    ]);
  });

  it('retries failed initialization cleanup before switching drivers', async () => {
    const failedDriverName = `failing-switch-${Math.random()
      .toString(36)
      .slice(2)}`;
    const fallbackDriverName = `fallback-before-switch-${Math.random()
      .toString(36)
      .slice(2)}`;
    const nextDriverName = `next-after-cleanup-${Math.random()
      .toString(36)
      .slice(2)}`;
    const initializationError = new Error('initialization failed');
    const initialCleanupError = new Error('initial cleanup failed');
    const switchRetryError = new Error('switch retry failed');
    const failedDriverClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(initialCleanupError)
      .mockRejectedValueOnce(switchRetryError)
      .mockResolvedValue(undefined);
    const fallbackDriverClose = vi.fn(async () => undefined);
    const nextDriverInit = vi.fn(memoryDriver._initStorage);
    const nextDriverClose = vi.fn(async () => undefined);
    const failedDriver: Driver = {
      ...createFailingDriver(failedDriverName, initializationError),
      _closeStorage: failedDriverClose,
    };
    const fallbackDriver: Driver = {
      ...memoryDriver,
      _driver: fallbackDriverName,
      _support: true,
      _closeStorage: fallbackDriverClose,
    };
    const nextDriver: Driver = {
      ...memoryDriver,
      _driver: nextDriverName,
      _support: true,
      _initStorage: nextDriverInit,
      _closeStorage: nextDriverClose,
    };
    const instance = new LocalSpace({
      name: `retry-cleanup-switch-${Math.random().toString(36).slice(2)}`,
    });
    await instance.defineDriver(failedDriver);
    await instance.defineDriver(fallbackDriver);
    await instance.defineDriver(nextDriver);
    await instance.setDriver([failedDriverName, fallbackDriverName]);
    await instance.ready();

    await expect(instance.setDriver([nextDriverName])).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      cause: switchRetryError,
      details: {
        driver: failedDriverName,
        operation: 'setDriver',
        reason: 'driver-initialization-cleanup',
      },
    });
    expect(instance.driver()).toBe(fallbackDriverName);
    expect(failedDriverClose).toHaveBeenCalledTimes(2);
    expect(fallbackDriverClose).not.toHaveBeenCalled();
    expect(nextDriverInit).not.toHaveBeenCalled();

    await instance.setDriver([nextDriverName]);
    await instance.ready();
    expect(instance.driver()).toBe(nextDriverName);
    expect(failedDriverClose).toHaveBeenCalledTimes(3);
    expect(fallbackDriverClose).toHaveBeenCalledTimes(1);
    expect(nextDriverInit).toHaveBeenCalledTimes(1);

    await instance.close();
    expect(nextDriverClose).toHaveBeenCalledTimes(1);
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
