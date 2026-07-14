import type {
  LocalSpaceInstance,
  LocalSpaceConfig,
  LocalSpaceOptions,
  LocalSpacePlugin,
  Driver,
  DbInfo,
  DefinedDriversMap,
  DriverSupportMap,
  Serializer,
  BatchItems,
  BatchResponse,
  TransactionMode,
  TransactionScope,
  PluginContext,
  PluginOperation,
} from './types.js';
import { extend, isArray, includes } from './utils/helpers.js';
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
import { normalizeConfigOptions } from './core/config.js';
import { warnDeprecation } from './utils/deprecations.js';
import type { PluginBackgroundTaskPause } from './core/plugin-capabilities.js';

// Shared drivers across all instances
const DefinedDrivers: DefinedDriversMap = {};
const DriverSupport: DriverSupportMap = {};

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
const PendingDefaultDriverDefinitions: Record<string, Promise<void>> = {};

const OptionalDriverMethods = [
  'dropInstance',
  'setItems',
  'getItems',
  'removeItems',
  'runTransaction',
];

const LibraryMethods = [
  'clear',
  'getItem',
  'getItems',
  'iterate',
  'key',
  'keys',
  'length',
  'removeItem',
  'removeItems',
  'setItem',
  'setItems',
  'runTransaction',
].concat(OptionalDriverMethods);

const PluginAwareMethods = [
  'setItem',
  'getItem',
  'removeItem',
  'setItems',
  'getItems',
  'removeItems',
  'iterate',
  'runTransaction',
] as const;

type PluginAwareMethod = (typeof PluginAwareMethods)[number];
type RawDriverMethod = (...args: any[]) => Promise<unknown>;
const PluginAwareMethodSet = new Set<string>(PluginAwareMethods);

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

type ActiveLifecycleInvocation = {
  token: object;
  lifecycle: LifecycleCallback;
};

const LifecycleReentrantMethods = new Set<string>([
  ...LibraryMethods,
  'ready',
  'setDriver',
  'close',
  'destroy',
]);

const DefaultDriverSet = new Set<Driver>(Object.values(DefaultDrivers));

type DriverInitializationFailure = {
  driver: string;
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
  size: 4980736,
  storeName: 'keyvaluepairs',
  version: 1.0,
  pluginInitPolicy: 'fail',
  pluginErrorPolicy: 'lenient',
};

type ReadyAwareInstance = {
  ready: () => Promise<void>;
  _assertOpen: (operation: string) => void;
  _runTrackedOperation: (
    operation: string,
    args: unknown[],
    executor: () => unknown
  ) => Promise<unknown>;
} & Record<string, unknown>;

type ReadyWrappedMethod = (...args: unknown[]) => unknown;

type DriverAugmentedInstance = ReadyAwareInstance &
  Partial<Driver> & {
    _initStorage?: (config: LocalSpaceConfig) => Promise<void>;
  };

function callWhenReady(
  instance: ReadyAwareInstance,
  libraryMethod: string
): void {
  const readyWrapper = function (...args: unknown[]) {
    return instance._runTrackedOperation(libraryMethod, args, async () => {
      await instance.ready();
      instance._assertOpen(libraryMethod);
      const method = instance[libraryMethod] as ReadyWrappedMethod;
      return method.apply(instance, args);
    });
  } as ReadyWrappedMethod;
  instance[libraryMethod] = readyWrapper;
}

function defineDefaultDriverOnce(
  definer: { defineDriver: (driver: Driver) => Promise<void> },
  driver: Driver
): Promise<void> {
  const driverName = driver._driver;

  if (DefinedDrivers[driverName]) {
    return Promise.resolve();
  }

  const pendingDefinition = PendingDefaultDriverDefinitions[driverName];
  if (pendingDefinition) {
    return pendingDefinition;
  }

  const definitionPromise = definer.defineDriver(driver).finally(() => {
    if (PendingDefaultDriverDefinitions[driverName] === definitionPromise) {
      delete PendingDefaultDriverDefinitions[driverName];
    }
  });
  PendingDefaultDriverDefinitions[driverName] = definitionPromise;
  return definitionPromise;
}

export class LocalSpace implements LocalSpaceInstance {
  readonly INDEXEDDB = 'asyncStorage';
  readonly LOCALSTORAGE = 'localStorageWrapper';
  readonly MEMORY = 'memoryStorageWrapper';
  readonly REACTNATIVEASYNCSTORAGE = 'reactNativeAsyncStorageWrapper';

