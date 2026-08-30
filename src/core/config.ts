import type {
  LocalSpaceConfig,
  LocalSpaceConfigSnapshot,
  ReactNativeAsyncStorage,
} from '../types.js';
import { createLocalSpaceError } from '../errors.js';

export type InternalConfigOptions = Partial<LocalSpaceConfig> & {
  prewarmTransactions?: boolean;
  connectionIdleMs?: number;
  maxConcurrentTransactions?: number;
  size?: unknown;
};

const INTEGER_OPTIONS = [
  'version',
  'maxBatchSize',
  'connectionIdleMs',
  'maxConcurrentTransactions',
] as const satisfies ReadonlyArray<keyof InternalConfigOptions>;

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

  const normalized: InternalConfigOptions = { ...options };

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

  if (Array.isArray(options.driver)) {
    normalized.driver = [...options.driver];
  }

  if (options.bucket) {
    normalized.bucket = { ...options.bucket };
  }

  if (options.reactNativeAsyncStorage) {
    normalized.reactNativeAsyncStorage = snapshotAsyncStorageAdapter(
      options.reactNativeAsyncStorage
    );
  }

  if (
    options.strictValues !== undefined &&
    typeof options.strictValues !== 'boolean'
  ) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Configuration option "strictValues" must be a boolean.',
      {
        configKey: 'strictValues',
        providedType: typeof options.strictValues,
      }
    );
  }

  return normalized;
}

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
  return Object.freeze(snapshot) as ReactNativeAsyncStorage;
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
  const snapshotRecord = snapshot as LocalSpaceConfig &
    Record<string, unknown>;
  delete snapshotRecord.prewarmTransactions;
  delete snapshotRecord.connectionIdleMs;
  delete snapshotRecord.maxConcurrentTransactions;
  delete snapshotRecord.size;

  return Object.freeze(snapshot) as LocalSpaceConfigSnapshot;
}
