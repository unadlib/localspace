import type {
  Driver,
  DbInfo,
  LocalSpaceConfig,
  Serializer,
  LocalSpaceInstance,
  BatchItems,
  BatchResponse,
} from '../types.js';
import type { LocalSpaceErrorCode, LocalSpaceErrorDetails } from '../errors.js';
import { createLocalSpaceError, toLocalSpaceError } from '../errors.js';
import {
  normalizeBatchEntries,
  normalizeKey,
  chunkArray,
} from '../utils/helpers.js';
import serializer from '../utils/serializer.js';
import {
  createKeyOwnership,
  getStoreRegistryKey,
  parseStoreRegistry,
} from './store-registry.js';

type LocalStorageDbInfo = DbInfo & {
  keyPrefix: string;
  serializer: Serializer;
  namedStore: string | null;
};

type LocalStorageDriverContext = LocalSpaceInstance &
  Partial<Driver> & {
    _dbInfo: LocalStorageDbInfo;
    _config: LocalSpaceConfig;
    _defaultConfig: LocalSpaceConfig;
    ready(): Promise<void>;
    config(): LocalSpaceConfig;
  };

const DRIVER_NAME = 'localStorageWrapper';

const withLocalStorageErrorContext = <T>(
  promise: Promise<T>,
  operation: string,
  details?: LocalSpaceErrorDetails,
  code: LocalSpaceErrorCode = 'OPERATION_FAILED'
): Promise<T> =>
  promise.catch((error) => {
    const message =
      error instanceof Error && error.message
        ? error.message
        : `localStorage ${operation} failed`;
    throw toLocalSpaceError(error, code, message, {
      driver: DRIVER_NAME,
      operation,
      ...(details ?? {}),
    });
  });

function isLocalStorageValid(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      'setItem' in localStorage &&
      !!localStorage.setItem
    );
  } catch {
    return false;
  }
}

function getKeyPrefix(
  options: LocalSpaceConfig,
  defaultConfig: LocalSpaceConfig
): string {
  let keyPrefix = options.name + '/';

  if (options.storeName !== defaultConfig.storeName) {
    keyPrefix += options.storeName + '/';
  }
  return keyPrefix;
}

function readRegisteredStores(name: string): string[] {
  try {
    return parseStoreRegistry(localStorage.getItem(getStoreRegistryKey(name)));
  } catch {
    return [];
  }
}

function writeRegisteredStores(name: string, stores: string[]): void {
  try {
    const registryKey = getStoreRegistryKey(name);
    if (stores.length === 0) {
      localStorage.removeItem(registryKey);
    } else {
      localStorage.setItem(registryKey, JSON.stringify(stores));
    }
  } catch {
    // The registry is best-effort; storage failures must not block data access.
  }
}

// Checked on every write rather than cached: another instance or tab may have
// dropped the registry since this store last wrote.
function registerStore(dbInfo: LocalStorageDbInfo): void {
  const storeName = dbInfo.namedStore;
  if (storeName === null) {
    return;
  }
  const stores = readRegisteredStores(dbInfo.name!);
  if (!stores.includes(storeName)) {
    writeRegisteredStores(dbInfo.name!, [...stores, storeName]);
  }
}

function createOwnsKey(name: string, keyPrefix: string) {
  return createKeyOwnership(name, keyPrefix, readRegisteredStores(name));
}

