import type {
  Driver,
  DbInfo,
  LocalSpaceConfig,
  Serializer,
  LocalSpaceInstance,
  BatchItems,
  BatchResponse,
  ReactNativeAsyncStorage,
} from '../types.js';
import type { LocalSpaceErrorCode, LocalSpaceErrorDetails } from '../errors.js';
import { createLocalSpaceError, toLocalSpaceError } from '../errors.js';
import {
  normalizeBatchEntries,
  normalizeKey,
  chunkArray,
} from '../utils/helpers.js';
import serializer from '../utils/serializer.js';

type ReactNativeAsyncStorageDbInfo = DbInfo & {
  keyPrefix: string;
  serializer: Serializer;
  asyncStorage: ReactNativeAsyncStorage;
};

type ReactNativeAsyncStorageDriverContext = LocalSpaceInstance &
  Partial<Driver> & {
    _dbInfo: ReactNativeAsyncStorageDbInfo;
    _config: LocalSpaceConfig;
    _defaultConfig: LocalSpaceConfig;
    ready(): Promise<void>;
    config(): LocalSpaceConfig;
  };

const DRIVER_NAME = 'reactNativeAsyncStorageWrapper';

const withAsyncStorageErrorContext = <T>(
  promise: Promise<T>,
  operation: string,
  details?: LocalSpaceErrorDetails,
  code: LocalSpaceErrorCode = 'OPERATION_FAILED'
): Promise<T> =>
  promise.catch((error) => {
    const message =
      error instanceof Error && error.message
        ? error.message
        : `React Native AsyncStorage ${operation} failed`;
    throw toLocalSpaceError(error, code, message, {
      driver: DRIVER_NAME,
      operation,
      ...(details ?? {}),
    });
  });

function isAsyncStorageLike(value: unknown): value is ReactNativeAsyncStorage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeStorage = value as Record<string, unknown>;
  return (
    typeof maybeStorage.getItem === 'function' &&
    typeof maybeStorage.setItem === 'function' &&
    typeof maybeStorage.removeItem === 'function' &&
    typeof maybeStorage.getAllKeys === 'function'
  );
}

function getKeyPrefix(
  options: LocalSpaceConfig,
  defaultConfig: LocalSpaceConfig
): string {
  let keyPrefix = `${options.name}/`;

  if (options.storeName !== defaultConfig.storeName) {
    keyPrefix += `${options.storeName}/`;
  }

  return keyPrefix;
}

function resolveConfiguredAsyncStorage(
  config: LocalSpaceConfig
): ReactNativeAsyncStorage {
  const configuredStorage = config.reactNativeAsyncStorage;
  if (configuredStorage == null) {
    throw createLocalSpaceError(
      'DRIVER_UNAVAILABLE',
      'React Native AsyncStorage requires an explicit reactNativeAsyncStorage adapter.',
      {
        configKey: 'reactNativeAsyncStorage',
        driver: DRIVER_NAME,
        operation: 'initialize',
        reason: 'adapter-not-configured',
      }
    );
  }

  if (!isAsyncStorageLike(configuredStorage)) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'reactNativeAsyncStorage must implement getItem, setItem, removeItem, and getAllKeys.',
      {
        configKey: 'reactNativeAsyncStorage',
        driver: DRIVER_NAME,
        operation: 'initialize',
        reason: 'adapter-invalid',
      }
    );
  }

  return configuredStorage;
}

async function getAllKeysFromStorage(
  dbInfo: ReactNativeAsyncStorageDbInfo,
  operation: string
): Promise<string[]> {
  if (typeof dbInfo.asyncStorage.getAllKeys !== 'function') {
    throw createLocalSpaceError(
      'UNSUPPORTED_OPERATION',
      'React Native AsyncStorage adapter must implement getAllKeys() for this operation.',
      {
        driver: DRIVER_NAME,
        operation,
      }
    );
  }

  return dbInfo.asyncStorage.getAllKeys();
}

