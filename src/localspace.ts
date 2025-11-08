import type {
  LocalSpaceInstance,
  LocalSpaceConfig,
  Driver,
  Callback,
  DbInfo,
  DefinedDriversMap,
  DriverSupportMap,
  Serializer,
  CompatibilityErrorCallback,
  CompatibilitySuccessCallback,
} from './types';
import {
  extend,
  isArray,
  includes,
  executeTwoCallbacks,
} from './utils/helpers';
import serializer from './utils/serializer';
import idbDriver from './drivers/indexeddb';
import localstorageDriver from './drivers/localstorage';

// Shared drivers across all instances
const DefinedDrivers: DefinedDriversMap = {};
const DriverSupport: DriverSupportMap = {};

const DefaultDrivers: Record<'INDEXEDDB' | 'LOCALSTORAGE', Driver> = {
  INDEXEDDB: idbDriver,
  LOCALSTORAGE: localstorageDriver,
};

const DefaultDriverOrder = [
  DefaultDrivers.INDEXEDDB._driver,
  DefaultDrivers.LOCALSTORAGE._driver,
];

const OptionalDriverMethods = ['dropInstance'];

const LibraryMethods = [
  'clear',
  'getItem',
  'iterate',
  'key',
  'keys',
  'length',
  'removeItem',
  'setItem',
].concat(OptionalDriverMethods);

const DefaultConfig: LocalSpaceConfig = {
  description: '',
  driver: DefaultDriverOrder.slice(),
  name: 'localforage',
  size: 4980736,
  storeName: 'keyvaluepairs',
  version: 1.0,
  compatibilityMode: false,
};

type ReadyAwareInstance = {
  ready: () => Promise<void>;
} & Record<string, unknown>;

type ReadyWrappedMethod = (...args: unknown[]) => unknown;

type DriverAugmentedInstance = ReadyAwareInstance &
  Partial<Driver> & {
    _initStorage?: (config: LocalSpaceConfig) => Promise<void>;
  };

