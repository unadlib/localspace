import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, {
  indexedDBDriver,
  LocalSpace,
  memoryDriver,
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
    const instance = localspace.createInstance({
      name: uniqueName('close-during-plugin-init'),
      plugins: [
        {
          name: 'slow-init',
          onInit: async () => {
            markInitializationStarted();
            await initializationGate;
          },
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
    expect(onDestroy).toHaveBeenCalledTimes(1);
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