async function getNamespacedKeys(
  dbInfo: ReactNativeAsyncStorageDbInfo,
  operation: string
): Promise<string[]> {
  const allKeys = await getAllKeysFromStorage(dbInfo, operation);
  return allKeys.filter((key) => key.indexOf(dbInfo.keyPrefix) === 0);
}

async function removeStoredKeys(
  dbInfo: ReactNativeAsyncStorageDbInfo,
  fullKeys: string[]
): Promise<void> {
  if (fullKeys.length === 0) {
    return;
  }

  const batchSize = dbInfo.maxBatchSize ?? fullKeys.length;

  if (typeof dbInfo.asyncStorage.multiRemove === 'function') {
    for (const batch of chunkArray(fullKeys, batchSize)) {
      await dbInfo.asyncStorage.multiRemove(batch);
    }
    return;
  }

  for (const batch of chunkArray(fullKeys, batchSize)) {
    for (const key of batch) {
      await dbInfo.asyncStorage.removeItem(key);
    }
  }
}

function isQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = `${error.name} ${error.message}`.toLowerCase();
  return code.indexOf('quota') !== -1;
}

async function _initStorage(
  this: ReactNativeAsyncStorageDriverContext,
  config: LocalSpaceConfig
): Promise<void> {
  const asyncStorage = resolveConfiguredAsyncStorage(config);
  const dbInfo: ReactNativeAsyncStorageDbInfo = {
    ...config,
    keyPrefix: getKeyPrefix(config, this._defaultConfig),
    serializer,
    asyncStorage,
  };

  this._dbInfo = dbInfo;
}

function clear(this: ReactNativeAsyncStorageDriverContext): Promise<void> {
  const promise = withAsyncStorageErrorContext(
    this.ready().then(async () => {
      const namespacedKeys = await getNamespacedKeys(this._dbInfo, 'clear');
      await removeStoredKeys(this._dbInfo, namespacedKeys);
    }),
    'clear'
  );

  return promise;
}

function getItem<T>(
  this: ReactNativeAsyncStorageDriverContext,
  key: string
): Promise<T | null> {
  const normalizedKey = normalizeKey(key);

  const promise = withAsyncStorageErrorContext(
    this.ready().then(async () => {
      const raw = await this._dbInfo.asyncStorage.getItem(
        this._dbInfo.keyPrefix + normalizedKey
      );

      if (raw === null) {
        return null;
      }

      return this._dbInfo.serializer.deserialize(raw) as T;
    }),
    'getItem',
    { key: normalizedKey }
  );

  return promise;
}

function iterate<T, U>(
  this: ReactNativeAsyncStorageDriverContext,
  iterator: (value: T, key: string, iterationNumber: number) => U
): Promise<U | undefined> {
  const promise = withAsyncStorageErrorContext(
    this.ready().then(async () => {
      const dbInfo = this._dbInfo;
      const namespacedKeys = await getNamespacedKeys(dbInfo, 'iterate');
      const prefixLength = dbInfo.keyPrefix.length;

      let iterationNumber = 1;
      for (const fullKey of namespacedKeys) {
        const rawValue = await dbInfo.asyncStorage.getItem(fullKey);
        const value =
          rawValue === null
            ? null
            : (dbInfo.serializer.deserialize(rawValue) as T);

        const result = iterator(
          value as T,
          fullKey.substring(prefixLength),
          iterationNumber++
        );

        if (result !== undefined) {
          return result;
        }
      }

      return undefined;
    }),
    'iterate'
  );

  return promise;
}

function key(
  this: ReactNativeAsyncStorageDriverContext,
  n: number
): Promise<string | null> {
  const promise = withAsyncStorageErrorContext(
    keys.call(this).then((allKeys) => {
      if (n < 0 || n >= allKeys.length) {
        return null;
      }
      return allKeys[n];
    }),
    'key',
    { keyIndex: n }
  );

  return promise;
}