  _defaultConfig: LocalSpaceConfig;
  _config: LocalSpaceConfig;
  _driverSet: Promise<void> | null = null;
  _pendingDriverInitialization: Promise<void> | null = null;
  _isRunningDefaultDriverSelection = false;
  _manualDriverOverride = false;
  _initDriver: (() => Promise<void>) | null = null;
  _ready: Promise<void> | null = null;
  _dbInfo: DbInfo | null = null;
  _driver?: string;
  private _closed = false;
  private _closePromise: Promise<void> | null = null;
  private _driverInitialized = false;
  private _activeDriverClose: (() => Promise<void>) | null = null;
  private _driverTransition: Promise<void> | null = null;
  private _operationPause: Promise<void> | null = null;
  private _operationsStarting = 0;
  private readonly _activeOperations = new Set<Promise<unknown>>();
  private _invokingLifecycleCallback: LifecycleCallback | null = null;
  private _pluginManager: PluginManager;
  private _rawDriverMethods: Partial<
    Record<PluginAwareMethod, RawDriverMethod>
  > = {};

  constructor(options?: LocalSpaceOptions) {
    const driverInitializationPromises: Promise<void>[] = [];
    const { plugins = [], ...configOverrides } = options ?? {};
    if (Object.prototype.hasOwnProperty.call(configOverrides, 'size')) {
      warnDeprecation(
        'legacy-size-option',
        'the `size` option is ignored by built-in drivers and will be removed in 3.0.'
      );
    }
    const normalizedOverrides = normalizeConfigOptions(configOverrides);

    // Define default drivers
    for (const driverTypeKey in DefaultDrivers) {
      if (Object.prototype.hasOwnProperty.call(DefaultDrivers, driverTypeKey)) {
        const driver =
          DefaultDrivers[driverTypeKey as keyof typeof DefaultDrivers];
        const driverName = driver._driver;
        (this as unknown as Record<string, string>)[driverTypeKey] = driverName;

        driverInitializationPromises.push(
          defineDefaultDriverOnce(this, driver).catch((error) => {
            console.warn(
              `Failed to define LocalSpace driver "${driverName}"`,
              error
            );
          })
        );
      }
    }

    this._defaultConfig = extend({}, DefaultConfig);
    this._config = extend({}, this._defaultConfig, normalizedOverrides);
    this._pluginManager = new PluginManager(this, plugins, {
      createInvocation: (lifecycle) =>
        this._createLifecycleInvocation(lifecycle),
    });

    this._wrapLibraryMethodsWithReady();

    const waitForDrivers =
      driverInitializationPromises.length > 0
        ? Promise.all(driverInitializationPromises).then(() => undefined)
        : Promise.resolve();

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

  config(options: LocalSpaceConfig): true | Error | Promise<void>;
  config<K extends keyof LocalSpaceConfig>(
    key: K
  ): LocalSpaceConfig[K] | undefined;
  config(): LocalSpaceConfig;
  config(optionsOrKey?: LocalSpaceConfig | keyof LocalSpaceConfig) {
    if (typeof optionsOrKey === 'object' && optionsOrKey !== null) {
      if (Object.prototype.hasOwnProperty.call(optionsOrKey, 'size')) {
        warnDeprecation(
          'legacy-size-option',
          'the `size` option is ignored by built-in drivers and will be removed in 3.0.'
        );
      }
      if (this._ready) {
        return createLocalSpaceError(
          'CONFIG_LOCKED',
          "Can't call config() after LocalSpace has been used.",
          { operation: 'config' }
        );
      }

      const suppliedOptions = optionsOrKey as Partial<LocalSpaceConfig>;
      let normalizedOptions: Partial<LocalSpaceConfig>;
      try {
        normalizedOptions = normalizeConfigOptions(suppliedOptions);
      } catch (error) {
        return error instanceof Error
          ? error
          : createLocalSpaceError(
              'INVALID_CONFIG',
              'Invalid LocalSpace configuration.'
            );
      }
      if (typeof normalizedOptions.storeName === 'string') {
        // Preserve the 2.x setter namespace so an unchanged application keeps
        // opening data written before 2.1. Constructor behavior stays as-is;
        // the two entry points are unified only in 3.0 with migration tooling.
        normalizedOptions.storeName = normalizedOptions.storeName.replace(
          /\W/g,
          '_'
        );
      }

      // All validations passed, now apply changes
      const configRecord = this._config as LocalSpaceConfig &
        Record<string, unknown>;

      for (const key of Object.keys(normalizedOptions) as Array<
        keyof LocalSpaceConfig
      >) {
        const value = normalizedOptions[key];

        configRecord[key as string] = value as unknown;
      }

      if (normalizedOptions.driver) {
        return this.setDriver(this._config.driver!);
      }

      return true;
    }

    if (typeof optionsOrKey === 'string') {
      const key = optionsOrKey as keyof LocalSpaceConfig;
      return this._config[key];
    }

    warnDeprecation(
      'mutable-config-reference',
      'mutating the object returned by `config()` is deprecated; pass options to createInstance() instead.'
    );
    return this._config;
  }

  createInstance(options?: LocalSpaceOptions): LocalSpaceInstance {
    return new LocalSpace(options);
  }

  use(plugin: LocalSpacePlugin | LocalSpacePlugin[]): LocalSpaceInstance {
    const plugins = Array.isArray(plugin) ? plugin : [plugin];
    this._pluginManager.registerPlugins(plugins);
    this._refreshPluginWrappers();
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

  async destroy(): Promise<void> {
    this._assertNotLifecycleReentrant('destroy');
    warnDeprecation(
      'destroy',
      '`destroy()` is deprecated; use `close()` to release plugins and the active driver.'
    );
    if (this._closed) {
      return this._closePromise ?? this.close();
    }
    await this._pluginManager.ensureInitialized();
    await this._pluginManager.destroy();
  }

  async defineDriver(driverObject: Driver): Promise<void> {
    const promise = new Promise<void>(async (resolve, reject) => {
      try {
        const driverName = driverObject._driver;
        const complianceError = createLocalSpaceError(
          'DRIVER_COMPLIANCE',
          'Custom driver not compliant',
          { driver: driverName }
        );

        if (!driverObject._driver) {
          reject(complianceError);
          return;
        }

        const driverRecord = driverObject as Driver & Record<string, unknown>;
        const driverMethods = LibraryMethods.concat('_initStorage');
        for (const driverMethodName of driverMethods) {
          const isRequired = !includes(OptionalDriverMethods, driverMethodName);
          const candidate = driverRecord[driverMethodName];
          if ((isRequired || candidate) && typeof candidate !== 'function') {
            reject(complianceError);
            return;
          }
        }

        const configureMissingMethods = () => {
          const methodNotImplementedFactory = (methodName: string) => {
            return function () {
              const error = createLocalSpaceError(
                'UNSUPPORTED_OPERATION',
                `Method ${methodName} is not implemented by the current driver`,
                { operation: methodName }
              );
              return Promise.reject(error);
            };
          };

          for (const optionalDriverMethod of OptionalDriverMethods) {
            if (!driverRecord[optionalDriverMethod]) {
              driverRecord[optionalDriverMethod] =
                methodNotImplementedFactory(optionalDriverMethod);
            }
          }
        };

        configureMissingMethods();

        const setDriverSupport = (support: boolean) => {
          if (DefinedDrivers[driverName]) {
            console.info(`Redefining LocalSpace driver: ${driverName}`);
          }
          DefinedDrivers[driverName] = driverObject;
          DriverSupport[driverName] = support;
          resolve();
        };

        if ('_support' in driverObject) {
          if (
            driverObject._support &&
            typeof driverObject._support === 'function'
          ) {
            const supportResult = await driverObject._support();
            setDriverSupport(supportResult);
          } else {
            setDriverSupport(!!driverObject._support);
          }
        } else {
          setDriverSupport(true);
        }
      } catch (e) {
        reject(e);
      }
    });

    return promise;
  }

  driver(): string | null {
    return this._driver || null;
  }

  async getDriver(driverName: string): Promise<Driver> {
    const getDriverPromise = DefinedDrivers[driverName]
      ? Promise.resolve(DefinedDrivers[driverName])
      : Promise.reject(
          createLocalSpaceError('DRIVER_NOT_FOUND', 'Driver not found.', {
            driver: driverName,
          })
        );

    return getDriverPromise;
  }

  async getSerializer(): Promise<Serializer> {
    return serializer;
  }

  async ready(): Promise<void> {
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
      this._config.driver = this.driver() ?? undefined;
    };

    const extendSelfWithDriver = async (driver: Driver) => {
      const isDefaultDriver = DefaultDriverSet.has(driver);
      const lifecycleScope = isDefaultDriver
        ? null
        : this._createLifecycleScope();
      const driverReceiver = lifecycleScope?.instance ?? this;
      const closeStorage =
        typeof driver._closeStorage === 'function'
          ? () => {
              if (isDefaultDriver) {
                return this._invokeLifecycleCallback('driver-close', () =>
                  driver._closeStorage!.call(this)
                );
              }
              return lifecycleScope!.invoke('driver-close', () =>
                driver._closeStorage!.call(driverReceiver)
              );
            }
          : null;
      this._activeDriverClose = closeStorage;
      this._driverInitialized = false;
      this._extend(driver, driverReceiver);
      this._driver = driver._driver;
      setDriverToConfig();

      const driverInstance = this as DriverAugmentedInstance;
      const initStorage = driverInstance._initStorage;
      const driverInitialization =
        typeof initStorage === 'function'
          ? Promise.resolve().then(() => {
              if (isDefaultDriver) {
                return this._invokeLifecycleCallback('driver-init', () =>
                  initStorage.call(this, this._config)
                );
              }
              return lifecycleScope!.invoke('driver-init', () =>
                initStorage.call(driverReceiver, this._config)
              );
            })
          : Promise.resolve();

      try {
        await driverInitialization;
        this._driverInitialized = true;
      } catch (error) {
        if (closeStorage) {
          try {
            await closeStorage();
          } catch {
            // Preserve the initialization failure that triggered cleanup.
          }
        }
        this._activeDriverClose = null;
        this._driverInitialized = false;
        this._dbInfo = null;
        this._wrapLibraryMethodsWithReady();
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
        this._wrapLibraryMethodsWithReady();
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
      !!DriverSupport[driverName] ||
      this._isDriverForcedByInstanceConfig(driverName)
    );
  }

  _extend(
    libraryMethodsAndProperties: Partial<Driver>,
    receiver: this = this
  ): void {
    const source = libraryMethodsAndProperties as Partial<
      Record<string, unknown>
    >;
    const guarded = { ...source };

    for (const method of new Set(LibraryMethods)) {
      const candidate = source[method];
      if (typeof candidate !== 'function') {
        continue;
      }
      const guardedMethod: RawDriverMethod = (...args: unknown[]) => {
        try {
          this._assertOpen(method);
          return Promise.resolve(candidate.apply(receiver, args));
        } catch (error) {
          return Promise.reject(error);
        }
      };
      guarded[method] = PluginAwareMethodSet.has(method)
        ? guardedMethod
        : this._createTrackedOperationWrapper(method, guardedMethod);
    }

    extend(this as unknown as Record<string, unknown>, guarded);
    this._capturePluginAwareMethods(guarded as Partial<Driver>);
  }

  private _capturePluginAwareMethods(source: Partial<Driver>): void {
    for (const method of PluginAwareMethods) {
      const candidate = (source as Partial<Record<string, unknown>>)[method];
      if (typeof candidate === 'function') {
        this._rawDriverMethods[method] = (candidate as RawDriverMethod).bind(
          this
        );
      }
    }
    this._refreshPluginWrappers();
  }

  private _refreshPluginWrappers(): void {
    for (const method of PluginAwareMethods) {
      const original = this._rawDriverMethods[method];
      if (!original) {
        continue;
      }

      let implementation: RawDriverMethod = original;
      if (!this._pluginManager || !this._pluginManager.hasPlugins()) {
        implementation = original;
      } else {
        switch (method) {
          case 'setItem':
            implementation = this._createSetItemWrapper(original);
            break;
          case 'getItem':
            implementation = this._createGetItemWrapper(original);
            break;
          case 'removeItem':
            implementation = this._createRemoveItemWrapper(original);
            break;
          case 'setItems':
            implementation = this._createSetItemsWrapper(original);
            break;
          case 'getItems':
            implementation = this._createGetItemsWrapper(original);
            break;
          case 'removeItems':
            implementation = this._createRemoveItemsWrapper(original);
            break;
          case 'iterate':
          case 'runTransaction':
            implementation = this._createStorageTransformGuard(
              original,
              method
            );
            break;
        }
      }

      (this as unknown as Record<string, unknown>)[method] =
        this._createTrackedOperationWrapper(method, implementation);
    }
  }

  private _createTrackedOperationWrapper(
    operation: string,
    executor: RawDriverMethod
  ): RawDriverMethod {
    return (...args: unknown[]) =>
      this._runTrackedOperation(operation, args, () => executor(...args));
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
      return operationPause.then(() => {
        this._assertOpen(operation);
        const currentMethod = (this as unknown as Record<string, unknown>)[
          operation
        ];
        if (typeof currentMethod !== 'function') {
          throw this._notInitializedError(operation);
        }
        return currentMethod.apply(this, args);
      });
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

  private _createGetItemWrapper(original: RawDriverMethod) {
    return (async (key: string) => {
      await this._ensurePluginsInitialized('getItem');
      const context = this._pluginManager.createContext('getItem');
      const targetKey = await this._pluginManager.beforeGet(key, context);
      const driverValue = await original(targetKey);
      const finalValue = await this._pluginManager.afterGet(
        targetKey,
        driverValue as unknown,
        context
      );
      return finalValue;
    }) as typeof this.getItem;
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

  private _createGetItemsWrapper(original: RawDriverMethod) {
    return (async (keys: string[]) => {
      await this._ensurePluginsInitialized('getItems');
      const batchContext = this._pluginManager.createContext('getItems');
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
        return { key: requestedKey, value: entry.value };
      });
    }) as typeof this.getItems;
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
      !!this._config.reactNativeAsyncStorage
    );
  }

  private async _resolveSupportedDrivers(drivers: string[]): Promise<string[]> {
    const supportedDrivers: string[] = [];
    for (const driverName of drivers) {
      const driver = DefinedDrivers[driverName];
      if (!driver) {
        continue;
      }

      if (!DriverSupport[driverName] && typeof driver._support === 'function') {
        try {
          const supportResult = await driver._support();
          DriverSupport[driverName] = !!supportResult;
        } catch {
          DriverSupport[driverName] = false;
        }
      }

      if (
        this.supports(driverName) ||
        this._isDriverForcedByInstanceConfig(driverName)
      ) {
        supportedDrivers.push(driverName);
      }
    }
    return supportedDrivers;
  }

  _wrapLibraryMethodsWithReady(): void {
    for (const libraryMethod of LibraryMethods) {
      callWhenReady(this as unknown as ReadyAwareInstance, libraryMethod);
    }
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

  private _createLifecycleScope(): LifecycleScope<this> {
    const activeInvocations: ActiveLifecycleInvocation[] = [];
    const instance = new Proxy(this, {
      get: (target, property, receiver) => {
        const activeInvocation =
          activeInvocations[activeInvocations.length - 1];
        if (
          activeInvocation &&
          typeof property === 'string' &&
          LifecycleReentrantMethods.has(property)
        ) {
          return () =>
            Promise.reject(
              target._lifecycleReentryError(
                property,
                activeInvocation.lifecycle
              )
            );
        }
        return Reflect.get(target, property, receiver);
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
      return this.setDriver(this._config.driver!);
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
      this._activeDriverClose = null;
      this._dbInfo = null;
      return;
    }

    const closeStorage = this._activeDriverClose;
    if (closeStorage) {
      await closeStorage();
    }

    this._activeDriverClose = null;
    this._driverInitialized = false;
    this._dbInfo = null;
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

  // Driver methods (will be replaced by actual driver implementations)
  async iterate<T, U>(
    _iteratorCallback: (value: T, key: string, iterationNumber: number) => U
  ): Promise<U> {
    throw this._notInitializedError('iterate');
  }

  async getItems<T>(_keys: string[]): Promise<BatchResponse<T>> {
    throw this._notInitializedError('getItems');
  }

  async getItem<T>(_key: string): Promise<T | null> {
    throw this._notInitializedError('getItem');
  }

  async setItem<T>(_key: string, _value: T): Promise<T> {
    throw this._notInitializedError('setItem');
  }

  async setItems<T>(_entries: BatchItems<T>): Promise<BatchResponse<T>> {
    throw this._notInitializedError('setItems');
  }

  async removeItem(_key: string): Promise<void> {
    throw this._notInitializedError('removeItem');
  }

  async removeItems(_keys: string[]): Promise<void> {
    throw this._notInitializedError('removeItems');
  }

  async runTransaction<T>(
    _mode: TransactionMode,
    _runner: (scope: TransactionScope) => Promise<T> | T
  ): Promise<T> {
    throw this._notInitializedError('runTransaction');
  }

  async clear(): Promise<void> {
    throw this._notInitializedError('clear');
  }

  async length(): Promise<number> {
    throw this._notInitializedError('length');
  }

  async key(_keyIndex: number): Promise<string | null> {
    throw this._notInitializedError('key');
  }

  async keys(): Promise<string[]> {
    throw this._notInitializedError('keys');
  }

  async dropInstance(_options?: LocalSpaceConfig): Promise<void> {
    throw this._notInitializedError('dropInstance');
  }
}
