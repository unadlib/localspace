import type {
  LocalSpaceInstance,
  LocalSpaceConfig,
  LocalSpaceOptions,
  LocalSpacePlugin,
  Driver,
  DbInfo,
  Serializer,
  BatchItems,
  BatchResponse,
  TransactionMode,
  TransactionScope,
  PluginContext,
  PluginOperation,
  LocalSpaceCapabilities,
  LocalSpaceConfigSnapshot,
} from './types.js';
import { extend, isArray, normalizeBatchEntries } from './utils/helpers.js';
import {
  createLocalSpaceError,
  describeError,
  LocalSpaceError,
  toLocalSpaceError,
} from './errors.js';
import serializer from './utils/serializer.js';
import idbDriver from './drivers/indexeddb.js';
import localstorageDriver from './drivers/localstorage.js';
import memoryDriver from './drivers/memory.js';
import { PluginManager } from './core/plugin-manager.js';
import { createConfigSnapshot, normalizeConfigOptions } from './core/config.js';
import {
  markPluginInternalOperation,
  type PluginBackgroundTaskPause,
  type PluginInternalOperation,
} from './core/plugin-capabilities.js';
import { validateStorageValueWrite } from './core/storage-value.js';
import { decodeStoredRecordValue } from './core/stored-record.js';
import {
  DriverRegistry,
  globalDriverRegistry,
  registerBuiltInDriver,
} from './core/driver-registry.js';
import {
  DRIVER_OPERATIONS,
  type DriverOperation,
} from './core/driver-contract.js';
import { resolveDriverCapabilities } from './core/driver-capabilities.js';

const DefaultDrivers: Record<'INDEXEDDB' | 'LOCALSTORAGE' | 'MEMORY', Driver> =
  {
    INDEXEDDB: idbDriver,
    LOCALSTORAGE: localstorageDriver,
    MEMORY: memoryDriver,
  };

const DefaultDriverOrder = [
  DefaultDrivers.INDEXEDDB._driver,
  DefaultDrivers.LOCALSTORAGE._driver,
];
const BuiltInDriverInitialization = Promise.all(
  Object.values(DefaultDrivers).map((driver) =>
    registerBuiltInDriver(driver).catch((error) => {
      console.warn(
        `Failed to register LocalSpace driver "${driver._driver}"`,
        error
      );
    })
  )
).then(() => undefined);

type RawDriverMethod = (...args: any[]) => Promise<unknown>;

type LifecycleCallback =
  | 'plugin-init'
  | 'plugin-destroy'
  | 'driver-init'
  | 'driver-close';

type LifecycleInvocation<TInstance> = {
  instance: TInstance;
  invoke<T>(callback: () => T): Promise<Awaited<T>>;
};

type LifecycleScope<TInstance> = {
  instance: TInstance;
  invoke<T>(
    lifecycle: LifecycleCallback,
    callback: () => T
  ): Promise<Awaited<T>>;
};

type LifecycleReceiverContext = Map<PropertyKey, unknown>;

type ActiveLifecycleInvocation = {
  token: object;
  lifecycle: LifecycleCallback;
};

const LifecycleReentrantMethods = new Set<string>([
  ...DRIVER_OPERATIONS,
  'ready',
  'setDriver',
  'close',
]);

type DriverInitializationFailure = {
  driver: string;
  error: unknown;
};

type DriverClose = () => Promise<void>;

type DriverSession = {
  driver: string;
  operations: Readonly<Record<DriverOperation, RawDriverMethod>>;
  supportedOperations: ReadonlySet<DriverOperation>;
  initialize(): Promise<void>;
  resolveCapabilities(): Readonly<LocalSpaceCapabilities>;
  close: DriverClose | null;
  syncFacade(): void;
};

type DriverCleanup = {
  driver: string;
  close: DriverClose;
};

type DriverCleanupFailure = DriverCleanup & {
  error: unknown;
};

function createDriverUnavailableError(
  attemptedDrivers: string[],
  failures: DriverInitializationFailure[] = []
): LocalSpaceError {
  const driverErrors = failures.map(({ driver, error }) => {
    const summary = describeError(error);
    return {
      driver,
      name: summary.name,
      message: summary.message,
      ...(error instanceof LocalSpaceError ? { code: error.code } : {}),
    };
  });

  return new LocalSpaceError(
    'DRIVER_UNAVAILABLE',
    'No available storage method found.',
    {
      attemptedDrivers,
      ...(driverErrors.length > 0 ? { driverErrors } : {}),
    },
    failures.length > 0 ? failures.map(({ error }) => error) : undefined
  );
}

const DefaultConfig: LocalSpaceConfig = {
  description: '',
  driver: DefaultDriverOrder.slice(),
  name: 'localforage',
  storeName: 'keyvaluepairs',
  version: 1.0,
  pluginInitPolicy: 'fail',
  pluginErrorPolicy: 'lenient',
};

type DriverAugmentedInstance = LocalSpaceInstance &
  Partial<Driver> & {
    _initStorage?: (config: LocalSpaceConfig) => Promise<void>;
  };

export class LocalSpace implements LocalSpaceInstance {
  readonly INDEXEDDB = 'asyncStorage';
  readonly LOCALSTORAGE = 'localStorageWrapper';
  readonly MEMORY = 'memoryStorageWrapper';
  readonly REACTNATIVEASYNCSTORAGE = 'reactNativeAsyncStorageWrapper';

