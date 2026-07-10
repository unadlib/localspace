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
} from './types.js';
import { extend, isArray, includes } from './utils/helpers.js';
import { createLocalSpaceError, LocalSpaceError } from './errors.js';
import serializer from './utils/serializer.js';
import idbDriver from './drivers/indexeddb.js';
import localstorageDriver from './drivers/localstorage.js';
import memoryDriver from './drivers/memory.js';
import { PluginManager } from './core/plugin-manager.js';

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
] as const;

type PluginAwareMethod = (typeof PluginAwareMethods)[number];
type RawDriverMethod = (...args: unknown[]) => Promise<unknown>;

const DefaultConfig: LocalSpaceConfig = {
  description: '',
  driver: DefaultDriverOrder.slice(),
  name: 'localforage',
  storeName: 'keyvaluepairs',
  version: 1.0,
  pluginInitPolicy: 'fail',
  pluginErrorPolicy: 'lenient',
};

type ReadyAwareInstance = {
  ready: () => Promise<void>;
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
  instance[libraryMethod] = function (...args: unknown[]) {
    return instance.ready().then(() => {
      const method = instance[libraryMethod] as ReadyWrappedMethod;
      return method.apply(instance, args);
    });
  } as ReadyWrappedMethod;
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
  private _pluginManager: PluginManager;
  private _rawDriverMethods: Partial<
    Record<PluginAwareMethod, (...args: any[]) => Promise<unknown>>
  > = {};

  constructor(options?: LocalSpaceOptions) {
    const driverInitializationPromises: Promise<void>[] = [];
    const { plugins = [], ...configOverrides } = options ?? {};

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
    this._config = extend(
      {},
      this._defaultConfig,
      configOverrides as LocalSpaceConfig
    );
    this._pluginManager = new PluginManager(
      this as LocalSpaceInstance & {
        _config: LocalSpaceConfig;
        _dbInfo: DbInfo | null;
      },
      plugins
    );

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
      if (this._ready) {
        return createLocalSpaceError(
          'CONFIG_LOCKED',
          "Can't call config() after LocalSpace has been used.",
          { operation: 'config' }
        );
      }

      const suppliedOptions = optionsOrKey as Partial<LocalSpaceConfig>;

      // Validate all options before applying any changes
      for (const key of Object.keys(suppliedOptions) as Array<
        keyof LocalSpaceConfig
      >) {
        const value = suppliedOptions[key];

        if (key === 'version' && typeof value !== 'number') {
          return createLocalSpaceError(
            'INVALID_CONFIG',
            'Database version must be a number.',
            { configKey: 'version', providedType: typeof value }
          );
        }
      }

      // All validations passed, now apply changes
      const configRecord = this._config as LocalSpaceConfig &
        Record<string, unknown>;

      for (const key of Object.keys(suppliedOptions) as Array<
        keyof LocalSpaceConfig
      >) {
        const value = suppliedOptions[key];

        if (key === 'storeName' && typeof value === 'string') {
          configRecord.storeName = value.replace(/\W/g, '_');
          continue;
        }

        configRecord[key as string] = value as unknown;
      }

      if (suppliedOptions.driver) {
        return this.setDriver(this._config.driver!);
      }

      return true;
    }

    if (typeof optionsOrKey === 'string') {
      const key = optionsOrKey as keyof LocalSpaceConfig;
      return this._config[key];
    }

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

  async destroy(): Promise<void> {
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
    const driverInitialization =
      this._driverSet ?? this._pendingDriverInitialization ?? Promise.resolve();

    const promise = driverInitialization.then(() => {
      if (this._ready === null) {
        this._ready = this._initDriver ? this._initDriver() : Promise.resolve();
      }
      return this._ready!;
    });

    return promise;
  }

  async setDriver(drivers: string | string[]): Promise<void> {
    // Wait for driver initialization to complete before checking support
    // Skip waiting if this is being called from _runDefaultDriverSelection to avoid deadlock
    if (
      this._pendingDriverInitialization &&
      !this._isRunningDefaultDriverSelection
    ) {
      await this._pendingDriverInitialization.catch(() => undefined);
    }

    if (!this._isRunningDefaultDriverSelection) {
      this._manualDriverOverride = true;
    }

    if (!isArray(drivers)) {
      drivers = [drivers];
    }

    const requestedDrivers = drivers as string[];
    const supportedDrivers =
      await this._resolveSupportedDrivers(requestedDrivers);
    if (supportedDrivers.length === 0) {
      const error = createLocalSpaceError(
        'DRIVER_UNAVAILABLE',
        'No available storage method found.',
        { attemptedDrivers: requestedDrivers }
      );
      const rejection = Promise.resolve().then<never>(() => {
        throw error;
      });
      this._driverSet = rejection;
      return rejection;
    }

    const setDriverToConfig = () => {
      this._config.driver = this.driver() ?? undefined;
    };

    const extendSelfWithDriver = async (driver: Driver) => {
      this._extend(driver);
      this._driver = driver._driver;
      setDriverToConfig();

      const driverInstance = this as DriverAugmentedInstance;
      const initStorage = driverInstance._initStorage;
      this._ready =
        typeof initStorage === 'function'
          ? initStorage.call(this, this._config)
          : Promise.resolve();

      await this._ready;
      return this._ready;
    };

    const initDriver = (supportedDrivers: string[]) => {
      return async () => {
        let currentDriverIndex = 0;

        const driverPromiseLoop = async (): Promise<void> => {
          while (currentDriverIndex < supportedDrivers.length) {
            const driverName = supportedDrivers[currentDriverIndex];
            currentDriverIndex++;

            this._dbInfo = null;
            this._ready = null;

            try {
              const driver = await this.getDriver(driverName);
              await extendSelfWithDriver(driver);
              return;
            } catch (e) {
              // Continue to next driver
            }
          }

          setDriverToConfig();
          const error = createLocalSpaceError(
            'DRIVER_UNAVAILABLE',
            'No available storage method found.',
            { attemptedDrivers: supportedDrivers }
          );
          throw error;
        };

        return driverPromiseLoop();
      };
    };

    const oldDriverSetDone =
      this._driverSet !== null
        ? this._driverSet.catch(() => Promise.resolve())
        : Promise.resolve();

    this._driverSet = oldDriverSetDone
      .then(async () => {
        const driverName = supportedDrivers[0];
        this._dbInfo = null;
        this._ready = null;

        const driver = await this.getDriver(driverName);
        this._driver = driver._driver;
        setDriverToConfig();
        this._wrapLibraryMethodsWithReady();
        this._initDriver = initDriver(supportedDrivers);
      })
      .catch(() => {
        setDriverToConfig();
        const error = createLocalSpaceError(
          'DRIVER_UNAVAILABLE',
          'No available storage method found.',
          { attemptedDrivers: supportedDrivers }
        );
        throw error;
      });

    return this._driverSet;
  }

  supports(driverName: string): boolean {
    return (
      !!DriverSupport[driverName] ||
      this._isDriverForcedByInstanceConfig(driverName)
    );
  }

  _extend(libraryMethodsAndProperties: Partial<Driver>): void {
    extend(
      this as unknown as Record<string, unknown>,
      libraryMethodsAndProperties as unknown as Partial<Record<string, unknown>>
    );
    this._capturePluginAwareMethods(libraryMethodsAndProperties);
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

      if (!this._pluginManager || !this._pluginManager.hasPlugins()) {
        (this as unknown as Record<string, unknown>)[method] = original;
        continue;
      }

      switch (method) {
        case 'setItem':
          (this as unknown as Record<string, unknown>)[method] =
            this._createSetItemWrapper(original);
          break;
        case 'getItem':
          (this as unknown as Record<string, unknown>)[method] =
            this._createGetItemWrapper(original);
          break;
        case 'removeItem':
          (this as unknown as Record<string, unknown>)[method] =
            this._createRemoveItemWrapper(original);
          break;
        case 'setItems':
          (this as unknown as Record<string, unknown>)[method] =
            this._createSetItemsWrapper(original);
          break;
        case 'getItems':
          (this as unknown as Record<string, unknown>)[method] =
            this._createGetItemsWrapper(original);
          break;
        case 'removeItems':
          (this as unknown as Record<string, unknown>)[method] =
            this._createRemoveItemsWrapper(original);
          break;
        default:
          (this as unknown as Record<string, unknown>)[method] = original;
      }
    }
  }

  private _createSetItemWrapper(original: RawDriverMethod) {
    return (async (key: string, value: unknown) => {
      await this._pluginManager.ensureInitialized();
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
      await this._pluginManager.ensureInitialized();
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
      await this._pluginManager.ensureInitialized();
      const context = this._pluginManager.createContext('removeItem');
      const targetKey = await this._pluginManager.beforeRemove(key, context);
      await original(targetKey);
      await this._pluginManager.afterRemove(targetKey, context);
    }) as typeof this.removeItem;
  }

  private _createSetItemsWrapper(original: RawDriverMethod) {
    return (async (entries: BatchItems<unknown>) => {
      await this._pluginManager.ensureInitialized();
      const batchContext = this._pluginManager.createContext('setItems');
      batchContext.operationState.isBatch = true;
      const prepared = await this._pluginManager.beforeSetItems(
        entries,
        batchContext
      );
      const normalized = this._pluginManager.normalizeBatch(prepared);
      batchContext.operationState.batchSize = normalized.length;
      const processedEntries: Array<{
        key: string;
        value: unknown;
        context: PluginContext;
      }> = [];
      const contextByKey = new Map<
        string,
        { value: unknown; context: PluginContext }
      >();

      for (const entry of normalized) {
        const entryContext = this._pluginManager.createContext('setItem');
        entryContext.operationState.originalValue = entry.value;
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
        contextByKey.set(entry.key, {
          value: processedValue,
          context: entryContext,
        });
      }

      const driverResponse = (await original(
        processedEntries as unknown as BatchItems<unknown>
      )) as BatchResponse<unknown>;
      const finalized = await this._pluginManager.afterSetItems(
        driverResponse,
        batchContext
      );

      for (const entry of processedEntries) {
        await this._pluginManager.afterSet(
          entry.key,
          entry.value,
          entry.context
        );
      }

      const finalReturn = finalized.map((entry) => {
        const entryContext = contextByKey.get(entry.key);
        const contextualValue =
          entryContext?.context.operationState.returnValue;
        const value =
          typeof contextualValue !== 'undefined'
            ? contextualValue
            : typeof entry.value !== 'undefined'
              ? entry.value
              : (entryContext?.context.operationState.originalValue ??
                entryContext?.value);
        return { key: entry.key, value };
      });

      return finalReturn;
    }) as typeof this.setItems;
  }

  private _createGetItemsWrapper(original: RawDriverMethod) {
    return (async (keys: string[]) => {
      await this._pluginManager.ensureInitialized();
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
      await this._pluginManager.ensureInitialized();
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

  private _runDefaultDriverSelection(): Promise<void> {
    if (this._manualDriverOverride) {
      return this._driverSet ?? Promise.resolve();
    }

    this._isRunningDefaultDriverSelection = true;
    return this.setDriver(this._config.driver!).then(
      () => {
        this._isRunningDefaultDriverSelection = false;
      },
      (error) => {
        this._isRunningDefaultDriverSelection = false;
        throw error;
      }
    );
  }

  private _notInitializedError(operation: string): LocalSpaceError {
    return createLocalSpaceError(
      'DRIVER_NOT_INITIALIZED',
      'Driver not initialized',
      { operation }
    );
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
