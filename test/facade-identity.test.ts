import { describe, expect, it, vi } from 'vitest';
import {
  LocalSpace,
  memoryDriver,
  type Driver,
  type LocalSpaceInstance,
  type StorageValue,
} from '../src/index';

const PUBLIC_METHODS = [
  'clear',
  'capabilities',
  'close',
  'config',
  'createInstance',
  'driver',
  'dropInstance',
  'getDriver',
  'getItem',
  'getItems',
  'getSerializer',
  'iterate',
  'key',
  'keys',
  'length',
  'ready',
  'removeItem',
  'removeItems',
  'runTransaction',
  'setDriver',
  'setItem',
  'setItems',
  'supports',
  'use',
] as const satisfies ReadonlyArray<keyof LocalSpaceInstance>;

type PublicMethod = (typeof PUBLIC_METHODS)[number];

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const captureMethods = (instance: LocalSpaceInstance) =>
  Object.fromEntries(
    PUBLIC_METHODS.map((method) => [method, instance[method]])
  ) as Record<PublicMethod, unknown>;

const expectMethodsUnchanged = (
  instance: LocalSpaceInstance,
  captured: Record<PublicMethod, unknown>
) => {
  for (const method of PUBLIC_METHODS) {
    expect(instance[method], method).toBe(captured[method]);
  }
};

const createTaggedDriver = (driverName: string, tag: string): Driver => ({
  ...memoryDriver,
  _driver: driverName,
  _support: true,
  setItem: async function <T extends StorageValue>(
    key: string,
    value: T
  ): Promise<T> {
    const stored = `${tag}:${String(value)}` as T;
    await memoryDriver.setItem.call(this, key, stored);
    return stored;
  },
});

describe('stable public facade dispatch', () => {
  it('keeps every public method identity through ready, use, switching, and close', async () => {
    const firstDriver = createTaggedDriver(
      uniqueName('stable-first-driver'),
      'first'
    );
    const secondDriver = createTaggedDriver(
      uniqueName('stable-second-driver'),
      'second'
    );
    const instance = new LocalSpace({
      name: uniqueName('stable-facade'),
      driver: firstDriver._driver,
      drivers: [firstDriver, secondDriver],
    });
    const methods = captureMethods(instance);
    const capturedSetItem = instance.setItem;
    const capturedGetItem = instance.getItem;
    instance.use({
      name: 'current-plugin-dispatch',
      beforeSet: async (_key, value) => `plugin:${String(value)}`,
    });
    expectMethodsUnchanged(instance, methods);

    await instance.ready();
    expectMethodsUnchanged(instance, methods);
    await capturedSetItem('first-key', 'one');
    await expect(capturedGetItem('first-key')).resolves.toBe(
      'first:plugin:one'
    );

    await capturedSetItem('plugin-key', 'two');
    await expect(capturedGetItem('plugin-key')).resolves.toBe(
      'first:plugin:two'
    );

    await instance.setDriver(secondDriver._driver);
    await instance.ready();
    expectMethodsUnchanged(instance, methods);
    await capturedSetItem('second-key', 'three');
    await expect(capturedGetItem('second-key')).resolves.toBe(
      'second:plugin:three'
    );

    await instance.close();
    expectMethodsUnchanged(instance, methods);
    await expect(capturedGetItem('second-key')).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
    });
  });

  it('preserves captured methods and spies across fallback initialization', async () => {
    const failingName = uniqueName('stable-failing-driver');
    const workingDriver = createTaggedDriver(
      uniqueName('stable-fallback-driver'),
      'fallback'
    );
    const initializationError = new Error('expected initialization failure');
    const failingDriver: Driver = {
      ...memoryDriver,
      _driver: failingName,
      _support: true,
      _initStorage: async () => {
        throw initializationError;
      },
    };
    const instance = new LocalSpace({
      name: uniqueName('stable-fallback'),
      driver: [failingName, workingDriver._driver],
      drivers: [failingDriver, workingDriver],
    });
    const methods = captureMethods(instance);
    const setItemSpy = vi.spyOn(instance, 'setItem');
    const spyReference = instance.setItem;
    const afterSet = vi.fn();
    instance.use({ name: 'spy-observer', afterSet });

    await instance.ready();
    expect(instance.driver()).toBe(workingDriver._driver);
    expectMethodsUnchanged(instance, {
      ...methods,
      setItem: spyReference,
    });
    expect(instance.setItem).toBe(spyReference);
    await instance.setDriver(workingDriver._driver);
    expect(instance.setItem).toBe(spyReference);
    await instance.setItem('key', 'value');
    expect(setItemSpy).toHaveBeenCalledWith('key', 'value');
    expect(afterSet).toHaveBeenCalledTimes(1);
    await expect(instance.getItem('key')).resolves.toBe('fallback:value');

    await instance.close();
    expect(instance.setItem).toBe(spyReference);
  });

  it('keeps identities after failed initialization and manual recovery', async () => {
    const failingName = uniqueName('stable-total-failure');
    const initializationError = new Error('storage unavailable');
    const instance = new LocalSpace({
      name: uniqueName('stable-recovery'),
      driver: failingName,
      drivers: [
        {
          ...memoryDriver,
          _driver: failingName,
          _support: true,
          _initStorage: async () => {
            throw initializationError;
          },
        },
      ],
    });
    const methods = captureMethods(instance);
    const capturedSetItem = instance.setItem;

    await expect(instance.ready()).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      details: {
        driverErrors: [
          expect.objectContaining({
            driver: failingName,
            message: initializationError.message,
          }),
        ],
      },
    });
    expectMethodsUnchanged(instance, methods);

    await instance.setDriver(instance.MEMORY);
    await capturedSetItem('recovered', true);
    await expect(instance.getItem('recovered')).resolves.toBe(true);
    expectMethodsUnchanged(instance, methods);

    await instance.close();
  });
});
