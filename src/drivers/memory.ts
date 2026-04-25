import type {
  BatchItems,
  BatchResponse,
  Callback,
  DbInfo,
  Driver,
  KeyValuePair,
  LocalSpaceConfig,
  LocalSpaceInstance,
  Serializer,
  TransactionScope,
} from '../types';
import type { LocalSpaceErrorCode, LocalSpaceErrorDetails } from '../errors';
import { createLocalSpaceError, toLocalSpaceError } from '../errors';
import {
  chunkArray,
  executeCallback,
  normalizeBatchEntries,
  normalizeKey,
} from '../utils/helpers';
import serializer from '../utils/serializer';

type MemoryStore = Map<string, unknown>;

type MemoryDbInfo = DbInfo & {
  name: string;
  storeName: string;
  serializer: Serializer;
  store: MemoryStore;
};

type MemoryDriverContext = LocalSpaceInstance &
  Partial<Driver> & {
    _dbInfo: MemoryDbInfo;
    _defaultConfig: LocalSpaceConfig;
    ready(): Promise<void>;
    config(): LocalSpaceConfig;
  };

const DRIVER_NAME = 'memoryStorageWrapper';
const memoryDatabases: Record<string, Record<string, MemoryStore>> = {};

const withMemoryErrorContext = <T>(
  promise: Promise<T>,
  operation: string,
  details?: LocalSpaceErrorDetails,
  code: LocalSpaceErrorCode = 'OPERATION_FAILED'
): Promise<T> =>
  promise.catch((error) => {
    const message =
      error instanceof Error && error.message
        ? error.message
        : `memoryStorage ${operation} failed`;
    throw toLocalSpaceError(error, code, message, {
      driver: DRIVER_NAME,
      operation,
      ...(details ?? {}),
    });
  });

function requireName(config: LocalSpaceConfig): string {
  if (config.name) {
    return config.name;
  }
  throw createLocalSpaceError(
    'INVALID_CONFIG',
    'Memory storage database name is not configured.',
    { driver: DRIVER_NAME, configKey: 'name' }
  );
}

function requireStoreName(config: LocalSpaceConfig): string {
  if (config.storeName) {
    return config.storeName;
  }
  throw createLocalSpaceError(
    'INVALID_CONFIG',
    'Memory storage storeName is not configured.',
    { driver: DRIVER_NAME, configKey: 'storeName' }
  );
}

function getStore(name: string, storeName: string): MemoryStore {
  memoryDatabases[name] = memoryDatabases[name] || {};
  memoryDatabases[name][storeName] =
    memoryDatabases[name][storeName] || new Map();
  return memoryDatabases[name][storeName];
}

async function cloneValue<T>(value: T): Promise<T> {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  const serialized = await serializer.serialize(value);
  return serializer.deserialize(serialized) as T;
}

async function normalizeStoredValue<T>(value: T): Promise<T | null> {
  const normalized = value === undefined ? null : value;
  return cloneValue(normalized as T | null);
}

async function _initStorage(
  this: MemoryDriverContext,
  config: LocalSpaceConfig
): Promise<void> {
  const name = requireName(config);
  const storeName = requireStoreName(config);

  this._dbInfo = {
    ...config,
    name,
    storeName,
    serializer,
    store: getStore(name, storeName),
  };
}

function clear(
  this: MemoryDriverContext,
  callback?: Callback<void>
): Promise<void> {
  const promise = withMemoryErrorContext(
    this.ready().then(() => {
      this._dbInfo.store.clear();
    }),
    'clear'
  );

  executeCallback(promise, callback);
  return promise;
}

function getItem<T>(
  this: MemoryDriverContext,
  key: string,
  callback?: Callback<T>
): Promise<T | null> {
  const normalizedKey = normalizeKey(key);

  const promise = withMemoryErrorContext(
    this.ready().then(async () => {
      if (!this._dbInfo.store.has(normalizedKey)) {
        return null;
      }

      return cloneValue(this._dbInfo.store.get(normalizedKey) as T);
    }),
    'getItem',
    { key: normalizedKey }
  );

  executeCallback(
    promise as Promise<T | null>,
    callback as Callback<T | null> | undefined
  );
  return promise;
}