function keys(this: ReactNativeAsyncStorageDriverContext): Promise<string[]> {
  const promise = withAsyncStorageErrorContext(
    this.ready().then(async () => {
      const namespacedKeys = await getNamespacedKeys(this._dbInfo, 'keys');
      const prefixLength = this._dbInfo.keyPrefix.length;
      return namespacedKeys.map((fullKey) => fullKey.substring(prefixLength));
    }),
    'keys'
  );

  return promise;
}

function length(this: ReactNativeAsyncStorageDriverContext): Promise<number> {
  const promise = withAsyncStorageErrorContext(
    keys.call(this).then((derivedKeys) => derivedKeys.length),
    'length'
  );

  return promise;
}

function removeItem(
  this: ReactNativeAsyncStorageDriverContext,
  key: string
): Promise<void> {
  const normalizedKey = normalizeKey(key);

  const promise = withAsyncStorageErrorContext(
    this.ready().then(() =>
      this._dbInfo.asyncStorage.removeItem(
        this._dbInfo.keyPrefix + normalizedKey
      )
    ),
    'removeItem',
    { key: normalizedKey }
  );

  return promise;
}

function removeItems(
  this: ReactNativeAsyncStorageDriverContext,
  keys: string[]
): Promise<void> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = withAsyncStorageErrorContext(
    this.ready().then(async () => {
      const fullKeys = normalizedKeys.map(
        (key) => this._dbInfo.keyPrefix + key
      );
      await removeStoredKeys(this._dbInfo, fullKeys);
    }),
    'removeItems',
    { keys: normalizedKeys }
  );

  return promise;
}

async function setItem<T>(
  this: ReactNativeAsyncStorageDriverContext,
  key: string,
  value: T
): Promise<T> {
  const normalizedKey = normalizeKey(key);

  const promise = withAsyncStorageErrorContext(
    this.ready().then(async () => {
      const normalizedValue = (value === undefined ? null : value) as T;
      const serializedValue =
        await this._dbInfo.serializer.serialize(normalizedValue);

      try {
        await this._dbInfo.asyncStorage.setItem(
          this._dbInfo.keyPrefix + normalizedKey,
          serializedValue
        );
      } catch (error: unknown) {
        if (isQuotaExceeded(error)) {
          throw toLocalSpaceError(
            error,
            'QUOTA_EXCEEDED',
            (error as Error).message || 'Storage quota exceeded',
            { driver: DRIVER_NAME, operation: 'setItem', key: normalizedKey }
          );
        }

        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to set item in React Native AsyncStorage',
          { driver: DRIVER_NAME, operation: 'setItem', key: normalizedKey }
        );
      }

      return normalizedValue;
    }),
    'setItem',
    { key: normalizedKey }
  );

  return promise;
}

function setItems<T>(
  this: ReactNativeAsyncStorageDriverContext,
  items: BatchItems<T>
): Promise<BatchResponse<T>> {
  const normalized = normalizeBatchEntries(items);
  const itemKeys = normalized.map((entry) => entry.key);

  const promise = withAsyncStorageErrorContext(
    this.ready().then(async () => {
      const dbInfo = this._dbInfo;
      const batchSize = dbInfo.maxBatchSize ?? normalized.length;
      const stored: BatchResponse<T> = [];
      const serializedPairs: Array<[string, string]> = [];

      for (const entry of normalized) {
        const normalizedValue = (
          entry.value === undefined ? null : entry.value
        ) as T;
        const serializedValue =
          await dbInfo.serializer.serialize(normalizedValue);
        serializedPairs.push([dbInfo.keyPrefix + entry.key, serializedValue]);
        stored.push({ key: entry.key, value: normalizedValue });
      }

      try {
        if (typeof dbInfo.asyncStorage.multiSet === 'function') {
          for (const batch of chunkArray(serializedPairs, batchSize)) {
            await dbInfo.asyncStorage.multiSet(batch);
          }
        } else {
          for (const [fullKey, serializedValue] of serializedPairs) {
            await dbInfo.asyncStorage.setItem(fullKey, serializedValue);
          }
        }
      } catch (error: unknown) {
        if (isQuotaExceeded(error)) {
          throw toLocalSpaceError(
            error,
            'QUOTA_EXCEEDED',
            (error as Error).message || 'Storage quota exceeded',
            { driver: DRIVER_NAME, operation: 'setItems' }
          );
        }

        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to set items in React Native AsyncStorage',
          { driver: DRIVER_NAME, operation: 'setItems' }
        );
      }

      return stored;
    }),
    'setItems',
    { keys: itemKeys }
  );

  return promise;
}

