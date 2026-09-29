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
  StorageValue,
  StorageValueInput,
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
  isPluginValueHidden,
  markPluginInternalOperation,
  setPluginStoredValueRemover,
  type PluginBackgroundTaskPause,
  type PluginInternalOperation,
} from './core/plugin-capabilities.js';
import {
  normalizeStorageValue,
  storedValuesEqual,
  validateStorageValueWrite,
} from './core/storage-value.js';
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
import { runDriverTransactionScopeOperation } from './core/transaction-scope.js';

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

type StorageValueWriteOperation = 'setItem' | 'setItems' | 'runTransaction';

type StorageValueWriteDetails = {
  operation: StorageValueWriteOperation;
  key?: string;
  valueSource?: 'application' | 'plugin-output';
  plugin?: string;
  allowReservedPluginEnvelope?: boolean;
};

const acceptStorageValueWrite = (
  value: unknown,
  context: StorageValueWriteDetails
): StorageValue => {
  validateStorageValueWrite(value, context);
  return value;
};

const prepareStorageValueWrite = (
  value: unknown,
  context: StorageValueWriteDetails
): StorageValue =>
  normalizeStorageValue(acceptStorageValueWrite(value, context));

const validatePluginStorageValueBatch = (
  entries: BatchItems<StorageValue>,
  plugin: LocalSpacePlugin,
  allowReservedPluginEnvelope: boolean = false
): BatchItems<StorageValue> => {
  for (const entry of normalizeBatchEntries(entries)) {
    acceptStorageValueWrite(entry.value, {
      operation: 'setItems',
      key: entry.key,
      valueSource: 'plugin-output',
      plugin: plugin.name,
      allowReservedPluginEnvelope,
    });
  }
  return entries;
};