  #defaultConfig: LocalSpaceConfig;
  #config: LocalSpaceConfig;
  private _driverSet: Promise<void> | null = null;
  private _pendingDriverInitialization: Promise<void> | null = null;
  private _isRunningDefaultDriverSelection = false;
  private _manualDriverOverride = false;
  private _initDriver: (() => Promise<void>) | null = null;
  private _ready: Promise<void> | null = null;
  private _dbInfo: DbInfo | null = null;
  private _driver?: string;
  private _closed = false;
  #configurationLocked = false;
  private _closePromise: Promise<void> | null = null;
  private _driverInitialized = false;
  private _capabilitiesSnapshot: Readonly<LocalSpaceCapabilities> | null = null;
  private _activeDriverSession: DriverSession | null = null;
  private _pendingDriverCleanups: DriverCleanup[] = [];
  private _driverTransition: Promise<void> | null = null;
  private _operationPause: Promise<void> | null = null;
  private _operationsStarting = 0;
  private readonly _activeOperations = new Set<Promise<unknown>>();
  private _invokingLifecycleCallback: LifecycleCallback | null = null;
  private _pluginManager: PluginManager;
  private readonly _driverRegistry = new DriverRegistry(globalDriverRegistry);

  constructor(options?: LocalSpaceOptions) {
    const { plugins = [], drivers = [], ...configOverrides } = options ?? {};
    const normalizedOverrides = normalizeConfigOptions(configOverrides);

    this.#defaultConfig = extend({}, DefaultConfig);
    this.#config = extend({}, this.#defaultConfig, normalizedOverrides);
    this._pluginManager = new PluginManager(this, plugins, {
      createInvocation: (lifecycle) =>
        this._createLifecycleInvocation(lifecycle),
      getDbInfo: () => this._dbInfo,
    });

    const driverInitializationPromises = drivers.map((driver) =>
      this._driverRegistry.register(driver)
    );
    const waitForDrivers = Promise.all([
      BuiltInDriverInitialization,
      ...driverInitializationPromises,
    ]).then(() => undefined);

    this._pendingDriverInitialization = waitForDrivers.then(() =>
      this._runDefaultDriverSelection()
    );

    this._pendingDriverInitialization.then(
      () => {
        this._pendingDriverInitialization = null;
      },
      () => {
        this._pendingDriverInitialization = null;
      }
    );
  }

  clear = (): Promise<void> => this._dispatchOperation('clear', []);

  getItem: LocalSpaceInstance['getItem'] = ((...args: unknown[]) =>
    this._dispatchOperation('getItem', args)) as LocalSpaceInstance['getItem'];

  getItems: LocalSpaceInstance['getItems'] = ((...args: unknown[]) =>
    this._dispatchOperation(
      'getItems',
      args
    )) as LocalSpaceInstance['getItems'];

  iterate = <T, U>(
    iteratorCallback: (value: T, key: string, iterationNumber: number) => U
  ): Promise<U> => this._dispatchOperation<U>('iterate', [iteratorCallback]);

  key = (keyIndex: number): Promise<string | null> =>
    this._dispatchOperation<string | null>('key', [keyIndex]);

  keys = (): Promise<string[]> => this._dispatchOperation('keys', []);

  length = (): Promise<number> => this._dispatchOperation('length', []);

  removeItem = (key: string): Promise<void> =>
    this._dispatchOperation('removeItem', [key]);

  removeItems = (keys: string[]): Promise<void> =>
    this._dispatchOperation('removeItems', [keys]);

  runTransaction = <T>(
    mode: TransactionMode,
    runner: (scope: TransactionScope) => Promise<T> | T
  ): Promise<T> => this._dispatchOperation<T>('runTransaction', [mode, runner]);

  setItem = <T>(key: string, value: T): Promise<T> =>
    this._dispatchOperation<T>('setItem', [key, value]);

  setItems = <T>(entries: BatchItems<T>): Promise<BatchResponse<T>> =>
    this._dispatchOperation<BatchResponse<T>>('setItems', [entries]);

  dropInstance = (options?: LocalSpaceConfig): Promise<void> =>
    this._dispatchOperation('dropInstance', [options]);

  capabilities = (): LocalSpaceCapabilities => {
    this._assertOpen('capabilities');
    if (!this._driverInitialized || !this._capabilitiesSnapshot) {
      throw this._notInitializedError('capabilities');
    }
    return this._capabilitiesSnapshot;
  };