function getItems<T>(
  this: ReactNativeAsyncStorageDriverContext,
  keys: string[]
): Promise<BatchResponse<T>> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = withAsyncStorageErrorContext(
    this.ready().then(async () => {
      const dbInfo = this._dbInfo;
      const results: BatchResponse<T> = [];
      const batchSize = dbInfo.maxBatchSize ?? normalizedKeys.length;

      if (typeof dbInfo.asyncStorage.multiGet === 'function') {
        for (const batch of chunkArray(normalizedKeys, batchSize)) {
          const fullBatch = batch.map((key) => dbInfo.keyPrefix + key);
          const rawEntries = await dbInfo.asyncStorage.multiGet(fullBatch);
          const entriesMap = new Map<string, string | null>(rawEntries);

          for (const key of batch) {
            const raw = entriesMap.get(dbInfo.keyPrefix + key) ?? null;
            if (raw === null) {
              results.push({ key, value: null });
              continue;
            }
            results.push({
              key,
              value: dbInfo.serializer.deserialize(raw) as T,
            });
          }
        }
      } else {
        for (const key of normalizedKeys) {
          const raw = await dbInfo.asyncStorage.getItem(dbInfo.keyPrefix + key);
          if (raw === null) {
            results.push({ key, value: null });
            continue;
          }
          results.push({ key, value: dbInfo.serializer.deserialize(raw) as T });
        }
      }

      return results;
    }),
    'getItems',
    { keys: normalizedKeys }
  );

  return promise;
}

function dropInstance(
  this: ReactNativeAsyncStorageDriverContext,
  options?: LocalSpaceConfig
): Promise<void> {
  const effectiveOptions: LocalSpaceConfig = { ...(options || {}) };

  if (!effectiveOptions.name) {
    const currentConfig = this._config;
    effectiveOptions.name = currentConfig.name;
    effectiveOptions.storeName = currentConfig.storeName;
  }

  const promise = !effectiveOptions.name
    ? Promise.reject(
        createLocalSpaceError('INVALID_ARGUMENT', 'Invalid arguments', {
          driver: DRIVER_NAME,
          operation: 'dropInstance',
        })
      )
    : this.ready().then(async () => {
        const keyPrefix = !effectiveOptions.storeName
          ? `${effectiveOptions.name}/`
          : getKeyPrefix(effectiveOptions, this._defaultConfig);

        const allKeys = await getAllKeysFromStorage(
          this._dbInfo,
          'dropInstance'
        );
        const targetKeys = allKeys.filter(
          (key) => key.indexOf(keyPrefix) === 0
        );
        await removeStoredKeys(this._dbInfo, targetKeys);
      });

  const wrapped = withAsyncStorageErrorContext(promise, 'dropInstance', {
    name: effectiveOptions.name,
    storeName: effectiveOptions.storeName ?? this._defaultConfig.storeName,
  });

  return wrapped;
}

const reactNativeAsyncStorageWrapper: Driver = {
  _driver: DRIVER_NAME,
  _initStorage,
  _support: true,
  _capabilities: () => ({
    transactions: false,
    atomicBatch: false,
    dropInstance: true,
    persistent: true,
    storageBuckets: false,
  }),
  iterate,
  getItem,
  getItems,
  setItem,
  setItems,
  removeItem,
  removeItems,
  clear,
  length,
  key,
  keys,
  dropInstance,
};

export default reactNativeAsyncStorageWrapper;
