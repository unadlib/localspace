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

export type StoragePrimitive = null | boolean | number | string;

export type StorageBinary =
  | ArrayBuffer
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

/** Values LocalSpace round-trips consistently across every 3.0 driver. */
export type StorageValue =
  | StoragePrimitive
  | StorageBinary
  | StorageValue[]
  | { [key: string]: StorageValue };

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
   * will be split into multiple transactions/chunks. Set to 0 for no split.
   */
  maxBatchSize?: number;

  /**
   * Driver(s) to use (string or array of strings)
   */
  driver?: string | string[];

  /**
   * Explicit React Native AsyncStorage adapter. This is required whenever the
   * React Native driver is selected; runtime globals and modules are not
   * auto-detected.
   */
  reactNativeAsyncStorage?: ReactNativeAsyncStorage;

  /**
   * Database name. Defaults to `'localforage'` so data stored by localForage
   * can be reused when the same supported IndexedDB or localStorage driver is
   * selected. WebSQL data must be migrated first. Set explicitly for a fresh,
   * app-owned namespace.
   */
  name?: string;

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

export type DeepReadonly<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/** A detached, deeply frozen view of an instance's current configuration. */
export type LocalSpaceConfigSnapshot = DeepReadonly<LocalSpaceConfig>;

/**
 * Extended configuration that enables instance-scoped plugins.
 */
export interface LocalSpaceOptions extends LocalSpaceConfig {
  /**
   * Optional plugins to attach to the instance.
   */
  plugins?: LocalSpacePlugin[];

  /**
   * Immutable driver definitions available only to this instance. Definitions
   * are snapshotted at construction and each selection creates a new
   * instance-owned driver session.
   */
  drivers?: readonly Driver[];
}

export interface DriverRegistrationOptions {
  /**
   * Replace a definition already registered in the same explicit global
   * scope. Built-in and application definitions are protected by default.
   */
  overwrite?: boolean;
}

export interface LocalSpaceCapabilities {
  readonly transactions: boolean;
  readonly atomicBatch: boolean;
  readonly dropInstance: boolean;
  readonly persistent: boolean;
  readonly storageBuckets: boolean;
}

export type DriverCapabilities = Partial<LocalSpaceCapabilities>;

/**
 * Driver interface that all storage drivers must implement
 */
export interface Driver {
  /**
   * Unique driver name
   */
  _driver: string;

  /**
   * Initialize storage with config. The callback receiver is a stable,
   * instance-owned driver session that forwards LocalSpace methods to the
   * selecting public instance while keeping driver state off that facade.
   * Same-instance storage and lifecycle calls reject while this callback is
   * pending.
   */
  _initStorage(config: LocalSpaceConfig): Promise<void>;
  _initStorage(
    this: LocalSpaceInstance,
    config: LocalSpaceConfig
  ): Promise<void>;

  /**
   * Release resources owned by the current driver session without deleting
   * persisted data. The callback receiver is the same stable session used
   * during initialization and operations; same-instance storage and lifecycle
   * calls reject while this callback is pending. If cleanup rejects, the same
   * callback may be invoked again by a later lifecycle attempt, including
   * after a failed `_initStorage()`, so implementations must make retries safe.
   */
  _closeStorage?(): Promise<void>;
  _closeStorage?(this: LocalSpaceInstance): Promise<void>;

  /**
   * Check if driver is supported (can be boolean or function)
   */
  _support?: boolean | (() => boolean | Promise<boolean>);

  /**
   * Declarative guarantees for a selected driver session. Omitted fields use
   * conservative defaults; a synchronous resolver may inspect the initialized
   * session and its configuration.
   */
  _capabilities?:
    | DriverCapabilities
    | ((
        this: LocalSpaceInstance,
        config: Readonly<LocalSpaceConfig>
      ) => DriverCapabilities);

  /**
   * Iterate through all items
   */
  iterate<T extends StorageValue = StorageValue, U = void>(
    iteratorCallback: (value: T, key: string, iterationNumber: number) => U
  ): Promise<U>;

  /**
   * Get item by key
   */
  getItem<T extends StorageValue = StorageValue>(
    key: string
  ): Promise<T | null>;

  /**
   * Set item
   */
  setItem<T extends StorageValue>(key: string, value: T): Promise<T>;

  /**
   * Remove item
   */
  removeItem(key: string): Promise<void>;

  /**
   * Batch set multiple items atomically when supported by the driver.
   */
  setItems?<T extends StorageValue>(
    entries: BatchItems<T>
  ): Promise<BatchResponse<T>>;

  /**
   * Batch get multiple items in order.
   */
  getItems?<T extends StorageValue = StorageValue>(
    keys: string[]
  ): Promise<BatchResponse<T>>;

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
  idbContextId?: string;
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

  config<K extends keyof LocalSpaceConfig>(
    key: K
  ): LocalSpaceConfigSnapshot[K] | undefined;
  /** Return a detached, deeply frozen snapshot of the current configuration. */
  config(): LocalSpaceConfigSnapshot;

  /**
   * Create a new instance
   */
  createInstance(options?: LocalSpaceOptions): LocalSpaceInstance;