const prepareStorageValueBatch = (
  entries: BatchItems<unknown>,
  context: {
    valueSource?: 'application' | 'plugin-output';
    plugin?: string;
  } = {}
): Array<{ key: string; value: StorageValue }> => {
  const normalized = normalizeBatchEntries(entries);
  for (const entry of normalized) {
    validateStorageValueWrite(entry.value, {
      operation: 'setItems',
      key: entry.key,
      ...context,
    });
  }
  return normalized.map(({ key, value }) => ({
    key,
    value: normalizeStorageValue(value as StorageValue),
  }));
};

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
  facadeOperations: Readonly<Record<DriverOperation, RawDriverMethod>>;
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
  /**
   * Mirror of the active driver's `_dbInfo`, matching the field name drivers
   * assign on their own receiver. Nothing in LocalSpace reads it; it exists so
   * driver-level tests can inspect connection state. It is intentionally absent
   * from `LocalSpaceInstance` and from `PluginContext` — plugins get `driver`
   * and the immutable `config` snapshot instead of driver internals.
   *
   * @internal
   */
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
  private _activeTransactionRunners = 0;
  // Covers the complete admitted dispatch, including plugin observers.
  private _claimedTransactionWindows = 0;
  private _invokingLifecycleCallback: LifecycleCallback | null = null;
  private _pluginManager: PluginManager;
  private readonly _driverRegistry = new DriverRegistry(globalDriverRegistry);

  constructor(options?: LocalSpaceOptions) {
    if (
      options !== undefined &&
      (!options || typeof options !== 'object' || Array.isArray(options))
    ) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'LocalSpace options must be an object.',
        { configKey: 'options', reason: 'invalid-options' }
      );
    }
    const { plugins = [], drivers = [], ...configOverrides } = options ?? {};
    if (!Array.isArray(plugins)) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'Configuration option "plugins" must be an array.',
        { configKey: 'plugins', reason: 'invalid-plugin-list' }
      );
    }
    if (!Array.isArray(drivers)) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'Configuration option "drivers" must be an array.',
        { configKey: 'drivers', reason: 'invalid-driver-list' }
      );
    }
    const normalizedOverrides = normalizeConfigOptions(configOverrides);

    this.#defaultConfig = extend({}, DefaultConfig);
    this.#config = extend({}, this.#defaultConfig, normalizedOverrides);
    this._pluginManager = new PluginManager(this, plugins, {
      createInvocation: (lifecycle) =>
        this._createLifecycleInvocation(lifecycle),
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

  iterate: LocalSpaceInstance['iterate'] = ((...args: unknown[]) =>
    this._dispatchOperation(
      'iterate',
      args
    )) as LocalSpaceInstance['iterate'];

  key = (keyIndex: number): Promise<string | null> =>
    Number.isSafeInteger(keyIndex)
      ? this._dispatchOperation<string | null>('key', [keyIndex])
      : Promise.reject(
          createLocalSpaceError(
            'INVALID_ARGUMENT',
            'key() index must be a safe integer.',
            { operation: 'key', reason: 'invalid-key-index', keyIndex }
          )
        );

  keys: LocalSpaceInstance['keys'] = ((
    internalOperation?: PluginInternalOperation
  ) =>
    this._dispatchOperation('keys', [
      internalOperation,
    ])) as LocalSpaceInstance['keys'];

  length = (): Promise<number> => this._dispatchOperation('length', []);

  removeItem = (key: string): Promise<void> =>
    this._dispatchOperation('removeItem', [key]);

  removeItems = (keys: string[]): Promise<void> =>
    this._dispatchOperation('removeItems', [keys]);

  runTransaction = <T>(
    mode: TransactionMode,
    runner: (scope: TransactionScope) => Promise<T> | T
  ): Promise<T> => this._dispatchOperation<T>('runTransaction', [mode, runner]);

  setItem: LocalSpaceInstance['setItem'] = ((...args: unknown[]) =>
    this._dispatchOperation(
      'setItem',
      args
    )) as LocalSpaceInstance['setItem'];

  setItems: LocalSpaceInstance['setItems'] = ((...args: unknown[]) =>
    this._dispatchOperation(
      'setItems',
      args
    )) as LocalSpaceInstance['setItems'];

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

  async getDriver(driverName: string): Promise<Readonly<Driver>> {
    const driver = this._driverRegistry.get(driverName);
    if (driver) return driver;
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
              if (
                this.#config.bucket?.name &&
                driverName === DefaultDrivers.INDEXEDDB._driver
              ) {
                throw error;
              }
              if (driverName === this.REACTNATIVEASYNCSTORAGE) {
                throw error;
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
    // Mirrors the active driver's `_dbInfo` onto the instance for white-box
    // tests. Drivers only ever assign `_dbInfo` inside `_initStorage()`, and
    // the mirror holds the same object reference afterwards, so lifecycle
    // transitions are the only points that need to re-read it; operations
    // mutate that object in place and stay visible without any resync.
    const syncFacade = () => {
      if (this._activeDriverSession === session) {
        const dbInfo = (receiverContext.get('_dbInfo') ?? null) as DbInfo | null;
        if (this._dbInfo !== dbInfo) {
          this._dbInfo = dbInfo;
        }
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
          return Promise.resolve(candidate(...args));
        } catch (error) {
          return Promise.reject(error);
        }
      };
    }

    const frozenOperations = Object.freeze(operations);
    session = {
      driver: definition._driver,
      operations: frozenOperations,
      facadeOperations: this._createFacadeOperations(frozenOperations),
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

  private _createFacadeOperations(
    operations: Readonly<Record<DriverOperation, RawDriverMethod>>
  ): Readonly<Record<DriverOperation, RawDriverMethod>> {
    // Driver sessions are created only after ready() locks plugin registration,
    // so this dispatch graph remains valid for the complete session lifetime.
    const hasPlugins = this._pluginManager.hasPlugins();
    const facadeOperations = { ...operations };

    facadeOperations.setItem = hasPlugins
      ? this._createSetItemWrapper(operations.setItem)
      : this._createSetItemValueValidationWrapper(operations.setItem);
    facadeOperations.setItems = hasPlugins
      ? this._createSetItemsWrapper(operations.setItems)
      : this._createSetItemsValueValidationWrapper(operations.setItems);
    facadeOperations.runTransaction = this._createRunTransactionWrapper(
      operations.runTransaction
    );
    facadeOperations.iterate = this._createIterateWrapper(
      operations.iterate,
      hasPlugins
    );
    facadeOperations.dropInstance = hasPlugins
      ? this._createDropInstanceWrapper(operations.dropInstance)
      : async (options?: LocalSpaceConfig) =>
          operations.dropInstance(
            options ? normalizeConfigOptions(options) : undefined
          );

    if (hasPlugins) {
      facadeOperations.clear = this._createClearWrapper(operations.clear);
      facadeOperations.getItem = this._createGetItemWrapper(
        operations.getItem
      );
      facadeOperations.getItems = this._createGetItemsWrapper(
        operations.getItems
      );
      facadeOperations.removeItem = this._createRemoveItemWrapper(
        operations.removeItem
      );
      facadeOperations.removeItems = this._createRemoveItemsWrapper(
        operations.removeItems
      );
      facadeOperations.keys = this._createKeysWrapper(
        operations.keys,
        operations.iterate
      );
      facadeOperations.key = this._createKeyWrapper(
        operations.key,
        operations.iterate
      );
      facadeOperations.length = this._createLengthWrapper(
        operations.length,
        operations.iterate
      );
    }

    return Object.freeze(facadeOperations);
  }

  private _dispatchOperation<T>(
    operation: DriverOperation,
    args: unknown[]
  ): Promise<T> {
    const isTransaction = operation === 'runTransaction';
    if (this._claimedTransactionWindows > 0) {
      return Promise.reject(this._transactionScopeRequiredError(operation));
    }

    this.#configurationLocked = true;
    const executor = async () => {
      await this.ready();
      this._assertOpen(operation);

      if (this._claimedTransactionWindows > 0) {
        throw this._transactionScopeRequiredError(operation);
      }

      const session = this._activeDriverSession;
      if (!this._driverInitialized || !session) {
        throw this._notInitializedError(operation);
      }
      this._assertOperationSupported(session, operation);
      if (isTransaction) {
        this._assertTransactionArguments(session, args);
      }

      const implementation = session.facadeOperations[operation];

      if (!isTransaction) {
        return implementation(...args);
      }

      this._claimedTransactionWindows += 1;
      try {
        return await implementation(...args);
      } finally {
        this._claimedTransactionWindows -= 1;
      }
    };

    return this._runTrackedOperation(operation, args, executor) as Promise<T>;
  }

  private _transactionScopeRequiredError(
    operation: DriverOperation
  ): LocalSpaceError {
    return createLocalSpaceError(
      'TRANSACTION_SCOPE_REQUIRED',
      `Use the transaction scope for ${operation}() while a transaction is active.`,
      {
        operation,
        reason: 'transaction-scope-required',
      }
    );
  }

  private _assertTransactionArguments(
    session: DriverSession,
    args: unknown[]
  ): void {
    const [mode, runner] = args;
    if (mode !== 'readonly' && mode !== 'readwrite') {
      throw createLocalSpaceError(
        'INVALID_ARGUMENT',
        `Unsupported transaction mode: ${String(mode)}`,
        {
          driver: session.driver,
          operation: 'runTransaction',
          reason: 'invalid-transaction-mode',
          transactionMode: String(mode),
        }
      );
    }
    if (typeof runner !== 'function') {
      throw createLocalSpaceError(
        'INVALID_ARGUMENT',
        'Transaction runner must be a function.',
        {
          driver: session.driver,
          operation: 'runTransaction',
          reason: 'invalid-transaction-runner',
        }
      );
    }
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

  private _runTrackedOperation(
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

  private _createSetItemWrapper(
    original: RawDriverMethod,
    transactionScope?: TransactionScope
  ) {
    return (async (key: string, value: unknown) => {
      const logicalValue = prepareStorageValueWrite(value, {
        operation: 'setItem',
        key,
      });
      await this._ensurePluginsInitialized('setItem');
      const context = this._pluginManager.createContext(
        'setItem',
        undefined,
        transactionScope
      );
      const processedLogicalValue = await this._pluginManager.beforeSet(
        key,
        logicalValue,
        context,
        (pluginValue, plugin) =>
          acceptStorageValueWrite(pluginValue, {
            operation: 'setItem',
            key,
            valueSource: 'plugin-output',
            plugin: plugin.name,
          }),
        'logical'
      );
      const processedValue = await this._pluginManager.beforeSet(
        key,
        processedLogicalValue,
        context,
        (pluginValue, plugin) =>
          acceptStorageValueWrite(pluginValue, {
            operation: 'setItem',
            key,
            valueSource: 'plugin-output',
            plugin: plugin.name,
            allowReservedPluginEnvelope: true,
          }),
        'storage-transform'
      );
      const storedValue = normalizeStorageValue(processedValue);
      await original(key, storedValue);
      await this._pluginManager.afterSet(
        key,
        storedValue,
        context,
        'storage-transform'
      );
      await this._pluginManager.afterSet(
        key,
        processedLogicalValue,
        context,
        'logical'
      );
      return logicalValue;
    }) as typeof this.setItem;
  }

  private _createSetItemValueValidationWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return async (key: string, value: unknown) => {
      const canonicalValue = prepareStorageValueWrite(value, {
        operation: 'setItem',
        key,
      });
      await original(key, canonicalValue);
      return canonicalValue;
    };
  }

  private _createGetItemWrapper(
    original: RawDriverMethod,
    transactionScope?: TransactionScope
  ) {
    return (async (
      key: string,
      internalOperation?: PluginInternalOperation
    ) => {
      await this._ensurePluginsInitialized('getItem');
      const context = this._pluginManager.createContext(
        'getItem',
        undefined,
        transactionScope
      );
      markPluginInternalOperation(context, internalOperation);
      const targetKey = await this._pluginManager.beforeGet(key, context);
      const driverValue = await original(targetKey);
      if (!transactionScope) {
        this._trackStoredValues(context, [
          { key: targetKey, value: driverValue },
        ]);
      }
      const logicalValue = await this._pluginManager.afterGet(
        targetKey,
        driverValue as unknown,
        context,
        'storage-transform'
      );
      const result = await this._pluginManager.afterGet(
        targetKey,
        logicalValue,
        context,
        'logical'
      );
      return (await this._pluginManager.isValueVisible(
        targetKey,
        result,
        context
      ))
        ? result
        : null;
    }) as typeof this.getItem;
  }

  private _createRemoveItemWrapper(
    original: RawDriverMethod,
    transactionScope?: TransactionScope
  ) {
    return (async (key: string) => {
      await this._ensurePluginsInitialized('removeItem');
      const context = this._pluginManager.createContext(
        'removeItem',
        undefined,
        transactionScope
      );
      const targetKey = await this._pluginManager.beforeRemove(key, context);
      await original(targetKey);
      await this._pluginManager.afterRemove(targetKey, context);
    }) as typeof this.removeItem;
  }

  private _createSetItemsWrapper(original: RawDriverMethod) {
    return (async (entries: BatchItems<unknown>) => {
      const canonicalEntries = prepareStorageValueBatch(entries);
      await this._ensurePluginsInitialized('setItems');
      const batchContext = this._pluginManager.createContext('setItems');
      batchContext.operationState.isBatch = true;
      const logicalPrepared = await this._pluginManager.beforeSetItems(
        canonicalEntries,
        batchContext,
        {
          role: 'logical',
          prepareBatchOutput: (pluginEntries, plugin) =>
            validatePluginStorageValueBatch(pluginEntries, plugin),
          prepareValueOutput: (value, plugin, key) =>
            normalizeStorageValue(
              acceptStorageValueWrite(value, {
                operation: 'setItems',
                key,
                valueSource: 'plugin-output',
                plugin: plugin.name,
              })
            ),
        }
      );
      const storagePrepared = await this._pluginManager.beforeSetItems(
        logicalPrepared.entries,
        batchContext,
        {
          role: 'storage-transform',
          preserveLogicalValues: true,
          prepareBatchOutput: (pluginEntries, plugin) =>
            validatePluginStorageValueBatch(pluginEntries, plugin, true),
          prepareValueOutput: (value, plugin, key) =>
            normalizeStorageValue(
              acceptStorageValueWrite(value, {
                operation: 'setItems',
                key,
                valueSource: 'plugin-output',
                plugin: plugin.name,
                allowReservedPluginEnvelope: true,
              })
            ),
        }
      );
      if (
        storagePrepared.entries.length !== logicalPrepared.entries.length ||
        storagePrepared.entries.some(
          (entry, index) => entry.key !== logicalPrepared.entries[index]?.key
        )
      ) {
        throw createLocalSpaceError(
          'OPERATION_FAILED',
          'A storage transform changed the batch key order or set.',
          {
            operation: 'setItems',
            reason: 'storage-transform-key-mismatch',
          }
        );
      }

      const driverResponse = (await original(
        storagePrepared.entries
      )) as BatchResponse<StorageValue>;
      await this._pluginManager.afterSetItems(
        driverResponse,
        batchContext,
        storagePrepared.items,
        'storage-transform'
      );
      return this._pluginManager.afterSetItems(
        logicalPrepared.logicalEntries.map(({ key, value }) => ({
          key,
          value,
        })),
        batchContext,
        logicalPrepared.items,
        'logical'
      );
    }) as typeof this.setItems;
  }

  private _createSetItemsValueValidationWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return async (entries: BatchItems<unknown>) => {
      const logicalEntries = prepareStorageValueBatch(entries);
      await original(logicalEntries);
      return logicalEntries;
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
      const prepared = await this._pluginManager.beforeGetItems(
        keys,
        batchContext
      );
      for (const item of prepared.items) {
        markPluginInternalOperation(item.context, internalOperation);
      }
      const driverResponse = (await original(
        prepared.keys
      )) as BatchResponse<unknown>;
      this._trackStoredValues(batchContext, driverResponse);
      const storageResult = await this._pluginManager.afterGetItems(
        driverResponse,
        batchContext,
        prepared.items,
        'storage-transform'
      );
      for (const item of storageResult.items) {
        markPluginInternalOperation(item.context, internalOperation);
      }
      const logicalResult = await this._pluginManager.afterGetItems(
        storageResult.entries,
        batchContext,
        storageResult.items,
        'logical'
      );
      const result: BatchResponse<unknown> = [];
      for (let index = 0; index < logicalResult.entries.length; index++) {
        const entry = logicalResult.entries[index];
        const item = logicalResult.items[index];
        const hiddenByTransform =
          isPluginValueHidden(batchContext, entry.key) ||
          (item ? isPluginValueHidden(item.context, entry.key) : false);
        const visible =
          !hiddenByTransform &&
          (await this._pluginManager.isValueVisible(
            entry.key,
            entry.value,
            item?.context ?? batchContext
          ));
        result.push({
          key: item?.requestedKey ?? entry.key,
          value: visible ? entry.value : null,
        });
      }
      return result;
    }) as typeof this.getItems;
  }

  private _createRemoveItemsWrapper(original: RawDriverMethod) {
    return (async (keys: string[]) => {
      await this._ensurePluginsInitialized('removeItems');
      const batchContext = this._pluginManager.createContext('removeItems');
      batchContext.operationState.isBatch = true;
      batchContext.operationState.batchSize = keys.length;
      const prepared = await this._pluginManager.beforeRemoveItems(
        keys,
        batchContext
      );
      await original(prepared.keys);
      await this._pluginManager.afterRemoveItems(
        prepared.keys,
        batchContext,
        prepared.items
      );
    }) as typeof this.removeItems;
  }

  private _createClearWrapper(
    original: RawDriverMethod,
    transactionScope?: TransactionScope
  ): RawDriverMethod {
    return async () => {
      await this._ensurePluginsInitialized('clear');
      const context = this._pluginManager.createContext(
        'clear',
        undefined,
        transactionScope
      );
      await this._pluginManager.beforeClear(context);
      await original();
      await this._pluginManager.afterClear(context);
    };
  }

  private _createDropInstanceWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return async (options?: LocalSpaceConfig) => {
      const normalizedOptions = options
        ? (normalizeConfigOptions(options) as LocalSpaceConfig)
        : undefined;
      await this._ensurePluginsInitialized('dropInstance');
      const context = this._pluginManager.createContext('dropInstance');
      const optionsSnapshot = normalizedOptions
        ? createConfigSnapshot(normalizedOptions)
        : undefined;
      await this._pluginManager.beforeDropInstance(optionsSnapshot, context);
      await original(normalizedOptions);
      await this._pluginManager.afterDropInstance(optionsSnapshot, context);
    };
  }

  private async _materializeLogicalEntries(
    originalIterate: RawDriverMethod,
    context?: ReturnType<PluginManager['createContext']>,
    internalOperation?: PluginInternalOperation
  ): Promise<Array<{ key: string; value: unknown }>> {
    const storedEntries: BatchResponse<unknown> = [];
    await originalIterate((value: unknown, key: string) => {
      storedEntries.push({ key, value });
      return undefined;
    });

    if (!context) {
      return storedEntries;
    }

    const readContext = this._pluginManager.createContext(
      context.operation ?? 'getItems',
      undefined,
      context.transactionScope
    );
    markPluginInternalOperation(readContext, internalOperation);
    if (!readContext.transactionScope) {
      this._trackStoredValues(readContext, storedEntries);
    }
    const prepared = this._pluginManager.prepareReadItems(
      storedEntries.map(({ key }) => key),
      readContext
    );
    for (const item of prepared.items) {
      markPluginInternalOperation(item.context, internalOperation);
    }
    const operation = readContext.operation ?? 'getItems';
    const storageResult = await this._pluginManager.afterGetItems(
      storedEntries,
      readContext,
      prepared.items,
      'storage-transform',
      operation
    );
    const logicalResult = await this._pluginManager.afterGetItems(
      storageResult.entries,
      readContext,
      storageResult.items,
      'logical',
      operation
    );

    const visibleEntries: Array<{ key: string; value: unknown }> = [];
    for (let index = 0; index < logicalResult.entries.length; index++) {
      const entry = logicalResult.entries[index];
      const item = logicalResult.items[index];
      const candidateKeys = [
        entry.key,
        item?.targetKey,
        item?.requestedKey,
      ].filter((key): key is string => typeof key === 'string');
      const hiddenByTransform = candidateKeys.some(
        (key) =>
          isPluginValueHidden(readContext, key) ||
          (item ? isPluginValueHidden(item.context, key) : false)
      );
      if (
        !hiddenByTransform &&
        (await this._pluginManager.isValueVisible(
          entry.key,
          entry.value,
          item?.context ?? readContext
        ))
      ) {
        visibleEntries.push(entry);
      }
    }
    return visibleEntries;
  }

  private _createKeysWrapper(
    original: RawDriverMethod,
    originalIterate: RawDriverMethod,
    transactionScope?: TransactionScope
  ): RawDriverMethod {
    return async (internalOperation?: PluginInternalOperation) => {
      await this._ensurePluginsInitialized('keys');
      const context = this._pluginManager.createContext(
        'keys',
        undefined,
        transactionScope
      );
      markPluginInternalOperation(context, internalOperation);
      await this._pluginManager.beforeKeys(context);
      const result = this._pluginManager.needsLogicalReadScan()
        ? (
            await this._materializeLogicalEntries(
              originalIterate,
              context,
              internalOperation
            )
          ).map(({ key }) => key)
        : ((await original()) as string[]);
      await this._pluginManager.afterKeys(result, context);
      return result;
    };
  }

  private _createKeyWrapper(
    original: RawDriverMethod,
    originalIterate: RawDriverMethod
  ): RawDriverMethod {
    return async (keyIndex: number) => {
      await this._ensurePluginsInitialized('key');
      const context = this._pluginManager.createContext('key');
      await this._pluginManager.beforeKey(keyIndex, context);
      const result = this._pluginManager.needsLogicalReadScan()
        ? ((await this._materializeLogicalEntries(originalIterate, context))[
            keyIndex
          ]?.key ?? null)
        : ((await original(keyIndex)) as string | null);
      await this._pluginManager.afterKey(keyIndex, result, context);
      return result;
    };
  }

  private _createLengthWrapper(
    original: RawDriverMethod,
    originalIterate: RawDriverMethod
  ): RawDriverMethod {
    return async () => {
      await this._ensurePluginsInitialized('length');
      const context = this._pluginManager.createContext('length');
      await this._pluginManager.beforeLength(context);
      const result = this._pluginManager.needsLogicalReadScan()
        ? (await this._materializeLogicalEntries(originalIterate, context))
            .length
        : ((await original()) as number);
      await this._pluginManager.afterLength(result, context);
      return result;
    };
  }

  private _createIterateWrapper(
    original: RawDriverMethod,
    hasPlugins: boolean,
    transactionScope?: TransactionScope
  ): RawDriverMethod {
    return async <T extends StorageValue, U>(
      iterator: (
        value: T,
        key: string,
        iterationNumber: number
      ) => U | Promise<U>
    ): Promise<U | undefined> => {
      if (!hasPlugins) {
        return original(iterator) as Promise<U | undefined>;
      }

      await this._ensurePluginsInitialized('iterate');
      const context = this._pluginManager.createContext(
        'iterate',
        undefined,
        transactionScope
      );
      await this._pluginManager.beforeIterate(context);

      let iterations = 0;
      let stopped = false;
      const result = (await original(
        async (storedValue: unknown, key: string) => {
          const entryContext = this._pluginManager.createContext(
            'iterate',
            undefined,
            transactionScope
          );
          if (!transactionScope) {
            this._trackStoredValues(entryContext, [
              { key, value: storedValue },
            ]);
          }
          const storageValue = await this._pluginManager.afterGet(
            key,
            storedValue,
            entryContext,
            'storage-transform'
          );
          const logicalValue = await this._pluginManager.afterGet(
            key,
            storageValue,
            entryContext,
            'logical'
          );
          if (
            isPluginValueHidden(entryContext, key) ||
            !(await this._pluginManager.isValueVisible(
              key,
              logicalValue,
              entryContext
            ))
          ) {
            return undefined;
          }

          iterations += 1;
          const callbackResult = await iterator(
            logicalValue as T,
            key,
            iterations
          );
          if (callbackResult !== undefined) {
            stopped = true;
          }
          return callbackResult;
        }
      )) as U | undefined;

      await this._pluginManager.afterIterate({ iterations, stopped }, context);
      return result;
    };
  }

  private _createRunTransactionWrapper(
    original: RawDriverMethod
  ): RawDriverMethod {
    return async (
      mode: TransactionMode,
      runner: (scope: TransactionScope) => unknown
    ) => {
      this._assertOpen('runTransaction');
      const hasPlugins = this._pluginManager.hasPlugins();
      const context = hasPlugins
        ? this._pluginManager.createContext('runTransaction')
        : undefined;
      if (context) {
        await this._ensurePluginsInitialized('runTransaction');
        await this._pluginManager.runTransactionObservers(
          'before',
          mode,
          context
        );
      }

      const result = await original(mode, (scope: TransactionScope) => {
        let scopeActive = true;
        const assertScopeActive = (scopeOperation: string): void => {
          if (scopeActive) {
            return;
          }

          throw createLocalSpaceError(
            'TRANSACTION_SCOPE_REQUIRED',
            'The transaction scope cannot be used after its runner settles.',
            {
              operation: 'runTransaction',
              reason: 'transaction-scope-inactive',
              scopeOperation,
            }
          );
        };
        const validatingScope = {} as TransactionScope;
        const rawGet = ((key: string) => scope.get(key)) as RawDriverMethod;
        const rawSet = ((key: string, value: unknown) =>
          (scope.set as RawDriverMethod)(key, value)) as RawDriverMethod;
        const rawRemove = ((key: string) =>
          scope.remove(key)) as RawDriverMethod;
        const rawKeys = (() => scope.keys()) as RawDriverMethod;
        const rawIterate = ((
          iterator: (
            value: StorageValue,
            key: string,
            iterationNumber: number
          ) => unknown
        ) => scope.iterate(iterator)) as RawDriverMethod;
        const rawClear = (() => scope.clear()) as RawDriverMethod;

        const getOperation = hasPlugins
          ? this._createGetItemWrapper(rawGet, validatingScope)
          : rawGet;
        const setOperation = hasPlugins
          ? this._createSetItemWrapper(rawSet, validatingScope)
          : this._createSetItemValueValidationWrapper(rawSet);
        const removeOperation = hasPlugins
          ? this._createRemoveItemWrapper(rawRemove, validatingScope)
          : rawRemove;
        const keysOperation = hasPlugins
          ? this._createKeysWrapper(rawKeys, rawIterate, validatingScope)
          : rawKeys;
        const iterateOperation = this._createIterateWrapper(
          rawIterate,
          hasPlugins,
          validatingScope
        );
        const clearOperation = hasPlugins
          ? this._createClearWrapper(rawClear, validatingScope)
          : rawClear;

        Object.assign(validatingScope, {
          get: async <T = StorageValue>(key: string) => {
            assertScopeActive('get');
            return runDriverTransactionScopeOperation(
              scope,
              'get',
              () => getOperation(key) as Promise<T | null>
            );
          },
          set: async <T>(
            key: string,
            value: T & StorageValueInput<T>
          ) => {
            assertScopeActive('set');
            return runDriverTransactionScopeOperation(
              scope,
              'set',
              () => setOperation(key, value) as Promise<T>
            );
          },
          remove: async (key: string) => {
            assertScopeActive('remove');
            await runDriverTransactionScopeOperation(scope, 'remove', () =>
              removeOperation(key)
            );
          },
          keys: async () => {
            assertScopeActive('keys');
            return runDriverTransactionScopeOperation(
              scope,
              'keys',
              () => keysOperation() as Promise<string[]>
            );
          },
          iterate: async <T = StorageValue, U = void>(
            iterator: (
              value: T,
              key: string,
              iterationNumber: number
            ) => U | Promise<U>
          ) => {
            assertScopeActive('iterate');
            return runDriverTransactionScopeOperation(
              scope,
              'iterate',
              () => iterateOperation(iterator) as Promise<U | undefined>
            );
          },
          clear: async () => {
            assertScopeActive('clear');
            await runDriverTransactionScopeOperation(scope, 'clear', () =>
              clearOperation()
            );
          },
        } satisfies TransactionScope);

        this._activeTransactionRunners += 1;
        return Promise.resolve()
          .then(() => runner(validatingScope))
          .finally(() => {
            scopeActive = false;
            this._activeTransactionRunners -= 1;
          });
      });

      if (context) {
        await this._pluginManager.runTransactionObservers(
          'after',
          mode,
          context
        );
      }
      return result;
    };
  }

  /**
   * Lets plugins that hide a value they just read (such as TTL expiry) delete
   * it without clobbering a write that landed after the read: each key is only
   * removed while it still holds the value this operation read, atomically
   * when the driver supports transactions.
   */
  private _trackStoredValues(
    context: PluginContext,
    entries: ReadonlyArray<{ key: string; value: unknown }>
  ): void {
    const readValues = new Map(entries.map(({ key, value }) => [key, value]));
    setPluginStoredValueRemover(context, async (keys) => {
      const session = this._activeDriverSession;
      if (!session) {
        throw this._notInitializedError('removeItem');
      }
      const removeUnchanged = async (
        read: (key: string) => Promise<unknown>,
        remove: (key: string) => Promise<unknown>
      ): Promise<string[]> => {
        const removed: string[] = [];
        for (const key of keys) {
          if (
            readValues.has(key) &&
            !storedValuesEqual(await read(key), readValues.get(key))
          ) {
            continue;
          }
          await remove(key);
          removed.push(key);
        }
        return removed;
      };

      if (this._capabilitiesSnapshot?.transactions) {
        return (await session.operations.runTransaction(
          'readwrite',
          (scope: TransactionScope) =>
            runDriverTransactionScopeOperation(scope, 'remove', () =>
              removeUnchanged(
                (key) => scope.get(key),
                (key) => scope.remove(key)
              )
            )
        )) as string[];
      }
      return removeUnchanged(
        (key) => session.operations.getItem(key),
        (key) => session.operations.removeItem(key)
      );
    });
  }

  private async _ensurePluginsInitialized(
    operation: PluginOperation
  ): Promise<void> {
    this._assertOpen(operation);
    await this._pluginManager.ensureInitialized();
    this._assertOpen(operation);
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
    if (
      this._operationsStarting === 0 &&
      this._activeOperations.size === 0 &&
      this._activeTransactionRunners === 0 &&
      this._claimedTransactionWindows === 0
    ) {
      return;
    }

    throw createLocalSpaceError(
      'OPERATION_FAILED',
      `Cannot ${operation} while storage operations are active.`,
      {
        operation,
        reason: 'active-operations',
        activeTransactionRunners: this._activeTransactionRunners,
        claimedTransactionWindows: this._claimedTransactionWindows,
      }
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

  private _assertOpen(operation: string): void {
    if (this._closed) {
      throw this._closedError(operation);
    }
  }
}
