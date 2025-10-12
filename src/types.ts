/**
 * Callback type for async operations
 */
export type Callback<T = unknown> = (error: Error | null, value?: T) => void;

/**
 * Configuration options for localspace
 */
export interface LocalSpaceConfig {
  /**
   * Description of the database
   */
  description?: string;

  /**
   * Driver(s) to use (string or array of strings)
   */
  driver?: string | string[];

  /**
   * Database name
   */
  name?: string;

  /**
   * Database size (for WebSQL, ignored in other drivers)
   */
  size?: number;

  /**
   * Store/table name
   */
  storeName?: string;

  /**
   * Database version
   */
  version?: number;
}

/**
 * Driver interface that all storage drivers must implement
 */
export interface Driver {
  /**
   * Unique driver name
   */
  _driver: string;

  /**
   * Initialize storage with config
   */
  _initStorage(config: LocalSpaceConfig): Promise<void>;

  /**
   * Check if driver is supported (can be boolean or function)
   */
  _support: boolean | (() => Promise<boolean>);

  /**
   * Iterate through all items
   */
  iterate<T, U>(
    iteratorCallback: (value: T, key: string, iterationNumber: number) => U,
    successCallback?: Callback<U>
  ): Promise<U>;

  /**
   * Get item by key
   */
  getItem<T>(key: string, callback?: Callback<T>): Promise<T | null>;

  /**
   * Set item
   */
  setItem<T>(key: string, value: T, callback?: Callback<T>): Promise<T>;

  /**
   * Remove item
   */
  removeItem(key: string, callback?: Callback<void>): Promise<void>;

  /**
   * Clear all items
   */
  clear(callback?: Callback<void>): Promise<void>;

  /**
   * Get number of items
   */
  length(callback?: Callback<number>): Promise<number>;

  /**
   * Get key at index
   */
  key(keyIndex: number, callback?: Callback<string>): Promise<string | null>;

  /**
   * Get all keys
   */
  keys(callback?: Callback<string[]>): Promise<string[]>;

  /**
   * Drop instance (optional)
   */
  dropInstance?(
    options?: LocalSpaceConfig,
    callback?: Callback<void>
  ): Promise<void>;
}

/**
 * Serializer interface
 */
export interface Serializer {
  serialize(value: unknown): Promise<string>;
  deserialize(value: string): unknown;
  stringToBuffer(str: string): ArrayBuffer;
  bufferToString(buffer: ArrayBuffer): string;
}

/**
 * Driver support map
 */
export interface DriverSupportMap {
  [driverName: string]: boolean;
}

/**
 * Defined drivers map
 */
export interface DefinedDriversMap {
  [driverName: string]: Driver;
}

/**
 * Database info stored internally
 */
export interface DbInfo extends LocalSpaceConfig {
  db?: IDBDatabase | null;
  serializer?: Serializer;
  keyPrefix?: string;
}

/**
 * LocalSpace instance interface
 */
export interface LocalSpaceInstance {
  /**
   * Driver constants
   */
  readonly INDEXEDDB: string;
  readonly LOCALSTORAGE: string;

  /**
   * Configure localspace
   */
  config(options: LocalSpaceConfig): true | Error | Promise<void>;
  config<K extends keyof LocalSpaceConfig>(key: K): LocalSpaceConfig[K] | undefined;
  config(): LocalSpaceConfig;

  /**
   * Create a new instance
   */
  createInstance(options?: LocalSpaceConfig): LocalSpaceInstance;

  /**
   * Define a custom driver
   */
  defineDriver(
    driver: Driver,
    callback?: Callback<void>,
    errorCallback?: Callback<Error>
  ): Promise<void>;

  /**
   * Get current driver name
   */
  driver(): string | null;

  /**
   * Get driver object
   */
  getDriver(
    driverName: string,
    callback?: Callback<Driver>,
    errorCallback?: Callback<Error>
  ): Promise<Driver>;

  /**
   * Get serializer
   */
  getSerializer(callback?: Callback<Serializer>): Promise<Serializer>;

  /**
   * Wait for driver to be ready
   */
  ready(callback?: Callback<void>): Promise<void>;

  /**
   * Set driver(s) to use
   */
  setDriver(
    drivers: string | string[],
    callback?: Callback<void>,
    errorCallback?: Callback<Error>
  ): Promise<void>;

  /**
   * Check if driver is supported
   */
  supports(driverName: string): boolean;

  /**
   * Iterate through items
   */
  iterate<T, U>(
    iteratorCallback: (value: T, key: string, iterationNumber: number) => U,
    successCallback?: Callback<U>
  ): Promise<U>;

  /**
   * Get item
   */
  getItem<T>(key: string, callback?: Callback<T>): Promise<T | null>;

  /**
   * Set item
   */
  setItem<T>(key: string, value: T, callback?: Callback<T>): Promise<T>;

  /**
   * Remove item
   */
  removeItem(key: string, callback?: Callback<void>): Promise<void>;

  /**
   * Clear all items
   */
  clear(callback?: Callback<void>): Promise<void>;

  /**
   * Get length
   */
  length(callback?: Callback<number>): Promise<number>;

  /**
   * Get key at index
   */
  key(keyIndex: number, callback?: Callback<string>): Promise<string | null>;

  /**
   * Get all keys
   */
  keys(callback?: Callback<string[]>): Promise<string[]>;

  /**
   * Drop instance
   */
  dropInstance(
    options?: LocalSpaceConfig,
    callback?: Callback<void>
  ): Promise<void>;

  /**
   * Internal properties (for compatibility)
   */
  _initReady?: () => Promise<void>;
  _ready: boolean | Promise<void> | null;
  _dbInfo: DbInfo | null;
  _driver?: string;
  _driverSet: Promise<void> | null;
  _initDriver?: (() => Promise<void>) | null;
  _config: LocalSpaceConfig;
  _defaultConfig: LocalSpaceConfig;
  _initStorage?(config: LocalSpaceConfig): Promise<void>;
  _extend?(methods: Partial<Driver>): void;
  _getSupportedDrivers?(drivers: string[]): string[];
  _wrapLibraryMethodsWithReady?(): void;
}