  config<K extends keyof LocalSpaceConfig>(
    key: K
  ): LocalSpaceConfigSnapshot[K] | undefined;
  config(): LocalSpaceConfigSnapshot;
  config(key?: keyof LocalSpaceConfig) {
    if (key !== undefined && typeof key !== 'string') {
      throw createLocalSpaceError(
        'INVALID_ARGUMENT',
        '`config(options)` was removed in LocalSpace 3.0; pass options at construction.',
        { operation: 'config', reason: 'setter-removed' }
      );
    }

    const snapshot = createConfigSnapshot(this.#config);
    return key === undefined ? snapshot : snapshot[key];
  }

  createInstance(options?: LocalSpaceOptions): LocalSpaceInstance {
    return new LocalSpace(options);
  }

  use(plugin: LocalSpacePlugin | LocalSpacePlugin[]): LocalSpaceInstance {
    this._assertOpen('use');
    if (this.#configurationLocked) {
      throw createLocalSpaceError(
        'CONFIG_LOCKED',
        'Plugins must be registered before the first ready() or storage operation.',
        { operation: 'use', reason: 'instance-started' }
      );
    }
    const plugins = Array.isArray(plugin) ? plugin : [plugin];
    this._pluginManager.registerPlugins(plugins);
    return this;
  }

  close(): Promise<void> {
    try {
      this._assertNotLifecycleReentrant('close');
    } catch (error) {
      return Promise.reject(error);
    }
    if (this._closePromise) {
      return this._closePromise;
    }

    let backgroundTasks: PluginBackgroundTaskPause;
    try {
      backgroundTasks = this._pluginManager.pauseBackgroundTasks();
    } catch (error) {
      return Promise.reject(error);
    }

    if (!backgroundTasks.pending) {
      try {
        this._assertLifecycleIdle('close');
      } catch (error) {
        backgroundTasks.resume();
        return Promise.reject(error);
      }
      this._closed = true;
      return this._trackCloseAttempt(this._performCloseCleanup());
    }

    const closeAttempt = (async () => {
      try {
        await backgroundTasks.settled;
        this._assertLifecycleIdle('close');
      } catch (error) {
        backgroundTasks.resume();
        throw error;
      }

      this._closed = true;
      await this._performCloseCleanup();
    })();
    return this._trackCloseAttempt(closeAttempt);
  }

  private _trackCloseAttempt(closeAttempt: Promise<void>): Promise<void> {
    let trackedAttempt!: Promise<void>;
    trackedAttempt = closeAttempt.catch((error) => {
      if (this._closePromise === trackedAttempt) {
        this._closePromise = null;
      }
      throw error;
    });
    this._closePromise = trackedAttempt;
    return trackedAttempt;
  }

  private async _performCloseCleanup(): Promise<void> {
    const initializationInProgress = this._ready;
    const driverSelectionInProgress = this._pendingDriverInitialization;
    const driverTransitionInProgress = this._driverTransition;
    const driverChangeInProgress = this._driverSet;

    let cleanupError: LocalSpaceError | undefined;

    await Promise.allSettled(
      [
        driverSelectionInProgress,
        driverTransitionInProgress,
        driverChangeInProgress,
        initializationInProgress,
      ].filter((promise): promise is Promise<void> => promise !== null)
    );

    await this._drainActiveOperations();

    try {
      await this._pluginManager.destroyInitialized();
    } catch (error) {
      cleanupError = toLocalSpaceError(
        error,
        'OPERATION_FAILED',
        'Failed to close LocalSpace plugins.',
        { operation: 'close' }
      );
    }

    const pendingDriverCleanupFailures =
      await this._retryPendingDriverCleanups();
    if (pendingDriverCleanupFailures.length > 0) {
      cleanupError ??= this._createPendingDriverCleanupError(
        pendingDriverCleanupFailures,
        'close'
      );
    }

    try {
      await this._releaseActiveDriver();
    } catch (error) {
      cleanupError ??= toLocalSpaceError(
        error,
        'OPERATION_FAILED',
        'Failed to close LocalSpace driver.',
        { driver: this.driver() ?? undefined, operation: 'close' }
      );
    }

    if (cleanupError) {
      throw cleanupError;
    }
  }

  driver(): string | null {
    return this._driver || null;
  }

  async getDriver(driverName: string): Promise<Driver> {
    const driver = this._driverRegistry.get(driverName);
    if (driver) return driver as Driver;
    throw createLocalSpaceError('DRIVER_NOT_FOUND', 'Driver not found.', {
      driver: driverName,
    });
  }

  async getSerializer(): Promise<Serializer> {
    return serializer;
  }

  async ready(): Promise<void> {
    this.#configurationLocked = true;
    this._assertNotLifecycleReentrant('ready');
    this._assertOpen('ready');
    const driverInitialization =
      this._driverTransition ??
      this._driverSet ??
      this._pendingDriverInitialization ??
      Promise.resolve();

    const promise = driverInitialization.then(() => {
      this._assertOpen('ready');
      if (this._ready === null) {
        this._ready = this._initDriver ? this._initDriver() : Promise.resolve();
      }
      return this._ready!;
    });

    return promise;
  }

  async setDriver(drivers: string | string[]): Promise<void> {
    this._assertNotLifecycleReentrant('setDriver');
    this._assertOpen('setDriver');
    const isDefaultDriverSelection = this._isRunningDefaultDriverSelection;
    if (!isDefaultDriverSelection) {
      this._assertLifecycleIdle('setDriver');
    }
    // Wait for driver initialization to complete before checking support
    // Skip waiting if this is being called from _runDefaultDriverSelection to avoid deadlock
    if (this._pendingDriverInitialization && !isDefaultDriverSelection) {
      await this._pendingDriverInitialization.catch(() => undefined);
      this._assertOpen('setDriver');
    }

    if (this._driverTransition) {
      await this._driverTransition.catch(() => undefined);
      this._assertOpen('setDriver');
    }

    if (!isDefaultDriverSelection) {
      this._manualDriverOverride = true;
    }

    if (!isArray(drivers)) {
      drivers = [drivers];
    }

    const requestedDrivers = drivers as string[];
    const supportedDrivers =
      await this._resolveSupportedDrivers(requestedDrivers);
    this._assertOpen('setDriver');
    if (this._driverTransition) {
      await this._driverTransition.catch(() => undefined);
      this._assertOpen('setDriver');
    }
    if (!isDefaultDriverSelection) {
      this._assertLifecycleIdle('setDriver');
    }
    if (supportedDrivers.length === 0) {
      const error = createDriverUnavailableError(requestedDrivers);
      const rejection = Promise.resolve().then<never>(() => {
        throw error;
      });
      this._driverSet = rejection;
      return rejection;
    }

    const previousInitialization = this._ready;
    const previousDriverSet = this._driverSet;

    const setDriverToConfig = () => {
      this.#config.driver = this.driver() ?? undefined;
    };

    const extendSelfWithDriver = async (driver: Driver) => {
      const session = this._createDriverSession(driver);
      this._activeDriverSession = session;
      this._driverInitialized = false;
      this._capabilitiesSnapshot = null;
      this._driver = driver._driver;
      setDriverToConfig();

      try {
        await session.initialize();
        session.syncFacade();
        this._capabilitiesSnapshot = session.resolveCapabilities();
        this._driverInitialized = true;
      } catch (error) {
        if (session.close) {
          const failedInitializationCleanup: DriverCleanup = {
            driver: driver._driver,
            close: session.close,
          };
          try {
            await failedInitializationCleanup.close();
          } catch {
            // Preserve the initialization failure that triggered cleanup.
            this._pendingDriverCleanups.push(failedInitializationCleanup);
          }
        }
        if (this._activeDriverSession === session) {
          this._activeDriverSession = null;
        }
        this._driverInitialized = false;
        this._capabilitiesSnapshot = null;
        this._dbInfo = null;
        throw error;
      }
    };

    const initDriver = (supportedDrivers: string[]) => {
      return async () => {
        let currentDriverIndex = 0;
        const failures: DriverInitializationFailure[] = [];

        const driverPromiseLoop = async (): Promise<void> => {
          while (currentDriverIndex < supportedDrivers.length) {
            const driverName = supportedDrivers[currentDriverIndex];
            currentDriverIndex++;

            this._dbInfo = null;

            try {
              const driver = await this.getDriver(driverName);
              await extendSelfWithDriver(driver);
              return;
            } catch (error) {
              failures.push({ driver: driverName, error });
              if (this._closed) {
                throw this._closedError('ready');
              }
            }
          }

          setDriverToConfig();
          const error = createDriverUnavailableError(
            supportedDrivers,
            failures
          );
          throw error;
        };

        return driverPromiseLoop();
      };
    };

    let resumeOperations!: () => void;
    const operationPause = new Promise<void>((resolve) => {
      resumeOperations = resolve;
    });
    this._operationPause = operationPause;

    const transitionRun = async () => {
      if (previousDriverSet) {
        await previousDriverSet.catch(() => undefined);
      }
      if (previousInitialization) {
        await previousInitialization.catch(() => undefined);
      }

      const isInitialDefaultSelection =
        isDefaultDriverSelection &&
        !previousInitialization &&
        !this._driverInitialized;
      if (!isInitialDefaultSelection) {
        await this._drainActiveOperations();
      }

      const pendingDriverCleanupFailures =
        await this._retryPendingDriverCleanups();
      if (pendingDriverCleanupFailures.length > 0) {
        throw this._createPendingDriverCleanupError(
          pendingDriverCleanupFailures,
          'setDriver'
        );
      }

      try {
        await this._releaseActiveDriver();
      } catch (error) {
        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to release the current LocalSpace driver.',
          { driver: this.driver() ?? undefined, operation: 'setDriver' }
        );
      }

      this._assertOpen('setDriver');
      const driverName = supportedDrivers[0];
      this._dbInfo = null;
      this._ready = null;

      const driver = await this.getDriver(driverName);
      this._driver = driver._driver;
      setDriverToConfig();
      this._initDriver = initDriver(supportedDrivers);
    };

    let transition!: Promise<void>;
    transition = transitionRun()
      .catch((cause) => {
        setDriverToConfig();
        if (
          cause instanceof LocalSpaceError &&
          cause.details?.operation === 'setDriver'
        ) {
          throw cause;
        }
        const error = createDriverUnavailableError(supportedDrivers, [
          {
            driver: supportedDrivers[0] ?? 'unknown',
            error: cause,
          },
        ]);
        throw error;
      })
      .finally(() => {
        this._driverSet = transition;
        if (this._operationPause === operationPause) {
          this._operationPause = null;
        }
        resumeOperations();
        if (this._driverTransition === transition) {
          this._driverTransition = null;
        }
      });

    this._driverTransition = transition;
    return transition;
  }

