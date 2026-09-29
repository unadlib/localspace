import type {
  LocalSpaceConfig,
  LocalSpaceConfigSnapshot,
  ReactNativeAsyncStorage,
} from '../types.js';
import { createLocalSpaceError } from '../errors.js';

export type InternalConfigOptions = Partial<LocalSpaceConfig> & {
  size?: unknown;
  strictValues?: unknown;
  strictTransactions?: unknown;
  prewarmTransactions?: unknown;
  connectionIdleMs?: unknown;
  maxConcurrentTransactions?: unknown;
};

const INTEGER_OPTIONS = [
  'version',
  'maxBatchSize',
] as const satisfies ReadonlyArray<keyof InternalConfigOptions>;

const REMOVED_INDEXEDDB_OPTIONS = [
  'prewarmTransactions',
  'connectionIdleMs',
  'maxConcurrentTransactions',
] as const;

const validateIntegerOption = (
  key: (typeof INTEGER_OPTIONS)[number],
  value: unknown
): void => {
  if (key === 'version' && typeof value !== 'number') {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Database version must be a number.',
      { configKey: key, providedType: typeof value }
    );
  }

  const minimum = key === 'version' ? 1 : 0;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    const range = key === 'version' ? 'a positive' : 'a non-negative';
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      `Configuration option "${key}" must be ${range} integer.`,
      {
        configKey: key,
        providedType: typeof value,
        providedValue: value,
      }
    );
  }
};

const validateBucketOption = (value: unknown): void => {
  const invalid = (reason: string, details: Record<string, unknown> = {}) => {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Configuration option "bucket" must provide a valid Storage Bucket configuration.',
      { configKey: 'bucket', reason, ...details }
    );
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('invalid-bucket', { providedType: typeof value });
  }

  const bucket = value as Record<string, unknown>;
  if (typeof bucket.name !== 'string' || bucket.name.length === 0) {
    invalid('invalid-bucket-name', { providedType: typeof bucket.name });
  }
  if (
    bucket.durability !== undefined &&
    bucket.durability !== 'relaxed' &&
    bucket.durability !== 'strict'
  ) {
    invalid('invalid-bucket-durability', {
      providedValue: bucket.durability,
    });
  }
  if (
    bucket.persisted !== undefined &&
    typeof bucket.persisted !== 'boolean'
  ) {
    invalid('invalid-bucket-persisted', {
      providedType: typeof bucket.persisted,
    });
  }
};

