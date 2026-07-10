/**
 * React Native AsyncStorage-compatible adapter interface
 */
export interface ReactNativeAsyncStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear?(): Promise<void>;
  getAllKeys?(): Promise<string[]>;
  multiGet?(keys: string[]): Promise<Array<[string, string | null]>>;
  multiSet?(keyValuePairs: Array<[string, string]>): Promise<void>;
  multiRemove?(keys: string[]): Promise<void>;
}

export type TransactionMode = 'readonly' | 'readwrite';

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
   * Driver(s) to use (string or array of strings)
   */
  driver?: string | string[];

  /**
   * Optional React Native AsyncStorage adapter.
   * When provided, the React Native AsyncStorage driver can be used even when
   * automatic runtime detection is unavailable.
   */
  reactNativeAsyncStorage?: ReactNativeAsyncStorage;

  /**
   * Database name. Defaults to `'localforage'` — intentionally matching
   * localForage so existing data migrates without a rewrite. Set explicitly
   * for a fresh, app-owned namespace.
   */
  name?: string;

  /**
   * Legacy WebSQL database size hint. Defaults to `4980736` for localForage
   * and localspace v2 compatibility. Built-in drivers ignore this value;
   * it does not set or enforce a storage quota.
   * @deprecated Retained for compatibility only. Do not use for quota enforcement.
   */
  size?: number;

  /**
   * Store/table name. Defaults to `'keyvaluepairs'` (localForage-compatible).
   */
  storeName?: string;

  /**
   * Database version
   */
  version?: number;

  /**
   * Plugin initialization failure policy.
   * - 'fail' (default): propagate errors and abort initialization
   * - 'disable-and-continue': log and skip the failing plugin
   */
  pluginInitPolicy?: 'fail' | 'disable-and-continue';

  /**
   * Plugin runtime error policy.
   * - 'lenient' (default): swallow unexpected plugin errors (except LocalSpaceError/PluginAbortError) after reporting via onError
   * - 'strict': propagate all plugin errors to the caller
   */
  pluginErrorPolicy?: 'strict' | 'lenient';
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
  _support?: boolean | (() => boolean | Promise<boolean>);

  /**
   * Iterate through all items
   */
  iterate<T, U>(
    iteratorCallback: (value: T, key: string, iterationNumber: number) => U
  ): Promise<U>;

  /**
   * Get item by key
   */
  getItem<T>(key: string): Promise<T | null>;

  /**
   * Set item
   */
  setItem<T>(key: string, value: T): Promise<T>;

  /**
   * Remove item
   */
  removeItem(key: string): Promise<void>;

  /**
   * Batch set multiple items atomically when supported by the driver.
   */
  setItems?<T>(entries: BatchItems<T>): Promise<BatchResponse<T>>;

  /**
   * Batch get multiple items in order.
   */
  getItems?<T>(keys: string[]): Promise<BatchResponse<T>>;

  /**
   * Batch remove multiple items.
   */
  removeItems?(keys: string[]): Promise<void>;

  /**
   * Execute multiple operations within a driver-level transaction.
   * Non-transactional drivers must omit this method.
   */
  runTransaction?<T>(
    mode: TransactionMode,
    runner: (scope: TransactionScope) => Promise<T> | T
  ): Promise<T>;

  /**
   * Clear all items
   */
  clear(): Promise<void>;

  /**
   * Get number of items
   */
  length(): Promise<number>;

  /**
   * Get key at index
   */
  key(keyIndex: number): Promise<string | null>;

  /**
   * Get all keys
   */
  keys(): Promise<string[]>;

  /**
   * Drop instance (optional)
   */
  dropInstance?(options?: LocalSpaceConfig): Promise<void>;
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
  readonly MEMORY: string;
  readonly REACTNATIVEASYNCSTORAGE: string;

  /**
   * Configure localspace. Must be called before the first storage operation.
   *
   * Returns `true` on success for non-driver options. Validation and lock
   * failures are **returned as an `Error` value, not thrown or rejected**
   * (a localForage-compatible contract) — so `await config({ version: 'bad' })`
   * resolves to an `Error` rather than rejecting. Inspect the return value.
   * Only the `driver` form returns the `setDriver()` promise.
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
  defineDriver(driver: Driver): Promise<void>;

  /**
   * Get current driver name
   */
  driver(): string | null;

  /**
   * Get driver object
   */
  getDriver(driverName: string): Promise<Driver>;

  /**
   * Get serializer
   */
  getSerializer(): Promise<Serializer>;

  /**
   * Wait for driver to be ready
   */
  ready(): Promise<void>;

  /**
   * Set driver(s) to use
   */
  setDriver(drivers: string | string[]): Promise<void>;

  /**
   * Check if driver is supported
   */
  supports(driverName: string): boolean;

  /**
   * Iterate through items
   */
  iterate<T, U>(
    iteratorCallback: (value: T, key: string, iterationNumber: number) => U
  ): Promise<U>;

  /**
   * Get item
   */
  getItem<T>(key: string): Promise<T | null>;

  /**
   * Set item
   */
  setItem<T>(key: string, value: T): Promise<T>;

  /**
   * Remove item
   */
  removeItem(key: string): Promise<void>;

  /**
   * Clear all items
   */
  clear(): Promise<void>;

  /**
   * Batch set items
   */
  setItems<T>(entries: BatchItems<T>): Promise<BatchResponse<T>>;

  /**
   * Batch get items in order
   */
  getItems<T>(keys: string[]): Promise<BatchResponse<T>>;

  /**
   * Batch remove items
   */
  removeItems(keys: string[]): Promise<void>;

  /**
   * Run multiple operations in a single transaction when supported.
   */
  runTransaction<T>(
    mode: TransactionMode,
    runner: (scope: TransactionScope) => Promise<T> | T
  ): Promise<T>;

  /**
   * Get length
   */
  length(): Promise<number>;

  /**
   * Get key at index
   */
  key(keyIndex: number): Promise<string | null>;

  /**
   * Get all keys
   */
  keys(): Promise<string[]>;

  /**
   * Drop instance
   */
  dropInstance(options?: LocalSpaceConfig): Promise<void>;

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

  /**
   * Batch hooks. A batch call (e.g. `setItems`) runs BOTH the batch hook and
   * the per-entry single hook (with `context.operationState.isBatch === true`).
   * If a plugin implements both forms, guard the single form with
   * `if (context.operationState.isBatch) return value;` so entries are not
   * processed twice. See docs/plugins.md "Batch vs single hooks".
   */
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
