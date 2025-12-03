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
   * Pre-warm an IndexedDB transaction after initialization to avoid the
   * first-op latency hit. Enabled by default; set to false to skip.
   */
  prewarmTransactions?: boolean;

  /**
   * Optional idle timeout (ms) for IndexedDB connections. When set,
   * connections will be closed after a period of inactivity and reopened
   * automatically on the next operation.
   */
  connectionIdleMs?: number;

  /**
   * Optional cap on concurrent transactions. When exceeded, new transactions
   * are queued until one finishes.
   */
  maxConcurrentTransactions?: number;

  /**
   * Enable automatic write coalescing for single set/remove operations.
   */
  coalesceWrites?: boolean;

  /**
   * Time window (ms) to coalesce writes when coalesceWrites is enabled.
   */
  coalesceWindowMs?: number;

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
 * Extended configuration that enables instance-scoped plugins.
 */
export interface LocalSpaceOptions extends LocalSpaceConfig {
  /**
   * Optional plugins to attach to the instance.
   */
  plugins?: LocalSpacePlugin[];
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
  removeItems(keys: string[], callback?: Callback<void>): Promise<void>;

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

  /**
   * Get performance statistics (optional, IndexedDB only)
   */
  getPerformanceStats?(): PerformanceStats;
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
  createInstance(options?: LocalSpaceOptions): LocalSpaceInstance;

  /**
   * Register one or more plugins on this instance.
   */
  use(plugin: LocalSpacePlugin | LocalSpacePlugin[]): LocalSpaceInstance;

  /**
   * Tear down plugins and release their resources.
   */
  destroy(): Promise<void>;

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
  removeItems(keys: string[], callback?: Callback<void>): Promise<void>;

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
   * Get performance statistics (only available for IndexedDB driver)
   */
  getPerformanceStats?(): PerformanceStats;

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

/**
 * Performance statistics for write coalescing
 */
export interface PerformanceStats {
  /**
   * Total number of individual write operations (setItem/removeItem)
   */
  totalWrites: number;
  /**
   * Number of writes that were merged via coalescing
   */
  coalescedWrites: number;
  /**
   * Number of transactions saved by coalescing
   */
  transactionsSaved: number;
  /**
   * Average number of operations per coalesced batch
   */
  avgCoalesceSize: number;
}

export type PluginEnabledPredicate = boolean | (() => boolean);

export type PluginOperation =
  | 'setItem'
  | 'getItem'
  | 'removeItem'
  | 'setItems'
  | 'getItems'
  | 'removeItems'
  | 'lifecycle';

export type PluginStage = 'init' | 'before' | 'after' | 'destroy' | 'error';

export interface PluginContext {
  instance: LocalSpaceInstance;
  driver: string | null;
  dbInfo: DbInfo | null;
  config: LocalSpaceConfig;
  metadata: Record<string, unknown>;
  operation: PluginOperation | null;
  operationState: Record<string, unknown>;
}

export interface PluginErrorInfo {
  plugin: string;
  operation: PluginOperation;
  stage: PluginStage;
  key?: string;
  context: PluginContext;
  error: unknown;
}

export interface LocalSpacePlugin {
  name: string;
  version?: string;
  priority?: number;
  enabled?: PluginEnabledPredicate;

  onInit?(context: PluginContext): Promise<void> | void;
  onDestroy?(context: PluginContext): Promise<void> | void;
  onError?(error: unknown, info: PluginErrorInfo): Promise<void> | void;

  beforeSet?<T>(key: string, value: T, context: PluginContext): Promise<T> | T;
  afterSet?<T>(
    key: string,
    value: T,
    context: PluginContext
  ): Promise<void> | void;

  beforeGet?(key: string, context: PluginContext): Promise<string> | string;
  afterGet?<T>(
    key: string,
    value: T | null,
    context: PluginContext
  ): Promise<T | null> | T | null;

  beforeRemove?(key: string, context: PluginContext): Promise<string> | string;
  afterRemove?(key: string, context: PluginContext): Promise<void> | void;

  beforeSetItems?<T>(
    entries: BatchItems<T>,
    context: PluginContext
  ): Promise<BatchItems<T>> | BatchItems<T>;
  afterSetItems?<T>(
    entries: BatchResponse<T>,
    context: PluginContext
  ): Promise<BatchResponse<T>> | BatchResponse<T>;

  beforeGetItems?(
    keys: string[],
    context: PluginContext
  ): Promise<string[]> | string[];
  afterGetItems?<T>(
    entries: BatchResponse<T>,
    context: PluginContext
  ): Promise<BatchResponse<T>> | BatchResponse<T>;

  beforeRemoveItems?(
    keys: string[],
    context: PluginContext
  ): Promise<string[]> | string[];
  afterRemoveItems?(
    keys: string[],
    context: PluginContext
  ): Promise<void> | void;
}