export function normalizeConfigOptions(
  options: InternalConfigOptions
): InternalConfigOptions {
  if (Object.prototype.hasOwnProperty.call(options, 'size')) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Configuration option "size" was removed in LocalSpace 3.0.',
      { configKey: 'size', reason: 'removed-option' }
    );
  }
  if (Object.prototype.hasOwnProperty.call(options, 'strictValues')) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Configuration option "strictValues" was removed because LocalSpace 3.0 always validates StorageValue writes.',
      { configKey: 'strictValues', reason: 'removed-option' }
    );
  }
  if (Object.prototype.hasOwnProperty.call(options, 'strictTransactions')) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Configuration option "strictTransactions" was removed because LocalSpace 3.0 always enforces transaction-scope operations.',
      { configKey: 'strictTransactions', reason: 'removed-option' }
    );
  }
  for (const key of REMOVED_INDEXEDDB_OPTIONS) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        `Configuration option "${key}" was removed in LocalSpace 3.0.`,
        { configKey: key, reason: 'removed-option' }
      );
    }
  }

  const normalized: InternalConfigOptions = { ...options };

  const invalidChoice = (
    key: keyof InternalConfigOptions,
    value: unknown,
    supportedValues: readonly string[]
  ): never => {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      `Configuration option "${String(key)}" must be one of: ${supportedValues.join(', ')}.`,
      {
        configKey: key,
        providedValue: value,
        supportedValues,
      }
    );
  };

  for (const key of INTEGER_OPTIONS) {
    const value = options[key];
    if (value !== undefined) {
      validateIntegerOption(key, value);
    }
  }

  if (
    options.name !== undefined &&
    (typeof options.name !== 'string' || options.name.length === 0)
  ) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Database name must be a non-empty string.',
      { configKey: 'name', providedType: typeof options.name }
    );
  }

  if (
    options.description !== undefined &&
    typeof options.description !== 'string'
  ) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Database description must be a string.',
      { configKey: 'description', providedType: typeof options.description }
    );
  }

  if (
    options.durability !== undefined &&
    !['default', 'relaxed', 'strict'].includes(options.durability)
  ) {
    invalidChoice('durability', options.durability, [
      'default',
      'relaxed',
      'strict',
    ]);
  }
  if (
    options.pluginInitPolicy !== undefined &&
    !['fail', 'disable-and-continue'].includes(options.pluginInitPolicy)
  ) {
    invalidChoice('pluginInitPolicy', options.pluginInitPolicy, [
      'fail',
      'disable-and-continue',
    ]);
  }
  if (
    options.pluginErrorPolicy !== undefined &&
    !['strict', 'lenient'].includes(options.pluginErrorPolicy)
  ) {
    invalidChoice('pluginErrorPolicy', options.pluginErrorPolicy, [
      'strict',
      'lenient',
    ]);
  }

  if (options.storeName !== undefined) {
    if (
      typeof options.storeName !== 'string' ||
      options.storeName.length === 0
    ) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'Store name must be a non-empty string.',
        { configKey: 'storeName', providedType: typeof options.storeName }
      );
    }
    normalized.storeName = options.storeName;
  }

  if (options.driver !== undefined) {
    const requestedDrivers = Array.isArray(options.driver)
      ? options.driver
      : [options.driver];
    if (
      requestedDrivers.length === 0 ||
      requestedDrivers.some(
        (driver) => typeof driver !== 'string' || driver.length === 0
      )
    ) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'Configuration option "driver" must be a non-empty driver name or array of names.',
        { configKey: 'driver', reason: 'invalid-driver-selection' }
      );
    }
    normalized.driver = Array.isArray(options.driver)
      ? [...requestedDrivers]
      : requestedDrivers[0];
  }

  if (options.bucket !== undefined) {
    validateBucketOption(options.bucket);
    normalized.bucket = { ...options.bucket };
  }

  if (options.reactNativeAsyncStorage) {
    normalized.reactNativeAsyncStorage = snapshotAsyncStorageAdapter(
      options.reactNativeAsyncStorage
    );
  }

  return normalized;
}

const asyncStorageAdapterSources = new WeakMap<
  ReactNativeAsyncStorage,
  ReactNativeAsyncStorage
>();

/**
 * Returns the caller-supplied adapter behind an instance's frozen snapshot, so
 * instances configured with the same AsyncStorage can share driver state.
 */
export const getAsyncStorageAdapterSource = (
  adapter: ReactNativeAsyncStorage
): ReactNativeAsyncStorage =>
  asyncStorageAdapterSources.get(adapter) ?? adapter;

const snapshotAsyncStorageAdapter = (
  adapter: ReactNativeAsyncStorage
): ReactNativeAsyncStorage => {
  const snapshot: Partial<ReactNativeAsyncStorage> = {};
  for (const method of [
    'getItem',
    'setItem',
    'removeItem',
    'clear',
    'getAllKeys',
    'multiGet',
    'multiSet',
    'multiRemove',
  ] as const) {
    const implementation = adapter[method];
    if (typeof implementation === 'function') {
      Object.assign(snapshot, {
        [method]: implementation.bind(adapter),
      });
    }
  }
  const frozen = Object.freeze(snapshot) as ReactNativeAsyncStorage;
  asyncStorageAdapterSources.set(frozen, getAsyncStorageAdapterSource(adapter));
  return frozen;
};

export function createConfigSnapshot(
  config: LocalSpaceConfig
): LocalSpaceConfigSnapshot {
  const snapshot: LocalSpaceConfig = {
    ...config,
    ...(Array.isArray(config.driver)
      ? { driver: Object.freeze([...config.driver]) as unknown as string[] }
      : {}),
    ...(config.bucket ? { bucket: Object.freeze({ ...config.bucket }) } : {}),
  };
  const snapshotRecord = snapshot as LocalSpaceConfig & Record<string, unknown>;
  delete snapshotRecord.size;
  delete snapshotRecord.strictValues;
  delete snapshotRecord.strictTransactions;

  return Object.freeze(snapshot) as LocalSpaceConfigSnapshot;
}