// Native key order is not stable across mutations (Chromium reorders keys
// after a removal), so callers that mutate must snapshot matching keys first
// instead of walking indexes while removing.
function listKeys(ownsKey: (key: string) => boolean): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && ownsKey(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function checkIfLocalStorageThrows(): boolean {
  const localStorageTestKey = '_localforage_support_test';

  try {
    localStorage.setItem(localStorageTestKey, 'true');
    localStorage.removeItem(localStorageTestKey);
    return false;
  } catch {
    return true;
  }
}

function isLocalStorageUsable(): boolean {
  if (!checkIfLocalStorageThrows()) {
    return true;
  }
  // localStorage.setItem threw, but there may still be existing data
  // (e.g., quota exceeded). Wrap the length check since it can also throw
  // in privacy modes.
  try {
    return localStorage.length > 0;
  } catch {
    return false;
  }
}

async function _initStorage(
  this: LocalStorageDriverContext,
  config: LocalSpaceConfig
): Promise<void> {
  const dbInfo: LocalStorageDbInfo = {
    ...config,
    keyPrefix: getKeyPrefix(config, this._defaultConfig),
    serializer,
    namedStore:
      config.storeName !== this._defaultConfig.storeName
        ? config.storeName!
        : null,
  };

  if (!isLocalStorageUsable()) {
    throw createLocalSpaceError(
      'DRIVER_UNAVAILABLE',
      'localStorage not usable',
      { driver: DRIVER_NAME }
    );
  }

  this._dbInfo = dbInfo;
}

function clear(this: LocalStorageDriverContext): Promise<void> {
  const promise = withLocalStorageErrorContext(
    this.ready().then(() => {
      const ownsKey = createOwnsKey(this._dbInfo.name!, this._dbInfo.keyPrefix);
      for (const key of listKeys(ownsKey)) {
        localStorage.removeItem(key);
      }
    }),
    'clear'
  );

  return promise;
}

function getItem<T>(
  this: LocalStorageDriverContext,
  key: string
): Promise<T | null> {
  const normalizedKey = normalizeKey(key);

  const promise = withLocalStorageErrorContext(
    this.ready().then(() => {
      const dbInfo = this._dbInfo;
      const raw = localStorage.getItem(dbInfo.keyPrefix + normalizedKey);

      if (raw === null) {
        return null;
      }

      return dbInfo.serializer.deserialize(raw) as T;
    }),
    'getItem',
    { key: normalizedKey }
  );

  return promise;
}

function iterate<T, U>(
  this: LocalStorageDriverContext,
  iterator: (value: T, key: string, iterationNumber: number) => U | Promise<U>
): Promise<U | undefined> {
  const promise = withLocalStorageErrorContext(
    this.ready().then(async () => {
      const dbInfo = this._dbInfo;
      const keyPrefix = dbInfo.keyPrefix;
      const keyPrefixLength = keyPrefix.length;
      // Snapshot the namespace first: the awaited iterator may remove or add
      // entries, which shifts native localStorage indexes.
      const fullKeys = listKeys(createOwnsKey(dbInfo.name!, keyPrefix));
      let iterationNumber = 1;

      for (const key of fullKeys) {
        const rawValue = localStorage.getItem(key);
        if (rawValue === null) {
          continue;
        }

        const result = await iterator(
          dbInfo.serializer.deserialize(rawValue) as T,
          key.substring(keyPrefixLength),
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
  this: LocalStorageDriverContext,
  n: number
): Promise<string | null> {
  const promise = withLocalStorageErrorContext(
    this.ready().then(() => {
      const dbInfo = this._dbInfo;
      const keyPrefix = dbInfo.keyPrefix;
      const ownsKey = createOwnsKey(dbInfo.name!, keyPrefix);
      const keys: string[] = [];

      // Collect keys that match the prefix; keep native storage iteration order
      for (let i = 0; i < localStorage.length; i++) {
        const itemKey = localStorage.key(i);
        if (itemKey && ownsKey(itemKey)) {
          keys.push(itemKey.substring(keyPrefix.length));
        }
      }

      if (n < 0 || n >= keys.length) {
        return null;
      }

      return keys[n];
    }),
    'key',
    { keyIndex: n }
  );

  return promise;
}

function keys(this: LocalStorageDriverContext): Promise<string[]> {
  const promise = withLocalStorageErrorContext(
    this.ready().then(() => {
      const dbInfo = this._dbInfo;
      const ownsKey = createOwnsKey(dbInfo.name!, dbInfo.keyPrefix);
      const length = localStorage.length;
      const keys: string[] = [];

      for (let i = 0; i < length; i++) {
        const itemKey = localStorage.key(i);
        if (itemKey && ownsKey(itemKey)) {
          keys.push(itemKey.substring(dbInfo.keyPrefix.length));
        }
      }

      return keys;
    }),
    'keys'
  );

  return promise;
}

function length(this: LocalStorageDriverContext): Promise<number> {
  const promise = withLocalStorageErrorContext(
    keys.call(this).then((derivedKeys) => derivedKeys.length),
    'length'
  );

  return promise;
}

function removeItem(
  this: LocalStorageDriverContext,
  key: string
): Promise<void> {
  const normalizedKey = normalizeKey(key);

  const promise = withLocalStorageErrorContext(
    this.ready().then(() => {
      const dbInfo = this._dbInfo;
      localStorage.removeItem(dbInfo.keyPrefix + normalizedKey);
    }),
    'removeItem',
    { key: normalizedKey }
  );

  return promise;
}

function removeItems(
  this: LocalStorageDriverContext,
  keys: string[]
): Promise<void> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = withLocalStorageErrorContext(
    this.ready().then(() => {
      const dbInfo = this._dbInfo;
      const batchSize = dbInfo.maxBatchSize ?? normalizedKeys.length;

      for (const batch of chunkArray(normalizedKeys, batchSize)) {
        for (const key of batch) {
          localStorage.removeItem(dbInfo.keyPrefix + key);
        }
      }
    }),
    'removeItems',
    { keys: normalizedKeys }
  );

  return promise;
}

async function setItem<T>(
  this: LocalStorageDriverContext,
  key: string,
  value: T
): Promise<T> {
  const normalizedKey = normalizeKey(key);

  const promise = withLocalStorageErrorContext(
    this.ready().then(async () => {
      const normalizedValue = (value === undefined ? null : value) as T;
      const serializedValue =
        await this._dbInfo.serializer.serialize(normalizedValue);
      registerStore(this._dbInfo);

      try {
        localStorage.setItem(
          this._dbInfo.keyPrefix + normalizedKey,
          serializedValue
        );
        return normalizedValue;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.name === 'QuotaExceededError' ||
            error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
        ) {
          throw toLocalSpaceError(
            error,
            'QUOTA_EXCEEDED',
            error.message || 'Storage quota exceeded',
            { driver: DRIVER_NAME, operation: 'setItem', key: normalizedKey }
          );
        }
        throw toLocalSpaceError(
          error,
          'OPERATION_FAILED',
          'Failed to set item in localStorage',
          { driver: DRIVER_NAME, operation: 'setItem', key: normalizedKey }
        );
      }
    }),
    'setItem',
    { key: normalizedKey }
  );

  return promise;
}

function setItems<T>(
  this: LocalStorageDriverContext,
  items: BatchItems<T>
): Promise<BatchResponse<T>> {
  const normalized = normalizeBatchEntries(items);
  const itemKeys = normalized.map((entry) => entry.key);

  const promise = withLocalStorageErrorContext(
    this.ready().then(async () => {
      const dbInfo = this._dbInfo;
      const stored: BatchResponse<T> = [];
      const batchSize = dbInfo.maxBatchSize ?? normalized.length;
      const originals = new Map<string, string | null>();
      if (normalized.length > 0) {
        registerStore(dbInfo);
      }

      for (const batch of chunkArray(normalized, batchSize)) {
        for (const entry of batch) {
          const normalizedValue = (
            entry.value === undefined ? null : entry.value
          ) as T;
          const serializedValue =
            await dbInfo.serializer.serialize(normalizedValue);

          if (!originals.has(entry.key)) {
            originals.set(
              entry.key,
              localStorage.getItem(dbInfo.keyPrefix + entry.key)
            );
          }

          try {
            localStorage.setItem(dbInfo.keyPrefix + entry.key, serializedValue);
            stored.push({ key: entry.key, value: normalizedValue });
          } catch (error: unknown) {
            // Roll back keys written in this invocation
            for (const [key, prev] of originals.entries()) {
              const fullKey = dbInfo.keyPrefix + key;
              if (prev === null) {
                localStorage.removeItem(fullKey);
              } else {
                localStorage.setItem(fullKey, prev);
              }
            }

            if (
              error instanceof Error &&
              (error.name === 'QuotaExceededError' ||
                error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
            ) {
              throw toLocalSpaceError(
                error,
                'QUOTA_EXCEEDED',
                error.message || 'Storage quota exceeded',
                { driver: DRIVER_NAME, operation: 'setItems', key: entry.key }
              );
            }
            throw toLocalSpaceError(
              error,
              'OPERATION_FAILED',
              'Failed to set items in localStorage',
              { driver: DRIVER_NAME, operation: 'setItems', key: entry.key }
            );
          }
        }
      }

      return stored;
    }),
    'setItems',
    { keys: itemKeys }
  );

  return promise;
}

function getItems<T>(
  this: LocalStorageDriverContext,
  keys: string[]
): Promise<BatchResponse<T>> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = withLocalStorageErrorContext(
    this.ready().then(() => {
      const dbInfo = this._dbInfo;
      const results: BatchResponse<T> = [];
      const batchSize = dbInfo.maxBatchSize ?? normalizedKeys.length;

      for (const batch of chunkArray(normalizedKeys, batchSize)) {
        for (const key of batch) {
          const raw = localStorage.getItem(dbInfo.keyPrefix + key);
          if (raw === null) {
            results.push({ key, value: null });
            continue;
          }
          const value = dbInfo.serializer.deserialize(raw) as T;
          results.push({ key, value });
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
  this: LocalStorageDriverContext,
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
    : new Promise<void>((resolve) => {
        const name = effectiveOptions.name!;
        const storeName = effectiveOptions.storeName;
        const dropsDatabase = !storeName;
        const keyPrefix = dropsDatabase
          ? `${name}/`
          : getKeyPrefix(effectiveOptions, this._defaultConfig);
        const ownsKey = dropsDatabase
          ? (key: string) => key.indexOf(keyPrefix) === 0
          : createOwnsKey(name, keyPrefix);

        for (const key of listKeys(ownsKey)) {
          localStorage.removeItem(key);
        }
        if (dropsDatabase) {
          writeRegisteredStores(name, []);
        } else if (storeName !== this._defaultConfig.storeName) {
          writeRegisteredStores(
            name,
            readRegisteredStores(name).filter((store) => store !== storeName)
          );
        }
        resolve();
      });

  const wrapped = withLocalStorageErrorContext(promise, 'dropInstance', {
    name: effectiveOptions.name,
    storeName: effectiveOptions.storeName ?? this._defaultConfig.storeName,
  });

  return wrapped;
}

const localStorageWrapper: Driver = {
  _driver: 'localStorageWrapper',
  _initStorage,
  _support: async () => isLocalStorageValid(),
  _capabilities: {
    transactions: false,
    atomicBatch: false,
    dropInstance: true,
    persistent: true,
    storageBuckets: false,
  },
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

export default localStorageWrapper;