function getItems<T>(
  this: MemoryDriverContext,
  keys: string[],
  callback?: Callback<BatchResponse<T>>
): Promise<BatchResponse<T>> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = withMemoryErrorContext(
    this.ready().then(async () => {
      const results: BatchResponse<T> = [];
      const batchSize = this._dbInfo.maxBatchSize ?? normalizedKeys.length;

      for (const batch of chunkArray(normalizedKeys, batchSize)) {
        for (const key of batch) {
          if (!this._dbInfo.store.has(key)) {
            results.push({ key, value: null });
            continue;
          }

          const value = await cloneValue(this._dbInfo.store.get(key) as T);
          results.push({ key, value });
        }
      }

      return results;
    }),
    'getItems',
    { keys: normalizedKeys }
  );

  executeCallback(promise, callback);
  return promise;
}

function iterate<T, U>(
  this: MemoryDriverContext,
  iterator: (value: T, key: string, iterationNumber: number) => U,
  callback?: Callback<U>
): Promise<U> {
  const promise = withMemoryErrorContext(
    this.ready().then(async () => {
      let iterationNumber = 1;

      for (const [key, value] of this._dbInfo.store.entries()) {
        const result = iterator(
          (await cloneValue(value as T)) as T,
          key,
          iterationNumber++
        );
        if (result !== undefined) {
          return result;
        }
      }

      return undefined as U;
    }),
    'iterate'
  );

  executeCallback(promise, callback);
  return promise;
}

function key(
  this: MemoryDriverContext,
  n: number,
  callback?: Callback<string>
): Promise<string | null> {
  const promise = withMemoryErrorContext(
    this.ready().then(() => Array.from(this._dbInfo.store.keys())[n] ?? null),
    'key',
    { keyIndex: n }
  );

  executeCallback(promise, callback as Callback<string | null> | undefined);
  return promise;
}

function keys(
  this: MemoryDriverContext,
  callback?: Callback<string[]>
): Promise<string[]> {
  const promise = withMemoryErrorContext(
    this.ready().then(() => Array.from(this._dbInfo.store.keys())),
    'keys'
  );

  executeCallback(promise, callback);
  return promise;
}

function length(
  this: MemoryDriverContext,
  callback?: Callback<number>
): Promise<number> {
  const promise = withMemoryErrorContext(
    this.ready().then(() => this._dbInfo.store.size),
    'length'
  );

  executeCallback(promise, callback);
  return promise;
}

function removeItem(
  this: MemoryDriverContext,
  key: string,
  callback?: Callback<void>
): Promise<void> {
  const normalizedKey = normalizeKey(key);

  const promise = withMemoryErrorContext(
    this.ready().then(() => {
      this._dbInfo.store.delete(normalizedKey);
    }),
    'removeItem',
    { key: normalizedKey }
  );

  executeCallback(promise, callback);
  return promise;
}

function removeItems(
  this: MemoryDriverContext,
  keys: string[],
  callback?: Callback<void>
): Promise<void> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = withMemoryErrorContext(
    this.ready().then(() => {
      const batchSize = this._dbInfo.maxBatchSize ?? normalizedKeys.length;

      for (const batch of chunkArray(normalizedKeys, batchSize)) {
        for (const key of batch) {
          this._dbInfo.store.delete(key);
        }
      }
    }),
    'removeItems',
    { keys: normalizedKeys }
  );

  executeCallback(promise, callback);
  return promise;
}

function setItem<T>(
  this: MemoryDriverContext,
  key: string,
  value: T,
  callback?: Callback<T>
): Promise<T> {
  const normalizedKey = normalizeKey(key);

  const promise = withMemoryErrorContext(
    this.ready().then(async () => {
      const normalizedValue = await normalizeStoredValue(value);
      this._dbInfo.store.set(normalizedKey, normalizedValue);
      return normalizedValue as T;
    }),
    'setItem',
    { key: normalizedKey }
  );

  executeCallback(promise, callback);
  return promise;
}

