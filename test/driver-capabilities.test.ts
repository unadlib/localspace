import { describe, expect, it, vi } from 'vitest';
import {
  LocalSpace,
  memoryDriver,
  type Driver,
  type DriverCapabilities,
} from '../src/index';

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const createMinimalDriver = (name: string): Driver => {
  const values = new Map<string, unknown>();
  return {
    _driver: name,
    _support: true,
    _initStorage: async () => undefined,
    getItem: async <T>(key: string) =>
      values.has(key) ? (values.get(key) as T) : null,
    setItem: async <T>(key: string, value: T) => {
      values.set(key, value);
      return value;
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
    clear: async () => {
      values.clear();
    },
    length: async () => values.size,
    key: async (index: number) => [...values.keys()][index] ?? null,
    keys: async () => [...values.keys()],
    iterate: async <T, U>(
      iterator: (value: T, key: string, iterationNumber: number) => U
    ) => {
      let iteration = 1;
      for (const [key, value] of values) {
        const result = iterator(value as T, key, iteration++);
        if (result !== undefined) return result;
      }
      return undefined as U;
    },
  };
};

describe('driver capability snapshots', () => {
  it('exposes one frozen snapshot for the selected initialized driver', async () => {
    const instance = new LocalSpace({
      name: uniqueName('memory-capabilities'),
      driver: memoryDriver._driver,
    });
    const method = instance.capabilities;

    expect(() => instance.capabilities()).toThrowError(
      expect.objectContaining({
        code: 'DRIVER_NOT_INITIALIZED',
        details: { operation: 'capabilities' },
      })
    );

    await instance.ready();
    const capabilities = instance.capabilities();
    expect(capabilities).toEqual({
      transactions: true,
      atomicBatch: false,
      dropInstance: true,
      persistent: false,
      storageBuckets: false,
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(instance.capabilities()).toBe(capabilities);
    expect(instance.capabilities).toBe(method);

    await instance.close();
    expect(instance.capabilities).toBe(method);
    expect(() => instance.capabilities()).toThrowError(
      expect.objectContaining({ code: 'INSTANCE_CLOSED' })
    );
  });

  it('updates the snapshot across explicit driver switches without changing the facade', async () => {
    const instance = new LocalSpace({
      name: uniqueName('switch-capabilities'),
      driver: memoryDriver._driver,
    });
    const method = instance.capabilities;
    await instance.ready();
    const memoryCapabilities = instance.capabilities();

    await instance.setDriver(instance.INDEXEDDB);
    await instance.ready();
    const indexedDbCapabilities = instance.capabilities();
    expect(indexedDbCapabilities).not.toBe(memoryCapabilities);
    expect(indexedDbCapabilities).toMatchObject({
      transactions: true,
      atomicBatch: true,
      dropInstance: true,
      persistent: true,
    });
    expect(typeof indexedDbCapabilities.storageBuckets).toBe('boolean');
    expect(Object.isFrozen(indexedDbCapabilities)).toBe(true);
    expect(instance.capabilities).toBe(method);

    await instance.setDriver(instance.LOCALSTORAGE);
    await instance.ready();
    expect(instance.capabilities()).toEqual({
      transactions: false,
      atomicBatch: false,
      dropInstance: true,
      persistent: true,
      storageBuckets: false,
    });
    expect(instance.capabilities).toBe(method);

    await instance.close();
  });

  it('publishes capabilities only for the driver that wins fallback', async () => {
    const failingCapabilities = vi.fn(() => ({ persistent: false }));
    const workingCapabilities = vi.fn(() => ({
      transactions: true,
      dropInstance: true,
      persistent: true,
    }));
    const failingDriver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('capability-fallback-failure'),
      _initStorage: async () => {
        throw new Error('expected fallback');
      },
      _capabilities: failingCapabilities,
    };
    const workingDriver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('capability-fallback-success'),
      _capabilities: workingCapabilities,
    };
    const instance = new LocalSpace({
      name: uniqueName('capability-fallback'),
      driver: [failingDriver._driver, workingDriver._driver],
      drivers: [failingDriver, workingDriver],
    });

    await instance.ready();
    expect(instance.driver()).toBe(workingDriver._driver);
    expect(failingCapabilities).not.toHaveBeenCalled();
    expect(workingCapabilities).toHaveBeenCalledTimes(1);
    expect(instance.capabilities().persistent).toBe(true);

    await instance.close();
  });

  it('rejects missing optional operations before plugin initialization', async () => {
    const driver = createMinimalDriver(uniqueName('minimal-capabilities'));
    const onInit = vi.fn();
    const beforeSetItems = vi.fn((entries) => entries);
    const instance = new LocalSpace({
      driver: driver._driver,
      drivers: [driver],
      plugins: [{ name: 'must-not-run', onInit, beforeSetItems }],
    });
    await instance.ready();

    await expect(
      instance.setItems([{ key: 'key', value: true }])
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: {
        driver: driver._driver,
        operation: 'setItems',
        reason: 'driver-operation-unavailable',
      },
    });
    await expect(instance.dropInstance()).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: {
        driver: driver._driver,
        operation: 'dropInstance',
        capability: 'dropInstance',
      },
    });
    expect(onInit).not.toHaveBeenCalled();
    expect(beforeSetItems).not.toHaveBeenCalled();

    await instance.close();
  });

  it('honors an explicitly disabled transaction capability before side effects', async () => {
    const runTransaction = vi.fn(async (_mode, runner) => runner({} as never));
    const runner = vi.fn();
    const onInit = vi.fn();
    const beforeRunTransaction = vi.fn();
    const afterRunTransaction = vi.fn();
    const driver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('disabled-transactions'),
      _capabilities: { transactions: false },
      runTransaction,
    };
    const instance = new LocalSpace({
      driver: driver._driver,
      drivers: [driver],
      plugins: [
        {
          name: 'transaction-observer',
          onInit,
          beforeRunTransaction,
          afterRunTransaction,
        },
      ],
    });
    await instance.ready();

    await expect(
      instance.runTransaction('readwrite', runner)
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: {
        driver: driver._driver,
        operation: 'runTransaction',
        capability: 'transactions',
        reason: 'capability-disabled',
      },
    });
    expect(runTransaction).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(onInit).not.toHaveBeenCalled();
    expect(beforeRunTransaction).not.toHaveBeenCalled();
    expect(afterRunTransaction).not.toHaveBeenCalled();

    await instance.close();
  });

  it('snapshots nested declarations without freezing caller-owned metadata', async () => {
    const declaration: DriverCapabilities = {
      transactions: true,
      atomicBatch: false,
      dropInstance: true,
      persistent: true,
      storageBuckets: false,
    };
    const driver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('capability-metadata'),
      _capabilities: declaration,
    };
    const instance = new LocalSpace({
      driver: driver._driver,
      drivers: [driver],
    });
    declaration.persistent = false;
    await instance.ready();

    expect(Object.isFrozen(declaration)).toBe(false);
    expect(instance.capabilities().persistent).toBe(true);
    const definition = await instance.getDriver(driver._driver);
    expect(definition._capabilities).not.toBe(declaration);
    expect(Object.isFrozen(definition._capabilities)).toBe(true);

    await instance.close();
  });

  it('rejects impossible static capability declarations at registration', () => {
    const driver = createMinimalDriver(uniqueName('invalid-capabilities'));
    driver._capabilities = { transactions: true };

    expect(
      () => new LocalSpace({ driver: driver._driver, drivers: [driver] })
    ).toThrowError(
      expect.objectContaining({
        code: 'DRIVER_COMPLIANCE',
        details: {
          driver: driver._driver,
          reason: 'transactions requires runTransaction',
        },
      })
    );
  });
});