  /**
   * Register one or more plugins on this instance.
   */
  use(plugin: LocalSpacePlugin | LocalSpacePlugin[]): LocalSpaceInstance;

  /**
   * Close this instance without deleting persisted data. Rejects with
   * OPERATION_FAILED while a storage operation is active; wait for the
   * operation and retry. If driver cleanup rejects, the instance remains
   * closed and another close() call retries the unfinished cleanup.
   */
  close(): Promise<void>;

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
   * Set driver(s) to use. Rejects with OPERATION_FAILED while a storage
   * operation is active; wait for the operation and retry. A rejected current
   * or initialization-failure driver cleanup is retained so a later
   * setDriver() can retry it.
   */
  setDriver(drivers: string | string[]): Promise<void>;

  /**
   * Check if driver is supported
   */
  supports(driverName: string): boolean;

  /**
   * Return the frozen guarantees of the selected, initialized driver.
   * Throws DRIVER_NOT_INITIALIZED before ready() has completed.
   */
  capabilities(): LocalSpaceCapabilities;

  /**
   * Iterate through logical items in driver order. Async callbacks are awaited
   * sequentially; returning a non-undefined value stops iteration.
   */
  iterate<T extends StorageValue = StorageValue, U = void>(
    iteratorCallback: (
      value: T,
      key: string,
      iterationNumber: number
    ) => U | Promise<U>
  ): Promise<U | undefined>;

  /**
   * Get item
   */
  getItem<T extends StorageValue = StorageValue>(
    key: string
  ): Promise<T | null>;

  /**
   * Set item
   */
  setItem<T extends StorageValue>(key: string, value: T): Promise<T>;

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
  setItems<T extends StorageValue>(
    entries: BatchItems<T>
  ): Promise<BatchResponse<T>>;

  /**
   * Batch get items in order
   */
  getItems<T extends StorageValue = StorageValue>(
    keys: string[]
  ): Promise<BatchResponse<T>>;

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
  get<T extends StorageValue = StorageValue>(key: string): Promise<T | null>;
  set<T extends StorageValue>(key: string, value: T): Promise<T>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  iterate<T extends StorageValue = StorageValue, U = void>(
    iterator: (value: T, key: string, iterationNumber: number) => U | Promise<U>
  ): Promise<U | undefined>;
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
  | 'iterate'
  | 'keys'
  | 'key'
  | 'length'
  | 'clear'
  | 'dropInstance'
  | 'runTransaction'
  | 'lifecycle';

export type PluginStage = 'init' | 'before' | 'after' | 'destroy';

export interface PluginContext {
  /** The public LocalSpace instance. Its identity is stable across all hooks. */
  instance: LocalSpaceInstance;
  /**
   * A callback-scoped receiver for same-instance calls made by `onInit` or
   * `onDestroy`. It rejects storage and lifecycle reentry while that callback
   * is pending, including across `await`, and is omitted from operation hooks.
   */
  lifecycleInstance?: LocalSpaceInstance;
  /**
   * The active logical transaction scope when a hook runs for a
   * transaction-bound operation. Plugins must use this scope instead of
   * re-entering the instance facade.
   */
  transactionScope?: TransactionScope;
  driver: string | null;
  dbInfo: DbInfo | null;
  config: LocalSpaceConfigSnapshot;
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

export interface PluginIterateSummary {
  /** Number of logical entries delivered to the iterator. */
  readonly iterations: number;
  /** Whether a non-undefined callback result stopped iteration early. */
  readonly stopped: boolean;
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
   * Batch hooks are optimized forms of their matching single hooks. For each
   * plugin and phase, a batch call invokes the batch hook once when present;
   * otherwise LocalSpace maps the single hook over the entries. A plugin that
   * defines both forms is therefore never invoked twice for one phase.
   * Priority ordering is global across both hook forms.
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

  /**
   * Query and destructive-operation hooks are observers. Their return values
   * are ignored, and result collections are frozen copies, so they cannot
   * rewrite the public result. Before hooks run by descending priority; after
   * hooks run in reverse order.
   */
  beforeIterate?(context: PluginContext): Promise<void> | void;
  afterIterate?(
    summary: Readonly<PluginIterateSummary>,
    context: PluginContext
  ): Promise<void> | void;

  beforeKeys?(context: PluginContext): Promise<void> | void;
  afterKeys?(
    keys: readonly string[],
    context: PluginContext
  ): Promise<void> | void;

  beforeKey?(keyIndex: number, context: PluginContext): Promise<void> | void;
  afterKey?(
    keyIndex: number,
    key: string | null,
    context: PluginContext
  ): Promise<void> | void;

  beforeLength?(context: PluginContext): Promise<void> | void;
  afterLength?(length: number, context: PluginContext): Promise<void> | void;

  beforeClear?(context: PluginContext): Promise<void> | void;
  afterClear?(context: PluginContext): Promise<void> | void;

  beforeDropInstance?(
    options: LocalSpaceConfigSnapshot | undefined,
    context: PluginContext
  ): Promise<void> | void;
  afterDropInstance?(
    options: LocalSpaceConfigSnapshot | undefined,
    context: PluginContext
  ): Promise<void> | void;
}