function setItems<T>(
  this: MemoryDriverContext,
  items: BatchItems<T>,
  callback?: Callback<BatchResponse<T>>
): Promise<BatchResponse<T>> {
  const normalized = normalizeBatchEntries(items);
  const itemKeys = normalized.map((entry) => entry.key);

  const promise = withMemoryErrorContext(
    this.ready().then(async () => {
      const batchSize = this._dbInfo.maxBatchSize ?? normalized.length;
      const stored: BatchResponse<T> = [];

      for (const batch of chunkArray(normalized, batchSize)) {
        const payloads: Array<KeyValuePair<T | null>> = [];

        for (const entry of batch) {
          payloads.push({
            key: entry.key,
            value: await normalizeStoredValue(entry.value),
          });
        }

        for (const entry of payloads) {
          this._dbInfo.store.set(entry.key, entry.value);
          stored.push({ key: entry.key, value: entry.value as T });
        }
      }

      return stored;
    }),
    'setItems',
    { keys: itemKeys }
  );

  executeCallback(promise, callback);
  return promise;
}

function dropInstance(
  this: MemoryDriverContext,
  options?: LocalSpaceConfig,
  callback?: Callback<void>
): Promise<void> {
  const promise = withMemoryErrorContext(
    this.ready().then(() => {
      const current = this._dbInfo;
      const name = options?.name ?? current.name;

      if (!name) {
        throw createLocalSpaceError('INVALID_ARGUMENT', 'Invalid arguments', {
          driver: DRIVER_NAME,
          operation: 'dropInstance',
        });
      }

      const hasOptions = typeof options !== 'undefined';
      const hasStoreName = typeof options?.storeName === 'string';
      const storeName = hasStoreName ? options!.storeName! : current.storeName;

      const database = memoryDatabases[name];
      if (!database) {
        return;
      }

      if (!hasOptions || hasStoreName) {
        database[storeName]?.clear();
        return;
      }

      for (const store of Object.values(database)) {
        store.clear();
      }
    }),
    'dropInstance',
    {
      name: options?.name ?? this._dbInfo.name,
      storeName: options?.storeName ?? this._dbInfo.storeName,
    }
  );

  executeCallback(promise, callback);
  return promise;
}

function runTransaction<T>(
  this: MemoryDriverContext,
  mode: IDBTransactionMode,
  runner: (scope: TransactionScope) => Promise<T> | T,
  callback?: Callback<T>
): Promise<T> {
  const promise = withMemoryErrorContext(
    this.ready().then(async () => {
      const store = this._dbInfo.store;
      const snapshot = mode === 'readwrite' ? new Map(store) : null;

      const makeReadOnlyGuard = () => {
        if (mode === 'readonly') {
          throw createLocalSpaceError(
            'TRANSACTION_READONLY',
            'Transaction is readonly',
            {
              driver: DRIVER_NAME,
              operation: 'runTransaction',
              transactionMode: mode,
            }
          );
        }
      };

      const scope: TransactionScope = {
        get: async <V>(targetKey: string) => {
          const normalizedKey = normalizeKey(targetKey);
          if (!store.has(normalizedKey)) {
            return null;
          }
          return cloneValue(store.get(normalizedKey) as V);
        },
        set: async <V>(targetKey: string, value: V) => {
          makeReadOnlyGuard();
          const normalizedKey = normalizeKey(targetKey);
          const normalizedValue = await normalizeStoredValue(value);
          store.set(normalizedKey, normalizedValue);
          return normalizedValue as V;
        },
        remove: async (targetKey: string) => {
          makeReadOnlyGuard();
          store.delete(normalizeKey(targetKey));
        },
        keys: async () => Array.from(store.keys()),
        iterate: async <V, U>(
          iterator: (value: V, key: string, iterationNumber: number) => U
        ) => {
          let iterationNumber = 1;
          for (const [entryKey, entryValue] of store.entries()) {
            const result = iterator(
              (await cloneValue(entryValue as V)) as V,
              entryKey,
              iterationNumber++
            );
            if (result !== undefined) {
              return result;
            }
          }
          return undefined as U;
        },
        clear: async () => {
          makeReadOnlyGuard();
          store.clear();
        },
      };

      try {
        return await runner(scope);
      } catch (error) {
        if (snapshot) {
          store.clear();
          for (const [entryKey, entryValue] of snapshot.entries()) {
            store.set(entryKey, entryValue);
          }
        }
        throw error;
      }
    }),
    'runTransaction',
    { transactionMode: mode }
  );

  executeCallback(promise, callback);
  return promise;
}

const memoryStorageWrapper: Driver = {
  _driver: DRIVER_NAME,
  _initStorage,
  _support: true,
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
  runTransaction,
  dropInstance,
};

export default memoryStorageWrapper;
