import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, {
  indexedDBDriver,
  LocalSpace,
  memoryDriver,
  ttlPlugin,
  type Driver,
  type LocalSpaceConfig,
  type LocalSpaceInstance,
  type LocalSpacePlugin,
} from '../src';

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

  it('retries unfinished driver cleanup after close rejects', async () => {
    const cleanupError = new Error('transient cleanup failure');
    const closeStorage = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValue(undefined);
    const driver = createClosableMemoryDriver(
      uniqueName('retry-close-driver'),
      closeStorage
    );
    const instance = new LocalSpace({
      name: uniqueName('retry-close'),
      storeName: 'store',
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);
    await instance.setItem('key', 'value');

    const firstClose = instance.close();
    expect(instance.close()).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      cause: cleanupError,
      details: { operation: 'close' },
    });
    await expect(instance.getItem('key')).rejects.toMatchObject({
      code: 'INSTANCE_CLOSED',
    });

    const retry = instance.close();
    expect(retry).not.toBe(firstClose);
    await retry;
    await instance.close();
    expect(closeStorage).toHaveBeenCalledTimes(2);
  });

  it('rejects close while plugin initialization is in flight', async () => {
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

    await expect(closing).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { operation: 'close', reason: 'active-operations' },
    });
    releaseInitialization();

    await expect(operation).resolves.toBe('value');
    expect(beforeSet).toHaveBeenCalledTimes(1);
    await instance.close();
    expect(onDestroy).toHaveBeenCalledTimes(1);
  });

  it('shares plugin initialization with operations that arrive after it starts', async () => {
    let releaseInitialization!: () => void;
    let markInitializationStarted!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const initializationStarted = new Promise<void>((resolve) => {
      markInitializationStarted = resolve;
    });
    const onInit = vi.fn(async () => {
      markInitializationStarted();
      await initializationGate;
    });
    const instance = localspace.createInstance({
      name: uniqueName('concurrent-plugin-init'),
      plugins: [{ name: 'concurrent-plugin-init', onInit }],
    });
    await instance.setDriver([instance.MEMORY]);

    const firstWrite = instance.setItem('first', 'one');
    await initializationStarted;
    const secondWrite = instance.setItem('second', 'two');
    releaseInitialization();

    await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([
      'one',
      'two',
    ]);
    expect(onInit).toHaveBeenCalledTimes(1);
    await instance.close();
  });

  it('waits for an active TTL sweep before closing', async () => {
    let releaseSweep!: () => void;
    let markSweepStarted!: () => void;
    const sweepGate = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    const sweepStarted = new Promise<void>((resolve) => {
      markSweepStarted = resolve;
    });
    const driver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('slow-ttl-sweep-driver'),
      _support: true,
      getItems: async function <T>(keys: string[]) {
        markSweepStarted();
        await sweepGate;
        return memoryDriver.getItems!.call(this, keys) as Promise<
          Array<{ key: string; value: T | null }>
        >;
      },
    };
    const instance = localspace.createInstance({
      name: uniqueName('close-active-ttl-sweep'),
      plugins: [
        ttlPlugin({
          defaultTTL: 1,
          cleanupInterval: 5,
        }),
      ],
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);
    await instance.setItem('ephemeral', 'value');
    await sweepStarted;

    let closeSettled = false;
    const closing = instance.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseSweep();
    await closing;
  });

  it.each(['close', 'destroy'] as const)(
    'allows a TTL background onExpire callback to await %s()',
    async (lifecycleMethod) => {
      let instance!: LocalSpaceInstance;
      let callbackFinished = false;
      const onExpire = vi.fn(async () => {
        await instance[lifecycleMethod]();
        callbackFinished = true;
      });
      instance = localspace.createInstance({
        name: uniqueName(`ttl-on-expire-${lifecycleMethod}`),
        plugins: [
          ttlPlugin({
            defaultTTL: 1,
            cleanupInterval: 5,
            onExpire,
          }),
        ],
      });
      await instance.setDriver([instance.MEMORY]);
      await instance.setItem('ephemeral', 'value');

      await vi.waitFor(() => expect(callbackFinished).toBe(true));
      expect(onExpire).toHaveBeenCalledTimes(1);

      if (lifecycleMethod === 'destroy') {
        await instance.close();
      }
    }
  );

  it('resumes TTL cleanup when close rejects for a foreground operation', async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const onExpire = vi.fn();
    const instance = localspace.createInstance({
      name: uniqueName('resume-ttl-after-close-rejection'),
      plugins: [
        {
          name: 'slow-write',
          priority: 20,
          beforeSet: async (_key, value) => {
            markWriteStarted();
            await writeGate;
            return value;
          },
        },
        ttlPlugin({
          defaultTTL: 5,
          cleanupInterval: 10,
          onExpire,
        }),
      ],
    });
    await instance.setDriver([instance.MEMORY]);

    const write = instance.setItem('ephemeral', 'value');
    await writeStarted;
    await expect(instance.close()).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { operation: 'close', reason: 'active-operations' },
    });

    releaseWrite();
    await write;
    await vi.waitFor(() => expect(onExpire).toHaveBeenCalledTimes(1));
    await instance.close();
  });

  it('shares plugin teardown between concurrent destroy and close calls', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let releaseDestroy!: () => void;
    let markDestroyStarted!: () => void;
    const destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    const destroyStarted = new Promise<void>((resolve) => {
      markDestroyStarted = resolve;
    });
    const onDestroy = vi.fn(async () => {
      markDestroyStarted();
      await destroyGate;
    });
    const instance = localspace.createInstance({
      name: uniqueName('concurrent-plugin-destroy'),
      plugins: [{ name: 'concurrent-plugin-destroy', onDestroy }],
    });
    await instance.setDriver([instance.MEMORY]);
    await instance.setItem('key', 'value');

    const destroying = instance.destroy();
    await destroyStarted;
    let closeSettled = false;
    const closing = instance.close().then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(closeSettled).toBe(false);
    releaseDestroy();

    await Promise.all([destroying, closing]);
    expect(onDestroy).toHaveBeenCalledTimes(1);
  });

  it('waits for the complete plugin initialization pass before closing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let releaseFirstInit!: () => void;
    let markFirstInitStarted!: () => void;
    let releaseSecondInit!: () => void;
    let markSecondInitStarted!: () => void;
    const firstInitGate = new Promise<void>((resolve) => {
      releaseFirstInit = resolve;
    });
    const firstInitStarted = new Promise<void>((resolve) => {
      markFirstInitStarted = resolve;
    });
    const secondInitGate = new Promise<void>((resolve) => {
      releaseSecondInit = resolve;
    });
    const secondInitStarted = new Promise<void>((resolve) => {
      markSecondInitStarted = resolve;
    });
    const events: string[] = [];
    const instance = localspace.createInstance({
      name: uniqueName('close-complete-plugin-init'),
      plugins: [
        {
          name: 'first-init',
          onInit: async () => {
            events.push('init:first:start');
            markFirstInitStarted();
            await firstInitGate;
            events.push('init:first:end');
          },
          onDestroy: () => {
            events.push('destroy:first');
          },
        },
        {
          name: 'second-init',
          onInit: async () => {
            events.push('init:second:start');
            markSecondInitStarted();
            await secondInitGate;
            events.push('init:second:end');
          },
          onDestroy: () => {
            events.push('destroy:second');
          },
        },
      ],
    });
    await instance.setDriver([instance.MEMORY]);

    const destroying = instance.destroy();
    await firstInitStarted;
    let closeSettled = false;
    const closing = instance.close().then(() => {
      closeSettled = true;
      events.push('close:end');
    });

    releaseFirstInit();
    await secondInitStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(closeSettled).toBe(false);
    expect(events).toEqual([
      'init:first:start',
      'init:first:end',
      'init:second:start',
    ]);

    releaseSecondInit();
    await Promise.all([destroying, closing]);

    expect(events).toEqual([
      'init:first:start',
      'init:first:end',
      'init:second:start',
      'init:second:end',
      'destroy:second',
      'destroy:first',
      'close:end',
    ]);
  });

  it('fails fast when plugin teardown tries to close the same instance', async () => {
    let instance!: LocalSpace;
    let capturedReentryError: unknown;
    let reentryError: unknown;
    instance = new LocalSpace({
      name: uniqueName('plugin-destroy-reentrant-close'),
      plugins: [
        {
          name: 'plugin-destroy-reentrant-close',
          onDestroy: async (context) => {
            capturedReentryError = await instance
              .close()
              .catch((error) => Promise.resolve(error));
            await Promise.resolve();
            reentryError = await context
              .lifecycleInstance!.close()
              .catch((error) => Promise.resolve(error));
          },
        },
      ],
    });
    await instance.setDriver([instance.MEMORY]);
    await instance.setItem('key', 'value');

    await instance.close();

    expect(capturedReentryError).toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        operation: 'close',
        reason: 'lifecycle-reentrancy',
        lifecycle: 'plugin-destroy',
      },
    });
    expect(reentryError).toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        operation: 'close',
        reason: 'lifecycle-reentrancy',
        lifecycle: 'plugin-destroy',
      },
    });
  });

  it('fails fast when async plugin initialization reenters through its context', async () => {
    let reentryError: unknown;
    const instance = new LocalSpace({
      name: uniqueName('plugin-init-context-reentry'),
      plugins: [
        {
          name: 'plugin-init-context-reentry',
          onInit: async (context) => {
            await Promise.resolve();
            reentryError = await context
              .lifecycleInstance!.getItem('nested')
              .catch((error) => Promise.resolve(error));
          },
        },
      ],
    });
    await instance.setDriver([instance.MEMORY]);

    await expect(instance.setItem('key', 'value')).resolves.toBe('value');
    expect(reentryError).toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        operation: 'getItem',
        reason: 'lifecycle-reentrancy',
        lifecycle: 'plugin-init',
      },
    });
    await instance.close();
  });

  it('releases the plugin lifecycle guard after initialization settles', async () => {
    let lifecycleInstance!: LocalSpaceInstance;
    let releaseSecondInitialization!: () => void;
    let markSecondInitializationStarted!: () => void;
    const secondInitializationGate = new Promise<void>((resolve) => {
      releaseSecondInitialization = resolve;
    });
    const secondInitializationStarted = new Promise<void>((resolve) => {
      markSecondInitializationStarted = resolve;
    });
    const instance = new LocalSpace({
      name: uniqueName('released-plugin-init-guard'),
      plugins: [
        {
          name: 'released-plugin-init-guard',
          onInit: async (context) => {
            lifecycleInstance = context.lifecycleInstance!;
            await Promise.resolve();
          },
        },
        {
          name: 'later-plugin-init-guard',
          onInit: async () => {
            markSecondInitializationStarted();
            await secondInitializationGate;
          },
        },
      ],
    });
    await instance.setDriver([instance.MEMORY]);
    const write = instance.setItem('key', 'value');
    await secondInitializationStarted;

    let retainedCallState: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    const retainedCall = lifecycleInstance.getItem('key').then(
      () => {
        retainedCallState = 'fulfilled';
      },
      () => {
        retainedCallState = 'rejected';
      }
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(retainedCallState).toBe('pending');
    releaseSecondInitialization();
    await Promise.all([write, retainedCall]);

    expect(retainedCallState).toBe('fulfilled');
    await instance.close();
  });

  it('preserves plugin instance identity across lifecycle and operation hooks', async () => {
    const state = new WeakMap<LocalSpaceInstance, { writes: number }>();
    let initInstance: LocalSpaceInstance | undefined;
    let hookInstance: LocalSpaceInstance | undefined;
    let destroyInstance: LocalSpaceInstance | undefined;
    const instance = new LocalSpace({
      name: uniqueName('stable-plugin-instance'),
      pluginErrorPolicy: 'strict',
      plugins: [
        {
          name: 'stable-plugin-instance',
          onInit: (context) => {
            expect(context.lifecycleInstance).toBeDefined();
            initInstance = context.instance;
            state.set(context.instance, { writes: 0 });
          },
          beforeSet: (_key, value, context) => {
            expect(context.lifecycleInstance).toBeUndefined();
            hookInstance = context.instance;
            const pluginState = state.get(context.instance);
            if (!pluginState) {
              throw new Error('Plugin instance state is missing.');
            }
            pluginState.writes++;
            return value;
          },
          onDestroy: (context) => {
            expect(context.lifecycleInstance).toBeDefined();
            destroyInstance = context.instance;
            expect(state.get(context.instance)?.writes).toBe(1);
          },
        },
      ],
    });
    await instance.setDriver([instance.MEMORY]);

    await expect(instance.setItem('key', 'value')).resolves.toBe('value');
    await instance.close();

    expect(hookInstance).toBe(initInstance);
    expect(destroyInstance).toBe(initInstance);
    expect(initInstance).toBe(instance);
  });

  it('fails fast when custom driver initialization reenters lifecycle', async () => {
    let reentryError: unknown;
    const driver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('driver-init-reentrant-close'),
      _support: true,
      _initStorage: async function (config) {
        await Promise.resolve();
        reentryError = await this.close().catch((error) =>
          Promise.resolve(error)
        );
        await memoryDriver._initStorage.call(this, config);
      },
    };
    const instance = new LocalSpace({
      name: uniqueName('driver-init-reentrant-close'),
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);

    await instance.ready();

    expect(reentryError).toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        operation: 'close',
        reason: 'lifecycle-reentrancy',
        lifecycle: 'driver-init',
      },
    });
    await instance.close();
  });

  it('shares driver initialization with ready calls that arrive after it starts', async () => {
    let releaseInitialization!: () => void;
    let markInitializationStarted!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const initializationStarted = new Promise<void>((resolve) => {
      markInitializationStarted = resolve;
    });
    const initStorage = vi.fn(async function (
      this: LocalSpace,
      config: LocalSpaceConfig
    ) {
      markInitializationStarted();
      await initializationGate;
      await memoryDriver._initStorage.call(this, config);
    });
    const driver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('concurrent-driver-init'),
      _support: true,
      _initStorage: initStorage,
    };
    const instance = new LocalSpace({
      name: uniqueName('concurrent-driver-init'),
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);

    const firstReady = instance.ready();
    await initializationStarted;
    const secondReady = instance.ready();
    releaseInitialization();

    await expect(Promise.all([firstReady, secondReady])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(initStorage).toHaveBeenCalledTimes(1);
    await instance.close();
  });

  it('releases the custom driver lifecycle guard after initialization settles', async () => {
    let lifecycleInstance!: LocalSpaceInstance;
    const driver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('released-driver-init-guard'),
      _support: true,
      _initStorage: async function (config) {
        lifecycleInstance = this as unknown as LocalSpaceInstance;
        await Promise.resolve();
        await memoryDriver._initStorage.call(this, config);
      },
    };
    const instance = new LocalSpace({
      name: uniqueName('released-driver-init-guard'),
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);
    await instance.ready();
    await instance.setItem('key', 'value');

    await expect(lifecycleInstance.getItem('key')).resolves.toBe('value');
    await instance.close();
  });

  it('preserves custom driver receiver identity across lifecycle and operations', async () => {
    const state = new WeakMap<LocalSpaceInstance, { reads: number }>();
    let initReceiver: LocalSpaceInstance | undefined;
    let operationReceiver: LocalSpaceInstance | undefined;
    let closeReceiver: LocalSpaceInstance | undefined;
    const driver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('stable-driver-receiver'),
      _support: true,
      _initStorage: async function (config) {
        initReceiver = this;
        state.set(this, { reads: 0 });
        await memoryDriver._initStorage.call(this, config);
      },
      getItem: async function <T>(key: string): Promise<T | null> {
        operationReceiver = this;
        const driverState = state.get(this);
        if (!driverState) {
          throw new Error('Driver receiver state is missing.');
        }
        driverState.reads++;
        return memoryDriver.getItem.call(this, key) as Promise<T | null>;
      },
      _closeStorage: async function () {
        closeReceiver = this;
        expect(state.get(this)?.reads).toBe(1);
      },
    };
    const instance = new LocalSpace({
      name: uniqueName('stable-driver-receiver'),
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);
    await instance.setItem('key', 'value');

    await expect(instance.getItem('key')).resolves.toBe('value');
    await instance.close();

    expect(operationReceiver).toBe(initReceiver);
    expect(closeReceiver).toBe(initReceiver);
  });

  it('fails fast when custom driver cleanup starts a storage operation', async () => {
    let reentryError: unknown;
    const oldDriver: Driver = {
      ...memoryDriver,
      _driver: uniqueName('driver-close-reentrant-read'),
      _support: true,
      _closeStorage: async function () {
        await Promise.resolve();
        reentryError = await this.getItem('key').catch((error) =>
          Promise.resolve(error)
        );
      },
    };
    const instance = new LocalSpace({
      name: uniqueName('driver-close-reentrant-read'),
    });
    await instance.defineDriver(oldDriver);
    await instance.setDriver([oldDriver._driver]);
    await instance.ready();

    await instance.setDriver([instance.MEMORY]);

    expect(reentryError).toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        operation: 'getItem',
        reason: 'lifecycle-reentrancy',
        lifecycle: 'driver-close',
      },
    });
    await instance.close();
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
    const activeOperations = (
      instance as unknown as {
        _activeOperations: Set<Promise<unknown>>;
      }
    )._activeOperations;
    const activeMarker = Promise.resolve();
    activeOperations.add(activeMarker);
    const inFlightReady = instance.ready();
    let readyState: 'pending' | 'resolved' | 'rejected' = 'pending';
    void inFlightReady.then(
      () => {
        readyState = 'resolved';
      },
      () => {
        readyState = 'rejected';
      }
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(readyState).toBe('pending');
    activeOperations.delete(activeMarker);

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

  it('retries current driver cleanup after a driver switch rejects', async () => {
    const cleanupError = new Error('transient switch cleanup failure');
    const oldDriverClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValue(undefined);
    const newDriverClose = vi.fn(async () => undefined);
    const oldDriver = createClosableMemoryDriver(
      uniqueName('retry-switch-old'),
      oldDriverClose
    );
    const newDriver = createClosableMemoryDriver(
      uniqueName('retry-switch-new'),
      newDriverClose
    );
    const instance = new LocalSpace({
      name: uniqueName('retry-driver-switch'),
      storeName: 'store',
    });
    await instance.defineDriver(oldDriver);
    await instance.defineDriver(newDriver);
    await instance.setDriver([oldDriver._driver]);
    await instance.setItem('before-switch', 'value');

    await expect(instance.setDriver([newDriver._driver])).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      cause: cleanupError,
      details: { operation: 'setDriver' },
    });
    expect(instance.driver()).toBe(oldDriver._driver);
    expect(oldDriverClose).toHaveBeenCalledTimes(1);

    await instance.setDriver([newDriver._driver]);
    await instance.ready();
    expect(instance.driver()).toBe(newDriver._driver);
    expect(oldDriverClose).toHaveBeenCalledTimes(2);
    await expect(instance.setItem('after-switch', 'value')).resolves.toBe(
      'value'
    );

    await instance.close();
    expect(newDriverClose).toHaveBeenCalledTimes(1);
  });

  it('rejects close until the active operation settles', async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const events: string[] = [];
    const closeStorage = vi.fn(async () => {
      events.push('driver-closed');
    });
    const driver: Driver = {
      ...createClosableMemoryDriver(
        uniqueName('close-in-flight-driver'),
        closeStorage
      ),
      setItem: async <T>(_key: string, value: T) => {
        markWriteStarted();
        await writeGate;
        events.push('write-finished');
        return value;
      },
    };
    const instance = new LocalSpace({
      name: uniqueName('close-in-flight-operation'),
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);
    await instance.ready();

    const write = instance.setItem('key', 'value');
    await writeStarted;
    await expect(instance.close()).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { operation: 'close', reason: 'active-operations' },
    });

    expect(closeStorage).not.toHaveBeenCalled();
    releaseWrite();

    await expect(write).resolves.toBe('value');
    await instance.close();
    events.push('close-finished');
    expect(closeStorage).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'write-finished',
      'driver-closed',
      'close-finished',
    ]);
  });

  it('rejects driver switches until the active operation settles', async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const oldDriverClose = vi.fn(async () => undefined);
    const oldDriverSet = vi.fn(async function <T>(
      this: LocalSpace,
      _key: string,
      value: T
    ) {
      markWriteStarted();
      await writeGate;
      await this.ready();
      return value;
    });
    const oldDriver: Driver = {
      ...createClosableMemoryDriver(
        uniqueName('switch-in-flight-old'),
        oldDriverClose
      ),
      setItem: oldDriverSet,
    };
    const newDriverSet = vi.fn(async <T>(_key: string, value: T) => value);
    const newDriver: Driver = {
      ...createClosableMemoryDriver(
        uniqueName('switch-in-flight-new'),
        vi.fn(async () => undefined)
      ),
      setItem: newDriverSet,
    };
    const instance = new LocalSpace({
      name: uniqueName('switch-in-flight-operation'),
    });
    await instance.defineDriver(oldDriver);
    await instance.defineDriver(newDriver);
    await instance.setDriver([oldDriver._driver]);
    await instance.ready();

    const write = instance.setItem('key', 'value');
    await writeStarted;
    await expect(instance.setDriver([newDriver._driver])).rejects.toMatchObject(
      {
        code: 'OPERATION_FAILED',
        details: { operation: 'setDriver', reason: 'active-operations' },
      }
    );

    expect(oldDriverClose).not.toHaveBeenCalled();
    expect(oldDriverSet).toHaveBeenCalledTimes(1);
    expect(newDriverSet).not.toHaveBeenCalled();
    releaseWrite();

    await expect(write).resolves.toBe('value');
    await instance.setDriver([newDriver._driver]);
    await expect(instance.setItem('queued', 'new-value')).resolves.toBe(
      'new-value'
    );
    expect(oldDriverClose).toHaveBeenCalledTimes(1);
    expect(newDriverSet).toHaveBeenCalledTimes(1);
    expect(instance.driver()).toBe(newDriver._driver);
    await instance.close();
  });

  it('fails fast when a plugin hook tries to close its own operation', async () => {
    const instance = localspace.createInstance({
      name: uniqueName('hook-reentrant-close'),
      plugins: [
        {
          name: 'hook-reentrant-close',
          beforeSet: async (_key, value, context) => {
            await context.instance.close();
            return value;
          },
        },
      ],
    });
    await instance.setDriver([instance.MEMORY]);

    await expect(instance.setItem('key', 'value')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { operation: 'close', reason: 'active-operations' },
    });

    await instance.close();
  });

  it('fails fast when a transaction runner tries to switch drivers', async () => {
    const instance = localspace.createInstance({
      name: uniqueName('transaction-reentrant-switch'),
    });
    await instance.setDriver([instance.MEMORY]);

    await expect(
      instance.runTransaction('readonly', async () => {
        await instance.setDriver([instance.MEMORY]);
      })
    ).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { reason: 'active-operations' },
    });

    await instance.close();
  });

  it('fails fast when a custom driver tries to close its own operation', async () => {
    const driver: Driver = {
      ...createClosableMemoryDriver(
        uniqueName('driver-reentrant-close'),
        vi.fn(async () => undefined)
      ),
      setItem: async function <T>(this: LocalSpace, _key: string, value: T) {
        await this.close();
        return value;
      },
    };
    const instance = new LocalSpace({
      name: uniqueName('driver-reentrant-close-operation'),
    });
    await instance.defineDriver(driver);
    await instance.setDriver([driver._driver]);
    await instance.ready();

    await expect(instance.setItem('key', 'value')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { operation: 'close', reason: 'active-operations' },
    });

    await instance.close();
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
