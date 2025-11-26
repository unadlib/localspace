/**
 * Callback type for async operations
 */
export type Callback<T = unknown> = (error: Error | null, value?: T) => void;

/**
 * Compatibility success callback (no error parameter)
 */
export type CompatibilitySuccessCallback<T = unknown> = (value: T) => void;

/**
 * Compatibility error callback (receives Error only)
 */
export type CompatibilityErrorCallback = (error: Error) => void;

/**
 * Configuration options for localspace
 */
export interface LocalSpaceConfig {
  /**
   * Description of the database
   */
  description?: string;
  /**
   * Preferred durability hint for IndexedDB readwrite transactions.
   * Browsers default to 'relaxed'; set to 'strict' for migrations or
   * other flows that must flush before continuing.
   */
  durability?: IDBTransactionOptions['durability'];

  /**
   * Optional Storage Buckets configuration (when supported by the browser).
   * When provided, IndexedDB connections will be opened from the bucket.
   */
  bucket?: StorageBucketConfig;

  /**
   * Optional max batch size for bulk operations. When set, large batches
   * will be split into multiple transactions/chunks.
   */
  maxBatchSize?: number;

  /**
   * Driver(s) to use (string or array of strings)
   */
  driver?: string | string[];

  /**
   * Database name
   */
  name?: string;

  /**
   * Database size
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

  /**
   * Enable legacy callback compatibility mode
   */
  compatibilityMode?: boolean;
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
   * Batch set multiple items atomically when supported by the driver.
   */
  setItems<T>(
    entries: BatchItems<T>,
    callback?: Callback<BatchResponse<T>>
  ): Promise<BatchResponse<T>>;

  /**
   * Batch get multiple items in order.
   */
  getItems<T>(
    keys: string[],
    callback?: Callback<BatchResponse<T>>
  ): Promise<BatchResponse<T>>;

  /**
   * Batch remove multiple items.
   */
  removeItems(
    keys: string[],
    callback?: Callback<void>
  ): Promise<void>;

  /**
   * Execute multiple operations within a single driver-level transaction
   * when supported. Drivers without transactional support should still
   * run the callback sequentially.
   */
  runTransaction<T>(
    mode: IDBTransactionMode,
    runner: (scope: TransactionScope) => Promise<T> | T,
    callback?: Callback<T>
  ): Promise<T>;

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
  idbFactory?: IDBFactory | null;
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
  config<K extends keyof LocalSpaceConfig>(
    key: K
  ): LocalSpaceConfig[K] | undefined;
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
    callback?: Callback<void> | CompatibilitySuccessCallback<void>,
    errorCallback?: Callback<Error> | CompatibilityErrorCallback
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
    callback?: Callback<void> | CompatibilitySuccessCallback<void>,
    errorCallback?: Callback<Error> | CompatibilityErrorCallback
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
   * Batch set items
   */
  setItems<T>(
    entries: BatchItems<T>,
    callback?: Callback<BatchResponse<T>>
  ): Promise<BatchResponse<T>>;

  /**
   * Batch get items in order
   */
  getItems<T>(
    keys: string[],
    callback?: Callback<BatchResponse<T>>
  ): Promise<BatchResponse<T>>;

  /**
   * Batch remove items
   */
  removeItems(
    keys: string[],
    callback?: Callback<void>
  ): Promise<void>;

  /**
   * Run multiple operations in a single transaction when supported.
   */
  runTransaction<T>(
    mode: IDBTransactionMode,
    runner: (scope: TransactionScope) => Promise<T> | T,
    callback?: Callback<T>
  ): Promise<T>;

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
   * Internal properties
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

/**
 * Storage Buckets options (when supported)
 */
export interface StorageBucketConfig {
  name: string;
  durability?: 'relaxed' | 'strict';
  persisted?: boolean;
}

export interface KeyValuePair<T> {
  key: string;
  value: T;
}

export type BatchItems<T> =
  | Array<KeyValuePair<T>>
  | Map<string, T>
  | Record<string, T>;

export type BatchResponse<T> = Array<{ key: string; value: T | null }>;

export interface TransactionScope {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<T>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  iterate<T, U>(
    iterator: (value: T, key: string, iterationNumber: number) => U
  ): Promise<U>;
  clear(): Promise<void>;
}