  supports(driverName: string): boolean {
    return (
      this._driverRegistry.supports(driverName) ||
      this._isDriverForcedByInstanceConfig(driverName)
    );
  }

  private _createDriverSession(definition: Readonly<Driver>): DriverSession {
    const sessionConfig = extend({}, this.#config, {
      driver: definition._driver,
    }) as LocalSpaceConfig;
    const receiverContext: LifecycleReceiverContext = new Map([
      ['_dbInfo', null],
      ['_driver', definition._driver],
      ['_config', sessionConfig],
      ['_defaultConfig', extend({}, this.#defaultConfig)],
      ['driver', () => definition._driver],
      [
        'config',
        (key?: keyof LocalSpaceConfig | LocalSpaceConfig) => {
          const snapshot = createConfigSnapshot(sessionConfig);
          if (typeof key === 'string') {
            return snapshot[key];
          }
          if (key && typeof key === 'object') {
            throw createLocalSpaceError(
              'INVALID_ARGUMENT',
              '`config(options)` was removed in LocalSpace 3.0; pass options at construction.',
              { operation: 'config', reason: 'setter-removed' }
            );
          }
          return snapshot;
        },
      ],
    ]);
    const lifecycleScope = this._createLifecycleScope(
      receiverContext,
      definition
    );
    let session!: DriverSession;
    const syncFacade = () => {
      if (this._activeDriverSession === session) {
        this._dbInfo = (receiverContext.get('_dbInfo') ??
          null) as DbInfo | null;
      }
    };
    const receiver =
      lifecycleScope.instance as unknown as DriverAugmentedInstance;
    const operations = {} as Record<DriverOperation, RawDriverMethod>;
    const supportedOperations = new Set<DriverOperation>();

    for (const operation of DRIVER_OPERATIONS) {
      const configured = definition[operation] as RawDriverMethod | undefined;
      if (typeof configured === 'function') {
        supportedOperations.add(operation);
      }
      const candidate: RawDriverMethod =
        typeof configured === 'function'
          ? (...args: unknown[]) => configured.apply(receiver, args)
          : () =>
              Promise.reject(
                createLocalSpaceError(
                  'UNSUPPORTED_OPERATION',
                  `Method ${operation} is not implemented by the current driver`,
                  { driver: definition._driver, operation }
                )
              );

      operations[operation] = (...args: unknown[]) => {
        try {
          this._assertOpen(operation);
          return Promise.resolve(candidate(...args)).finally(syncFacade);
        } catch (error) {
          return Promise.reject(error);
        }
      };
    }

    session = {
      driver: definition._driver,
      operations: Object.freeze(operations),
      supportedOperations,
      initialize: () =>
        lifecycleScope
          .invoke('driver-init', () =>
            definition._initStorage.call(
              receiver,
              receiverContext.get('_config') as LocalSpaceConfig
            )
          )
          .finally(syncFacade),
      resolveCapabilities: () =>
        resolveDriverCapabilities(
          definition,
          receiver,
          receiverContext.get('_config') as LocalSpaceConfig
        ),
      close:
        typeof definition._closeStorage === 'function'
          ? () =>
              lifecycleScope
                .invoke('driver-close', () =>
                  definition._closeStorage!.call(receiver)
                )
                .finally(syncFacade)
          : null,
      syncFacade,
    };
    return session;
  }

  private _dispatchOperation<T>(
    operation: DriverOperation,
    args: unknown[]
  ): Promise<T> {
    this.#configurationLocked = true;
    return this._runTrackedOperation(operation, args, async () => {
      await this.ready();
      this._assertOpen(operation);

      const session = this._activeDriverSession;
      if (!this._driverInitialized || !session) {
        throw this._notInitializedError(operation);
      }
      this._assertOperationSupported(session, operation);

      const original = session.operations[operation];
      let implementation: RawDriverMethod = original;
      const hasPlugins = this._pluginManager.hasPlugins();

      switch (operation) {
        case 'setItem':
          implementation = hasPlugins
            ? this._createSetItemWrapper(original)
            : this._createSetItemValueValidationWrapper(original);
          break;
        case 'setItems':
          implementation = hasPlugins
            ? this._createSetItemsWrapper(original)
            : this._createSetItemsValueValidationWrapper(original);
          break;
        case 'runTransaction':
          implementation = this._createRunTransactionWrapper(original);
          break;
        case 'getItem':
          implementation = hasPlugins
            ? this._createGetItemWrapper(original)
            : this._createStoredRecordGetItemWrapper(original);
          break;
        case 'getItems':
          implementation = hasPlugins
            ? this._createGetItemsWrapper(original)
            : this._createStoredRecordGetItemsWrapper(original);
          break;
        case 'removeItem':
          if (hasPlugins) {
            implementation = this._createRemoveItemWrapper(original);
          }
          break;
        case 'removeItems':
          if (hasPlugins) {
            implementation = this._createRemoveItemsWrapper(original);
          }
          break;
        case 'iterate': {
          const recordAware = this._createStoredRecordIterateWrapper(original);
          implementation = hasPlugins
            ? this._createStorageTransformGuard(recordAware, operation)
            : recordAware;
          break;
        }
      }

      return implementation(...args);
    }) as Promise<T>;
  }

  private _assertOperationSupported(
    session: DriverSession,
    operation: DriverOperation
  ): void {
    const capability =
      operation === 'runTransaction'
        ? 'transactions'
        : operation === 'dropInstance'
          ? 'dropInstance'
          : undefined;
    const capabilities = this._capabilitiesSnapshot;
    const capabilityAvailable = capability
      ? capabilities?.[capability] === true
      : true;

    if (session.supportedOperations.has(operation) && capabilityAvailable) {
      return;
    }

    throw createLocalSpaceError(
      'UNSUPPORTED_OPERATION',
      `Method ${operation} is not supported by the current driver`,
      {
        driver: session.driver,
        operation,
        reason: session.supportedOperations.has(operation)
          ? 'capability-disabled'
          : 'driver-operation-unavailable',
        ...(capability ? { capability } : {}),
      }
    );
  }

  _runTrackedOperation(
    operation: string,
    args: unknown[],
    executor: () => unknown
  ): Promise<unknown> {
    try {
      this._assertNotLifecycleReentrant(operation);
      this._assertOpen(operation);
    } catch (error) {
      return Promise.reject(error);
    }

    const operationPause = this._operationPause;
    if (operationPause) {
      return operationPause.then(() =>
        this._runTrackedOperation(operation, args, executor)
      );
    }

    let operationPromise: Promise<unknown>;
    this._operationsStarting++;
    try {
      operationPromise = Promise.resolve(executor());
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this._operationsStarting--;
    }

    this._activeOperations.add(operationPromise);
    const stopTracking = () => {
      this._activeOperations.delete(operationPromise);
    };
    void operationPromise.then(stopTracking, stopTracking);
    return operationPromise;
  }

  private _createSetItemWrapper(original: RawDriverMethod) {
    return (async (key: string, value: unknown) => {
      validateStorageValueWrite(value, {
        strict: this.#config.strictValues === true,
        operation: 'setItem',
        key,
      });
      await this._ensurePluginsInitialized('setItem');
      const context = this._pluginManager.createContext('setItem');
      context.operationState.originalValue = value;
      const processedValue = await this._pluginManager.beforeSet(
        key,
        value,
        context
      );
      const driverResult = await original(key, processedValue);
      context.operationState.driverResult = driverResult;
      await this._pluginManager.afterSet(key, processedValue, context);
      const returnValue = (context.operationState.returnValue ??
        context.operationState.originalValue ??
        value) as unknown;
      return returnValue;
    }) as typeof this.setItem;
  }

  private _createSetItemValueValidationWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return (key: string, value: unknown) => {
      validateStorageValueWrite(value, {
        strict: this.#config.strictValues === true,
        operation: 'setItem',
        key,
      });
      return original(key, value);
    };
  }

