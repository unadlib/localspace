import type {
  LocalspaceInstance,
  LocalspaceConfig,
  Driver,
  Callback,
  DbInfo,
  DefinedDriversMap,
  DriverSupportMap,
  Serializer,
} from './types';
import { extend, isArray, includes, executeTwoCallbacks } from './utils/helpers';
import serializer from './utils/serializer';
import idbDriver from './drivers/indexeddb';
import localstorageDriver from './drivers/localstorage';

// Shared drivers across all instances
const DefinedDrivers: DefinedDriversMap = {};
const DriverSupport: DriverSupportMap = {};

const DefaultDrivers = {
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

const DefaultConfig: LocalspaceConfig = {
  description: '',
  driver: DefaultDriverOrder.slice(),
  name: 'localforage',
  size: 4980736,
  storeName: 'keyvaluepairs',
  version: 1.0,
};

function callWhenReady(instance: any, libraryMethod: string): void {
  instance[libraryMethod] = function (...args: any[]) {
    return instance.ready().then(() => {
      return instance[libraryMethod].apply(instance, args);
    });
  };
}

export class Localspace implements LocalspaceInstance {
  readonly INDEXEDDB = 'asyncStorage';
  readonly LOCALSTORAGE = 'localStorageWrapper';

  _defaultConfig: LocalspaceConfig;
  _config: LocalspaceConfig;
  _driverSet: Promise<void> | null = null;
  _initDriver: (() => Promise<void>) | null = null;
  _ready: boolean | null = false;
  _dbInfo: DbInfo | null = null;
  _driver?: string;

  constructor(options?: LocalspaceConfig) {
    // Define default drivers
    for (const driverTypeKey in DefaultDrivers) {
      if (Object.prototype.hasOwnProperty.call(DefaultDrivers, driverTypeKey)) {
        const driver = (DefaultDrivers as any)[driverTypeKey];
        const driverName = driver._driver;
        (this as any)[driverTypeKey] = driverName;

        if (!DefinedDrivers[driverName]) {
          this.defineDriver(driver);
        }
      }
    }

    this._defaultConfig = extend({}, DefaultConfig);
    this._config = extend({}, this._defaultConfig, options || {});

    this._wrapLibraryMethodsWithReady();
    this.setDriver(this._config.driver!).catch(() => {});
  }

  config(options: LocalspaceConfig): true | Error | Promise<void>;
  config(key: string): any;
  config(): LocalspaceConfig;
  config(optionsOrKey?: LocalspaceConfig | string): any {
    if (typeof optionsOrKey === 'object') {
      if (this._ready) {
        return new Error("Can't call config() after localforage has been used.");
      }

      for (const i in optionsOrKey) {
        if (i === 'storeName') {
          (optionsOrKey as any)[i] = (optionsOrKey as any)[i].replace(/\W/g, '_');
        }

        if (i === 'version' && typeof (optionsOrKey as any)[i] !== 'number') {
          return new Error('Database version must be a number.');
        }

        (this._config as any)[i] = (optionsOrKey as any)[i];
      }

      if ('driver' in optionsOrKey && optionsOrKey.driver) {
        return this.setDriver(this._config.driver!);
      }

      return true;
    } else if (typeof optionsOrKey === 'string') {
      return (this._config as any)[optionsOrKey];
    } else {
      return this._config;
    }
  }

  createInstance(options?: LocalspaceConfig): LocalspaceInstance {
    return new Localspace(options);
  }

  async defineDriver(
    driverObject: Driver,
    callback?: Callback<void>,
    errorCallback?: Callback<Error>
  ): Promise<void> {
    const promise = new Promise<void>(async (resolve, reject) => {
      try {
        const driverName = driverObject._driver;
        const complianceError = new Error(
          'Custom driver not compliant; see https://mozilla.github.io/localForage/#definedriver'
        );

        if (!driverObject._driver) {
          reject(complianceError);
          return;
        }

        const driverMethods = LibraryMethods.concat('_initStorage');
        for (const driverMethodName of driverMethods) {
          const isRequired = !includes(OptionalDriverMethods, driverMethodName);
          if (
            (isRequired || (driverObject as any)[driverMethodName]) &&
            typeof (driverObject as any)[driverMethodName] !== 'function'
          ) {
            reject(complianceError);
            return;
          }
        }

        const configureMissingMethods = () => {
          const methodNotImplementedFactory = (methodName: string) => {
            return function () {
              const error = new Error(
                `Method ${methodName} is not implemented by the current driver`
              );
              return Promise.reject(error);
            };
          };

          for (const optionalDriverMethod of OptionalDriverMethods) {
            if (!(driverObject as any)[optionalDriverMethod]) {
              (driverObject as any)[optionalDriverMethod] =
                methodNotImplementedFactory(optionalDriverMethod);
            }
          }
        };

        configureMissingMethods();

        const setDriverSupport = (support: boolean) => {
          if (DefinedDrivers[driverName]) {
            console.info(`Redefining LocalForage driver: ${driverName}`);
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

    executeTwoCallbacks(promise, callback, errorCallback);
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

    executeTwoCallbacks(getDriverPromise, callback, errorCallback);
    return getDriverPromise;
  }

  async getSerializer(callback?: Callback<Serializer>): Promise<Serializer> {
    const serializerPromise = Promise.resolve(serializer);
    executeTwoCallbacks(serializerPromise, callback);
    return serializerPromise;
  }

  async ready(callback?: Callback<void>): Promise<void> {
    const promise = this._driverSet!.then(() => {
      if (this._ready === null) {
        this._ready = this._initDriver!() as any;
      }
      return this._ready as any;
    });

    executeTwoCallbacks(promise, callback);
    return promise;
  }

  async setDriver(
    drivers: string | string[],
    callback?: Callback<void>,
    errorCallback?: Callback<Error>
  ): Promise<void> {
    if (!isArray(drivers)) {
      drivers = [drivers];
    }

    const supportedDrivers = this._getSupportedDrivers(drivers);

    const setDriverToConfig = () => {
      this._config.driver = this.driver() as any;
    };

    const extendSelfWithDriver = async (driver: Driver) => {
      this._extend(driver);
      setDriverToConfig();
      if ((this as any)._initStorage) {
        this._ready = (this as any)._initStorage(this._config) as any;
      }
      return this._ready;
    };

    const initDriver = (supportedDrivers: string[]) => {
      return async () => {
        let currentDriverIndex = 0;

        const driverPromiseLoop: any = async () => {
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
          this._driverSet = Promise.reject(error);
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
        this._driverSet = Promise.reject(error);
        throw error;
      });

    executeTwoCallbacks(this._driverSet, callback, errorCallback);
    return this._driverSet;
  }

  supports(driverName: string): boolean {
    return !!DriverSupport[driverName];
  }

  _extend(libraryMethodsAndProperties: Partial<Driver>): void {
    extend(this, libraryMethodsAndProperties as any);
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
      callWhenReady(this, libraryMethod);
    }
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

  async key(keyIndex: number, callback?: Callback<string>): Promise<string | null> {
    throw new Error('Driver not initialized');
  }

  async keys(callback?: Callback<string[]>): Promise<string[]> {
    throw new Error('Driver not initialized');
  }

  async dropInstance(
    options?: LocalspaceConfig,
    callback?: Callback<void>
  ): Promise<void> {
    throw new Error('Driver not initialized');
  }
}
