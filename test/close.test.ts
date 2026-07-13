import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, {
  indexedDBDriver,
  LocalSpace,
  memoryDriver,
  ttlPlugin,
  type Driver,
  type LocalSpacePlugin,
} from '../src';
import { LocalSpaceError } from '../src/errors';

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const createClosableMemoryDriver = (
  driverName: string,
  closeStorage: () => Promise<void>
): Driver => ({
  ...memoryDriver,
  _driver: driverName,
  _support: true,
  _closeStorage: closeStorage,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LocalSpace.close', () => {
  it('is idempotent and does not initialize an unused instance', async () => {
    const onInit = vi.fn();
    const onDestroy = vi.fn();
    const closeStorage = vi.fn(async () => undefined);
    const driver = createClosableMemoryDriver(
      uniqueName('unused-close-driver'),
      closeStorage
    );
    const initStorage = vi.spyOn(driver, '_initStorage');
    const instance = new LocalSpace({
      plugins: [{ name: 'unused-lifecycle', onInit, onDestroy }],
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);

    const firstClose = instance.close();
    const secondClose = instance.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(initStorage).not.toHaveBeenCalled();
    expect(closeStorage).not.toHaveBeenCalled();
    expect(onInit).not.toHaveBeenCalled();
    expect(onDestroy).not.toHaveBeenCalled();

    await expect(instance.ready()).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
      message: 'LocalSpace instance is closed.',
      details: { operation: 'ready' },
    });
    await expect(instance.getItem('key')).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
    });
    await expect(instance.setDriver([driver._driver])).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
      details: { operation: 'setDriver' },
    });
  });

  it('cleans initialized plugins and the driver once without deleting data', async () => {
    const name = uniqueName('initialized-close');
    const storeName = 'store';
    const onInit = vi.fn();
    const onDestroy = vi.fn();
    const closeStorage = vi.fn(async () => undefined);
    const driver = createClosableMemoryDriver(
      uniqueName('initialized-close-driver'),
      closeStorage
    );
    const plugin: LocalSpacePlugin = {
      name: 'initialized-lifecycle',
      onInit,
      onDestroy,
    };
    const instance = new LocalSpace({ name, storeName, plugins: [plugin] });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);
    await instance.setItem('persisted', { value: true });

    await instance.close();
    await instance.close();

    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(closeStorage).toHaveBeenCalledTimes(1);

    const observer = localspace.createInstance({ name, storeName });
    await observer.setDriver([observer.MEMORY]);
    await expect(observer.getItem('persisted')).resolves.toEqual({
      value: true,
    });
    await observer.dropInstance();
  });

  it('waits for in-flight plugin initialization before cleaning it', async () => {
    let releaseInitialization!: () => void;
    let markInitializationStarted!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const initializationStarted = new Promise<void>((resolve) => {
      markInitializationStarted = resolve;
    });
    const onDestroy = vi.fn();
    const beforeSet = vi.fn((_key: string, value: unknown) => value);
    const instance = localspace.createInstance({
      name: uniqueName('close-during-plugin-init'),
      plugins: [
        {
          name: 'slow-init',
          onInit: async () => {
            markInitializationStarted();
            await initializationGate;
          },
          beforeSet,
          onDestroy,
        },
      ],
    });
    await instance.setDriver([instance.MEMORY]);

    const operation = instance.setItem('key', 'value');
    await initializationStarted;
    const closing = instance.close();
    releaseInitialization();

    await expect(operation).rejects.toBeInstanceOf(LocalSpaceError);
    await closing;
    expect(beforeSet).not.toHaveBeenCalled();
    expect(onDestroy).toHaveBeenCalledTimes(1);
  });

  it('does not initialize plugins or run hooks after close', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onInit = vi.fn();
    const onDestroy = vi.fn();
    const beforeSet = vi.fn((_key: string, value: unknown) => value);
    const beforeGet = vi.fn((key: string) => key);
    const beforeRemove = vi.fn((key: string) => key);
    const beforeSetItems = vi.fn((entries) => entries);
    const beforeGetItems = vi.fn((keys: string[]) => keys);
    const beforeRemoveItems = vi.fn((keys: string[]) => keys);
    const instance = localspace.createInstance({
      name: uniqueName('closed-plugin-entrypoints'),
      plugins: [
        {
          name: 'closed-plugin-entrypoints',
          onInit,
          onDestroy,
          beforeSet,
          beforeGet,
          beforeRemove,
          beforeSetItems,
          beforeGetItems,
          beforeRemoveItems,
        },
      ],
    });
    await instance.setDriver([instance.MEMORY]);
    await instance.ready();
    await instance.close();

    const operations: Array<[string, () => Promise<unknown>]> = [
      ['setItem', () => instance.setItem('key', 'value')],
      ['getItem', () => instance.getItem('key')],
      ['removeItem', () => instance.removeItem('key')],
      ['setItems', () => instance.setItems([{ key: 'key', value: 'value' }])],
      ['getItems', () => instance.getItems(['key'])],
      ['removeItems', () => instance.removeItems(['key'])],
    ];

    for (const [operation, invoke] of operations) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'INSTANCE_CLOSED',
        details: { operation },
      });
    }
    expect(onInit).not.toHaveBeenCalled();
    expect(onDestroy).not.toHaveBeenCalled();
    expect(beforeSet).not.toHaveBeenCalled();
    expect(beforeGet).not.toHaveBeenCalled();
    expect(beforeRemove).not.toHaveBeenCalled();
    expect(beforeSetItems).not.toHaveBeenCalled();
    expect(beforeGetItems).not.toHaveBeenCalled();
    expect(beforeRemoveItems).not.toHaveBeenCalled();
  });

  it('reports closed before transformation bypass guards', async () => {
    const instance = localspace.createInstance({
      name: uniqueName('closed-transform-guard'),
      plugins: [ttlPlugin({ defaultTTL: 60_000 })],
    });
    await instance.setDriver([instance.MEMORY]);
    await instance.ready();
    await instance.close();

    await expect(instance.iterate(vi.fn())).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
      details: { operation: 'iterate' },
    });
    await expect(
      instance.runTransaction('readonly', vi.fn())
    ).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
      details: { operation: 'runTransaction' },
    });
  });

  it('waits for an in-flight driver switch without initializing after close', async () => {
    let releaseOldDriverClose!: () => void;
    let markOldDriverCloseStarted!: () => void;
    const oldDriverCloseGate = new Promise<void>((resolve) => {
      releaseOldDriverClose = resolve;
    });
    const oldDriverCloseStarted = new Promise<void>((resolve) => {
      markOldDriverCloseStarted = resolve;
    });
    const oldDriverClose = vi.fn(async () => {
      markOldDriverCloseStarted();
      await oldDriverCloseGate;
    });
    const newDriverInit = vi.fn(memoryDriver._initStorage);
    const newDriverClose = vi.fn(async () => undefined);
    const oldDriver = createClosableMemoryDriver(
      uniqueName('close-switch-old'),
      oldDriverClose
    );
    const newDriver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('close-switch-new'),
      _support: true,
      _initStorage: newDriverInit,
      _closeStorage: newDriverClose,
    };
    const instance = new LocalSpace({
      name: uniqueName('close-during-driver-switch'),
      storeName: 'store',
    });
    await instance.defineDriver(oldDriver);
    await instance.defineDriver(newDriver);
    await instance.setDriver([oldDriver._driver]);
    await instance.ready();

    const switching = instance.setDriver([newDriver._driver]);
    await oldDriverCloseStarted;
    const inFlightReady = instance.ready();
    const closing = instance.close();

    let closeSettled = false;
    void closing.finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseOldDriverClose();

    await expect(switching).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
      details: { operation: 'setDriver' },
    });
    await expect(inFlightReady).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
    });
    await closing;

    expect(oldDriverClose).toHaveBeenCalledTimes(1);
    expect(newDriverInit).not.toHaveBeenCalled();
    expect(newDriverClose).not.toHaveBeenCalled();
  });

  it('continues initialized plugin cleanup after a hook failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const firstCleanup = vi.fn();
    const failingCleanup = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const instance = localspace.createInstance({
      name: uniqueName('close-cleanup-error'),
      pluginErrorPolicy: 'strict',
      plugins: [
        { name: 'first-cleanup', onDestroy: firstCleanup },
        { name: 'failing-cleanup', onDestroy: failingCleanup },
      ],
    });
    await instance.setDriver([instance.MEMORY]);
    await instance.setItem('key', 'value');

    await instance.close();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(failingCleanup).toHaveBeenCalledTimes(1);
    await instance.close();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(failingCleanup).toHaveBeenCalledTimes(1);
  });

  it('unregisters and closes the final IndexedDB context without deleting it', async () => {
    const name = uniqueName('indexeddb-close');
    const store = localspace.createInstance({
      name,
      storeName: 'store',
      prewarmTransactions: false,
    });
    await store.setDriver([store.INDEXEDDB]);
    await store.setItem('persisted', 'value');

    const dbInfo = store._dbInfo!;
    const testHooks = (
      indexedDBDriver as Driver & {
        __test__: { getDbContext(info: typeof dbInfo): unknown };
      }
    ).__test__;
    expect(testHooks.getDbContext(dbInfo)).toBeDefined();

    await store.close();

    expect(testHooks.getDbContext(dbInfo)).toBeUndefined();
    const observer = localspace.createInstance({
      name,
      storeName: 'store',
      prewarmTransactions: false,
    });
    await observer.setDriver([observer.INDEXEDDB]);
    await expect(observer.getItem('persisted')).resolves.toBe('value');
    await observer.dropInstance();
  });
});