  private _createGetItemWrapper(original: RawDriverMethod) {
    return (async (
      key: string,
      internalOperation?: PluginInternalOperation
    ) => {
      await this._ensurePluginsInitialized('getItem');
      const context = this._pluginManager.createContext('getItem');
      markPluginInternalOperation(context, internalOperation);
      const targetKey = await this._pluginManager.beforeGet(key, context);
      const driverValue = await original(targetKey);
      const finalValue = await this._pluginManager.afterGet(
        targetKey,
        driverValue as unknown,
        context
      );
      return decodeStoredRecordValue(finalValue);
    }) as typeof this.getItem;
  }

  private _createStoredRecordGetItemWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return async (...args: unknown[]) =>
      decodeStoredRecordValue(await original(...args));
  }

  private _createRemoveItemWrapper(original: RawDriverMethod) {
    return (async (key: string) => {
      await this._ensurePluginsInitialized('removeItem');
      const context = this._pluginManager.createContext('removeItem');
      const targetKey = await this._pluginManager.beforeRemove(key, context);
      await original(targetKey);
      await this._pluginManager.afterRemove(targetKey, context);
    }) as typeof this.removeItem;
  }

  private _createSetItemsWrapper(original: RawDriverMethod) {
    return (async (entries: BatchItems<unknown>) => {
      for (const entry of normalizeBatchEntries(entries)) {
        validateStorageValueWrite(entry.value, {
          strict: this.#config.strictValues === true,
          operation: 'setItems',
          key: entry.key,
        });
      }
      await this._ensurePluginsInitialized('setItems');
      const batchContext = this._pluginManager.createContext('setItems');
      batchContext.operationState.isBatch = true;
      const {
        entries: prepared,
        logicalEntries,
        hasStorageTransforms: preserveLogicalValues,
      } = await this._pluginManager.beforeSetItems(entries, batchContext);
      const normalized = this._pluginManager.normalizeBatch(prepared);
      batchContext.operationState.batchSize = normalized.length;
      const processedEntries: Array<{
        key: string;
        value: unknown;
        context: PluginContext;
      }> = [];

      for (let index = 0; index < normalized.length; index++) {
        const entry = normalized[index];
        const logicalEntry = logicalEntries[index];
        const logicalValue =
          preserveLogicalValues && logicalEntry?.key === entry.key
            ? logicalEntry.value
            : entry.value;
        const entryContext = this._pluginManager.createContext('setItem');
        entryContext.operationState.originalValue = logicalValue;
        entryContext.operationState.isBatch = true;
        entryContext.operationState.batchSize = normalized.length;
        const processedValue = await this._pluginManager.beforeSet(
          entry.key,
          entry.value,
          entryContext
        );
        const entryRecord = {
          key: entry.key,
          value: processedValue,
          context: entryContext,
        };
        processedEntries.push(entryRecord);
      }

      const indexProcessedEntries = () => {
        const entriesByKey = new Map<
          string,
          Array<(typeof processedEntries)[number]>
        >();
        for (const entry of processedEntries) {
          const matchingEntries = entriesByKey.get(entry.key) ?? [];
          matchingEntries.push(entry);
          entriesByKey.set(entry.key, matchingEntries);
        }
        return entriesByKey;
      };

      const driverResponse = (await original(
        processedEntries as unknown as BatchItems<unknown>
      )) as BatchResponse<unknown>;
      const responseEntriesByKey = indexProcessedEntries();
      const afterSetItemsInput = preserveLogicalValues
        ? driverResponse.map((entry) => {
            const matchingEntries = responseEntriesByKey.get(entry.key);
            const processedEntry =
              matchingEntries && matchingEntries.length > 0
                ? matchingEntries.shift()
                : undefined;
            return {
              key: entry.key,
              value: processedEntry
                ? processedEntry.context.operationState.originalValue
                : entry.value,
            };
          })
        : driverResponse;
      const finalized = await this._pluginManager.afterSetItems(
        afterSetItemsInput,
        batchContext
      );

      for (const entry of processedEntries) {
        await this._pluginManager.afterSet(
          entry.key,
          entry.value,
          entry.context
        );
      }

      const finalizedEntriesByKey = indexProcessedEntries();
      const finalReturn = finalized.map((entry) => {
        const matchingEntries = finalizedEntriesByKey.get(entry.key);
        const processedEntry =
          matchingEntries && matchingEntries.length > 0
            ? matchingEntries.shift()
            : undefined;
        const contextualValue =
          processedEntry?.context.operationState.returnValue;
        const value =
          typeof contextualValue !== 'undefined'
            ? contextualValue
            : preserveLogicalValues
              ? entry.value
              : typeof entry.value !== 'undefined'
                ? entry.value
                : (processedEntry?.context.operationState.originalValue ??
                  processedEntry?.value);
        return { key: entry.key, value };
      });

      return finalReturn;
    }) as typeof this.setItems;
  }

  private _createSetItemsValueValidationWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return (entries: BatchItems<unknown>) => {
      for (const entry of normalizeBatchEntries(entries)) {
        validateStorageValueWrite(entry.value, {
          strict: this.#config.strictValues === true,
          operation: 'setItems',
          key: entry.key,
        });
      }
      return original(entries);
    };
  }

  private _createGetItemsWrapper(original: RawDriverMethod) {
    return (async (
      keys: string[],
      internalOperation?: PluginInternalOperation
    ) => {
      await this._ensurePluginsInitialized('getItems');
      const batchContext = this._pluginManager.createContext('getItems');
      markPluginInternalOperation(batchContext, internalOperation);
      batchContext.operationState.isBatch = true;
      batchContext.operationState.batchSize = keys.length;
      const requestedKeys = await this._pluginManager.beforeGetItems(
        keys,
        batchContext
      );
      const entryContexts: Array<{
        requestedKey: string;
        targetKey: string;
        context: PluginContext;
      }> = [];
      const targetToRequested = new Map<string, string>();

      for (const key of requestedKeys) {
        const entryContext = this._pluginManager.createContext('getItem');
        entryContext.operationState.isBatch = true;
        entryContext.operationState.batchSize = requestedKeys.length;
        const targetKey = await this._pluginManager.beforeGet(
          key,
          entryContext
        );
        targetToRequested.set(targetKey, key);
        entryContexts.push({
          requestedKey: key,
          targetKey,
          context: entryContext,
        });
      }

      const targetKeys = entryContexts.map((entry) => entry.targetKey);
      const driverResponse = (await original(
        targetKeys
      )) as BatchResponse<unknown>;
      const processedEntries: BatchResponse<unknown> = [];

      for (let i = 0; i < driverResponse.length; i++) {
        const entry = driverResponse[i];
        const context =
          entryContexts[i]?.context ??
          entryContexts.find((candidate) => candidate.targetKey === entry.key)
            ?.context ??
          this._pluginManager.createContext('getItem');
        context.operationState.isBatch = true;
        context.operationState.batchSize = requestedKeys.length;
        const processedValue = await this._pluginManager.afterGet(
          entry.key,
          entry.value,
          context
        );
        processedEntries.push({ key: entry.key, value: processedValue });
      }

      const finalEntries = await this._pluginManager.afterGetItems(
        processedEntries,
        batchContext
      );
      return finalEntries.map((entry) => {
        const requestedKey = targetToRequested.get(entry.key) ?? entry.key;
        return {
          key: requestedKey,
          value: decodeStoredRecordValue(entry.value),
        };
      });
    }) as typeof this.getItems;
  }

  private _createStoredRecordGetItemsWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return async (...args: unknown[]) => {
      const entries = (await original(...args)) as BatchResponse<unknown>;
      return entries.map((entry) => ({
        key: entry.key,
        value: decodeStoredRecordValue(entry.value),
      }));
    };
  }

  private _createRemoveItemsWrapper(original: RawDriverMethod) {
    return (async (keys: string[]) => {
      await this._ensurePluginsInitialized('removeItems');
      const batchContext = this._pluginManager.createContext('removeItems');
      batchContext.operationState.isBatch = true;
      batchContext.operationState.batchSize = keys.length;
      const requestedKeys = await this._pluginManager.beforeRemoveItems(
        keys,
        batchContext
      );
      const processedKeys: Array<{ key: string; context: PluginContext }> = [];

      for (const key of requestedKeys) {
        const entryContext = this._pluginManager.createContext('removeItem');
        entryContext.operationState.isBatch = true;
        entryContext.operationState.batchSize = requestedKeys.length;
        const processedKey = await this._pluginManager.beforeRemove(
          key,
          entryContext
        );
        processedKeys.push({ key: processedKey, context: entryContext });
      }

      const keyList = processedKeys.map((entry) => entry.key);
      await original(keyList);
      await this._pluginManager.afterRemoveItems(keyList, batchContext);

      for (const entry of processedKeys) {
        await this._pluginManager.afterRemove(entry.key, entry.context);
      }
    }) as typeof this.removeItems;
  }

  private _createStorageTransformGuard(
    original: RawDriverMethod,
    operation: 'iterate' | 'runTransaction'
  ): RawDriverMethod {
    return async (...args: unknown[]) => {
      this._assertOpen(operation);
      this._pluginManager.assertNoStorageTransformBypass(operation);
      return original(...args);
    };
  }

  private _createStoredRecordIterateWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return (
      iterator: (
        value: unknown,
        key: string,
        iterationNumber: number
      ) => unknown
    ) =>
      original((value: unknown, key: string, iterationNumber: number) =>
        iterator(decodeStoredRecordValue(value), key, iterationNumber)
      );
  }

  private _createRunTransactionWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return async (
      mode: TransactionMode,
      runner: (scope: TransactionScope) => unknown
    ) => {
      this._assertOpen('runTransaction');
      this._pluginManager.assertNoStorageTransformBypass('runTransaction');

      return original(mode, (scope: TransactionScope) => {
        const validatingScope: TransactionScope = {
          ...scope,
          get: async <T>(key: string) =>
            decodeStoredRecordValue(await scope.get<T>(key)) as T | null,
          set: <T>(key: string, value: T) => {
            validateStorageValueWrite(value, {
              strict: this.#config.strictValues === true,
              operation: 'runTransaction',
              key,
            });
            return scope.set(key, value);
          },
          iterate: <T, U>(
            iterator: (value: T, key: string, iterationNumber: number) => U
          ) =>
            scope.iterate<T, U>((value, key, iterationNumber) =>
              iterator(
                decodeStoredRecordValue(value) as T,
                key,
                iterationNumber
              )
            ),
        };
        return runner(validatingScope);
      });
    };
  }

  private async _ensurePluginsInitialized(
    operation: PluginOperation
  ): Promise<void> {
    this._assertOpen(operation);
    await this._pluginManager.ensureInitialized();
    this._assertOpen(operation);
  }

  _getSupportedDrivers(drivers: string[]): string[] {
    const supportedDrivers: string[] = [];
    for (const driverName of drivers) {
      if (
        this.supports(driverName) ||
        this._isDriverForcedByInstanceConfig(driverName)
      ) {
        supportedDrivers.push(driverName);
      }
    }
    return supportedDrivers;
  }

  private _isDriverForcedByInstanceConfig(driverName: string): boolean {
    return (
      driverName === this.REACTNATIVEASYNCSTORAGE &&
      !!this.#config.reactNativeAsyncStorage
    );
  }

  private async _resolveSupportedDrivers(drivers: string[]): Promise<string[]> {
    const supportedDrivers: string[] = [];
    for (const driverName of drivers) {
      if (!this._driverRegistry.has(driverName)) {
        continue;
      }

      const supported = await this._driverRegistry
        .resolveSupport(driverName)
        .catch(() => false);

      if (
        (supported && this.supports(driverName)) ||
        this._isDriverForcedByInstanceConfig(driverName)
      ) {
        supportedDrivers.push(driverName);
      }
    }
    return supportedDrivers;
  }

  private async _drainActiveOperations(): Promise<void> {
    while (this._activeOperations.size > 0) {
      await Promise.allSettled([...this._activeOperations]);
    }
  }

  private _assertLifecycleIdle(operation: 'close' | 'setDriver'): void {
    if (this._operationsStarting === 0 && this._activeOperations.size === 0) {
      return;
    }

    throw createLocalSpaceError(
      'OPERATION_FAILED',
      `Cannot ${operation} while storage operations are active.`,
      { operation, reason: 'active-operations' }
    );
  }

  private _createLifecycleInvocation(
    lifecycle: LifecycleCallback
  ): LifecycleInvocation<this> {
    const scope = this._createLifecycleScope();
    return {
      instance: scope.instance,
      invoke: <T>(callback: () => T): Promise<Awaited<T>> =>
        scope.invoke(lifecycle, callback),
    };
  }

  private _createLifecycleScope(
    receiverContext?: LifecycleReceiverContext,
    definition?: Readonly<Driver>
  ): LifecycleScope<this> {
    const activeInvocations: ActiveLifecycleInvocation[] = [];
    const forwardedMethods = new Map<
      PropertyKey,
      (...args: unknown[]) => unknown
    >();
    const getActiveInvocation = () =>
      activeInvocations[activeInvocations.length - 1];
    const instance = new Proxy(this, {
      get: (target, property, receiver) => {
        if (
          typeof property === 'string' &&
          LifecycleReentrantMethods.has(property)
        ) {
          const contextualValue = receiverContext?.has(property)
            ? receiverContext.get(property)
            : Reflect.get(target, property, target);
          if (typeof contextualValue === 'function') {
            const callbackReceiver = receiverContext?.has(property)
              ? receiver
              : target;
            return (...args: unknown[]) => {
              const invocation = getActiveInvocation();
              if (invocation) {
                return Promise.reject(
                  target._lifecycleReentryError(property, invocation.lifecycle)
                );
              }
              return contextualValue.apply(callbackReceiver, args);
            };
          }
        }
        if (receiverContext?.has(property)) {
          return receiverContext.get(property);
        }
        if (definition && property in definition) {
          return Reflect.get(definition, property, receiver);
        }
        const value = Reflect.get(
          target,
          property,
          receiverContext ? target : receiver
        );
        if (receiverContext && typeof value === 'function') {
          const existing = forwardedMethods.get(property);
          if (existing) return existing;
          const forwarded = (...args: unknown[]) => value.apply(target, args);
          forwardedMethods.set(property, forwarded);
          return forwarded;
        }
        return value;
      },
      set: (target, property, value, receiver) => {
        if (receiverContext) {
          receiverContext.set(property, value);
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
    });
    return {
      instance,
      invoke: async <T>(
        lifecycle: LifecycleCallback,
        callback: () => T
      ): Promise<Awaited<T>> => {
        const token = {};
        activeInvocations.push({ token, lifecycle });
        try {
          return await this._invokeLifecycleCallback(lifecycle, callback);
        } finally {
          const index = activeInvocations.findIndex(
            (invocation) => invocation.token === token
          );
          if (index !== -1) {
            activeInvocations.splice(index, 1);
          }
        }
      },
    };
  }

  private _invokeLifecycleCallback<T>(
    lifecycle: LifecycleCallback,
    callback: () => T
  ): T {
    const previousLifecycle = this._invokingLifecycleCallback;
    this._invokingLifecycleCallback = lifecycle;
    try {
      return callback();
    } finally {
      this._invokingLifecycleCallback = previousLifecycle;
    }
  }

  private _assertNotLifecycleReentrant(operation: string): void {
    if (!this._invokingLifecycleCallback) {
      return;
    }
    throw this._lifecycleReentryError(
      operation,
      this._invokingLifecycleCallback
    );
  }

  private _lifecycleReentryError(
    operation: string,
    lifecycle: LifecycleCallback
  ): LocalSpaceError {
    return createLocalSpaceError(
      'OPERATION_FAILED',
      `Cannot call ${operation} from a LocalSpace lifecycle callback.`,
      { operation, reason: 'lifecycle-reentrancy', lifecycle }
    );
  }

  private _runDefaultDriverSelection(): Promise<void> {
    if (this._manualDriverOverride) {
      return this._driverSet ?? Promise.resolve();
    }

    this._isRunningDefaultDriverSelection = true;
    try {
      return this.setDriver(this.#config.driver!);
    } finally {
      this._isRunningDefaultDriverSelection = false;
    }
  }

  private _notInitializedError(operation: string): LocalSpaceError {
    return createLocalSpaceError(
      'DRIVER_NOT_INITIALIZED',
      'Driver not initialized',
      { operation }
    );
  }

  private async _releaseActiveDriver(): Promise<void> {
    if (!this._driverInitialized) {
      this._activeDriverSession = null;
      this._capabilitiesSnapshot = null;
      this._dbInfo = null;
      return;
    }

    const session = this._activeDriverSession;
    if (session?.close) {
      await session.close();
    }

    this._activeDriverSession = null;
    this._driverInitialized = false;
    this._capabilitiesSnapshot = null;
    this._dbInfo = null;
  }

  private async _retryPendingDriverCleanups(): Promise<DriverCleanupFailure[]> {
    const pendingCleanups = this._pendingDriverCleanups;
    this._pendingDriverCleanups = [];
    const failures: DriverCleanupFailure[] = [];

    for (const cleanup of pendingCleanups) {
      try {
        await this._invokeRetainedDriverCleanup(cleanup);
      } catch (error) {
        this._pendingDriverCleanups.push(cleanup);
        failures.push({ ...cleanup, error });
      }
    }

    return failures;
  }

  private async _invokeRetainedDriverCleanup(
    cleanup: DriverCleanup
  ): Promise<void> {
    await cleanup.close();
  }

  private _createPendingDriverCleanupError(
    failures: DriverCleanupFailure[],
    operation: 'close' | 'setDriver'
  ): LocalSpaceError {
    const [failure] = failures;
    return toLocalSpaceError(
      failure.error,
      'OPERATION_FAILED',
      'Failed to release a LocalSpace driver after initialization failed.',
      {
        driver: failure.driver,
        operation,
        reason: 'driver-initialization-cleanup',
        pendingDrivers: failures.map(({ driver }) => driver),
      }
    );
  }

  private _closedError(operation: string): LocalSpaceError {
    return createLocalSpaceError(
      'INSTANCE_CLOSED',
      'LocalSpace instance is closed.',
      { operation }
    );
  }

  _assertOpen(operation: string): void {
    if (this._closed) {
      throw this._closedError(operation);
    }
  }
}