const asErrorHandler = (
  callback?: Callback<unknown> | CompatibilityErrorCallback,
  options?: { compatibilityMode?: boolean }
): ((error: Error) => void) | undefined => {
  if (!callback) {
    return undefined;
  }

  return (error: Error) => {
    if (options?.compatibilityMode) {
      (callback as CompatibilityErrorCallback)(error);
    } else {
      (callback as Callback<unknown>)(error, undefined);
    }
  };
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

export class LocalSpace implements LocalSpaceInstance {
  readonly INDEXEDDB = 'asyncStorage';
  readonly LOCALSTORAGE = 'localStorageWrapper';

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

  constructor(options?: LocalSpaceConfig) {
    const driverInitializationPromises: Promise<void>[] = [];

    // Define default drivers
    for (const driverTypeKey in DefaultDrivers) {
      if (Object.prototype.hasOwnProperty.call(DefaultDrivers, driverTypeKey)) {
        const driver =
          DefaultDrivers[driverTypeKey as keyof typeof DefaultDrivers];
        const driverName = driver._driver;
        (this as unknown as Record<string, string>)[driverTypeKey] = driverName;

        if (!DefinedDrivers[driverName]) {
          driverInitializationPromises.push(
            this.defineDriver(driver).catch((error) => {
              console.warn(
                `Failed to define LocalSpace driver "${driverName}"`,
                error
              );
            })
          );
        }
      }
    }

    this._defaultConfig = extend({}, DefaultConfig);
    this._config = extend({}, this._defaultConfig, options || {});

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
        return new Error("Can't call config() after LocalSpace has been used.");
      }

      const suppliedOptions = optionsOrKey as Partial<LocalSpaceConfig>;
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

        if (key === 'version' && typeof value !== 'number') {
          return new Error('Database version must be a number.');
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

  createInstance(options?: LocalSpaceConfig): LocalSpaceInstance {
    return new LocalSpace(options);
  }

  async defineDriver(
    driverObject: Driver,
    callback?: Callback<void> | CompatibilitySuccessCallback<void>,
    errorCallback?: Callback<Error> | CompatibilityErrorCallback
  ): Promise<void> {
    const promise = new Promise<void>(async (resolve, reject) => {
      try {
        const driverName = driverObject._driver;
        const complianceError = new Error('Custom driver not compliant');

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
            return function (...callbackArgs: unknown[]) {
              const error = new Error(
                `Method ${methodName} is not implemented by the current driver`
              );
              const maybeCallback = callbackArgs[callbackArgs.length - 1];
              if (typeof maybeCallback === 'function') {
                (maybeCallback as Callback)(error);
              }
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

    const callbackOptions = this._getCallbackOptions();
    executeTwoCallbacks(
      promise,
      callback,
      asErrorHandler(
        errorCallback as
          | Callback<unknown>
          | CompatibilityErrorCallback
          | undefined,
        callbackOptions
      ),
      callbackOptions
    );
    return promise;
  }

  driver(): string | null {
    return this._driver || null;
  }

  async getDriver(
    driverName: string,
    callback?: Callback<Driver>,
    errorCallback?: Callback<Error>
  ): Promise<Driver> {
    const getDriverPromise = DefinedDrivers[driverName]
      ? Promise.resolve(DefinedDrivers[driverName])
      : Promise.reject(new Error('Driver not found.'));

    const callbackOptions = this._getCallbackOptions();
    executeTwoCallbacks(
      getDriverPromise,
      callback,
      asErrorHandler(
        errorCallback as
          | Callback<unknown>
          | CompatibilityErrorCallback
          | undefined,
        callbackOptions
      ),
      callbackOptions
    );
    return getDriverPromise;
  }

  async getSerializer(callback?: Callback<Serializer>): Promise<Serializer> {
    const serializerPromise = Promise.resolve(serializer);
    executeTwoCallbacks(
      serializerPromise,
      callback,
      undefined,
      this._getCallbackOptions()
    );
    return serializerPromise;
  }

  async ready(callback?: Callback<void>): Promise<void> {
    const driverInitialization =
      this._driverSet ?? this._pendingDriverInitialization ?? Promise.resolve();

    const promise = driverInitialization.then(() => {
      if (this._ready === null) {
        this._ready = this._initDriver ? this._initDriver() : Promise.resolve();
      }
      return this._ready!;
    });

    const callbackOptions = this._getCallbackOptions();
    executeTwoCallbacks(
      promise,
      callback,
      asErrorHandler(
        callback as Callback<unknown> | undefined,
        callbackOptions
      ),
      callbackOptions
    );
    return promise;
  }

  async setDriver(
    drivers: string | string[],
    callback?: Callback<void> | CompatibilitySuccessCallback<void>,
    errorCallback?: Callback<Error> | CompatibilityErrorCallback
  ): Promise<void> {
    // Wait for driver initialization to complete before checking support
    // Skip waiting if this is being called from _runDefaultDriverSelection to avoid deadlock
    if (
      this._pendingDriverInitialization &&
      !this._isRunningDefaultDriverSelection
    ) {
      await this._pendingDriverInitialization;
    }

    if (!this._isRunningDefaultDriverSelection) {
      this._manualDriverOverride = true;
    }

    if (!isArray(drivers)) {
      drivers = [drivers];
    }

    const supportedDrivers = this._getSupportedDrivers(drivers);
    const callbackOptions = this._getCallbackOptions();

    if (supportedDrivers.length === 0) {
      const error = new Error('No available storage method found.');
      const rejection = Promise.resolve().then<never>(() => {
        throw error;
      });
      this._driverSet = rejection;
      executeTwoCallbacks(
        rejection,
        callback,
        asErrorHandler(
          errorCallback as
            | Callback<unknown>
            | CompatibilityErrorCallback
            | undefined,
          callbackOptions
        ),
        callbackOptions
      );
      return rejection;
    }

    const setDriverToConfig = () => {
      this._config.driver = this.driver() ?? undefined;
    };

    const extendSelfWithDriver = async (driver: Driver) => {
      this._extend(driver);
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
          const error = new Error('No available storage method found.');
          this._driverSet = Promise.resolve().then<never>(() => {
            throw error;
          });
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
        const error = new Error('No available storage method found.');
        this._driverSet = Promise.resolve().then<never>(() => {
          throw error;
        });
        throw error;
      });

    executeTwoCallbacks(
      this._driverSet,
      callback,
      asErrorHandler(
        errorCallback as
          | Callback<unknown>
          | CompatibilityErrorCallback
          | undefined,
        callbackOptions
      ),
      callbackOptions
    );
    return this._driverSet;
  }

  supports(driverName: string): boolean {
    return !!DriverSupport[driverName];
  }

  _extend(libraryMethodsAndProperties: Partial<Driver>): void {
    extend(
      this as unknown as Record<string, unknown>,
      libraryMethodsAndProperties as unknown as Partial<Record<string, unknown>>
    );
  }

  _getSupportedDrivers(drivers: string[]): string[] {
    const supportedDrivers: string[] = [];
    for (const driverName of drivers) {
      if (this.supports(driverName)) {
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

  private _getCallbackOptions() {
    const compatibilityMode =
      this._config && typeof this._config.compatibilityMode === 'boolean'
        ? !!this._config.compatibilityMode
        : false;
    return { compatibilityMode };
  }

  // Driver methods (will be replaced by actual driver implementations)
  async iterate<T, U>(
    iteratorCallback: (value: T, key: string, iterationNumber: number) => U,
    successCallback?: Callback<U>
  ): Promise<U> {
    throw new Error('Driver not initialized');
  }

  async getItem<T>(key: string, callback?: Callback<T>): Promise<T | null> {
    throw new Error('Driver not initialized');
  }

  async setItem<T>(key: string, value: T, callback?: Callback<T>): Promise<T> {
    throw new Error('Driver not initialized');
  }

  async removeItem(key: string, callback?: Callback<void>): Promise<void> {
    throw new Error('Driver not initialized');
  }

  async clear(callback?: Callback<void>): Promise<void> {
    throw new Error('Driver not initialized');
  }

  async length(callback?: Callback<number>): Promise<number> {
    throw new Error('Driver not initialized');
  }

  async key(
    keyIndex: number,
    callback?: Callback<string>
  ): Promise<string | null> {
    throw new Error('Driver not initialized');
  }

  async keys(callback?: Callback<string[]>): Promise<string[]> {
    throw new Error('Driver not initialized');
  }

  async dropInstance(
    options?: LocalSpaceConfig,
    callback?: Callback<void>
  ): Promise<void> {
    throw new Error('Driver not initialized');
  }
}
