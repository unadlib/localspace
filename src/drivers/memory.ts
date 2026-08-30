import type {
  BatchItems,
  BatchResponse,
  DbInfo,
  Driver,
  KeyValuePair,
  LocalSpaceConfig,
  LocalSpaceInstance,
  Serializer,
  TransactionMode,
  TransactionScope,
} from '../types.js';
import type { LocalSpaceErrorCode, LocalSpaceErrorDetails } from '../errors.js';
import { createLocalSpaceError, toLocalSpaceError } from '../errors.js';
import {
  chunkArray,
  normalizeBatchEntries,
  normalizeKey,
} from '../utils/helpers.js';
import serializer from '../utils/serializer.js';

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
    _config: LocalSpaceConfig;
    _defaultConfig: LocalSpaceConfig;
    ready(): Promise<void>;
    config(): LocalSpaceConfig;
  };

const DRIVER_NAME = 'memoryStorageWrapper';
const memoryDatabases: Record<string, Record<string, MemoryStore>> = {};
type MemoryStoreScheduler = {
  tail: Promise<void>;
};
const memoryStoreSchedulers = new WeakMap<MemoryStore, MemoryStoreScheduler>();

const getStoreScheduler = (store: MemoryStore): MemoryStoreScheduler => {
  const existing = memoryStoreSchedulers.get(store);
  if (existing) {
    return existing;
  }
  const created: MemoryStoreScheduler = { tail: Promise.resolve() };
  memoryStoreSchedulers.set(store, created);
  return created;
};

const runStoreOperation = <T>(
  store: MemoryStore,
  operation: () => Promise<T> | T
): Promise<T> => {
  const scheduler = getStoreScheduler(store);
  const result = scheduler.tail.then(operation);
  scheduler.tail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
};

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

function clear(this: MemoryDriverContext): Promise<void> {
  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, () => {
        this._dbInfo.store.clear();
      })
    ),
    'clear'
  );

  return promise;
}

function getItem<T>(this: MemoryDriverContext, key: string): Promise<T | null> {
  const normalizedKey = normalizeKey(key);

  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, async () => {
        if (!this._dbInfo.store.has(normalizedKey)) {
          return null;
        }

        return cloneValue(this._dbInfo.store.get(normalizedKey) as T);
      })
    ),
    'getItem',
    { key: normalizedKey }
  );

  return promise;
}

function getItems<T>(
  this: MemoryDriverContext,
  keys: string[]
): Promise<BatchResponse<T>> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, async () => {
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
      })
    ),
    'getItems',
    { keys: normalizedKeys }
  );

  return promise;
}

function iterate<T, U>(
  this: MemoryDriverContext,
  iterator: (value: T, key: string, iterationNumber: number) => U | Promise<U>
): Promise<U | undefined> {
  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, async () => {
        let iterationNumber = 1;

        for (const [key, value] of this._dbInfo.store.entries()) {
          const result = await iterator(
            (await cloneValue(value as T)) as T,
            key,
            iterationNumber++
          );
          if (result !== undefined) {
            return result;
          }
        }

        return undefined;
      })
    ),
    'iterate'
  );

  return promise;
}

function key(this: MemoryDriverContext, n: number): Promise<string | null> {
  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(
        this._dbInfo.store,
        () => Array.from(this._dbInfo.store.keys())[n] ?? null
      )
    ),
    'key',
    { keyIndex: n }
  );

  return promise;
}

function keys(this: MemoryDriverContext): Promise<string[]> {
  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, () =>
        Array.from(this._dbInfo.store.keys())
      )
    ),
    'keys'
  );

  return promise;
}

function length(this: MemoryDriverContext): Promise<number> {
  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, () => this._dbInfo.store.size)
    ),
    'length'
  );

  return promise;
}

function removeItem(this: MemoryDriverContext, key: string): Promise<void> {
  const normalizedKey = normalizeKey(key);

  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, () => {
        this._dbInfo.store.delete(normalizedKey);
      })
    ),
    'removeItem',
    { key: normalizedKey }
  );

  return promise;
}

function removeItems(this: MemoryDriverContext, keys: string[]): Promise<void> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, () => {
        const batchSize = this._dbInfo.maxBatchSize ?? normalizedKeys.length;

        for (const batch of chunkArray(normalizedKeys, batchSize)) {
          for (const key of batch) {
            this._dbInfo.store.delete(key);
          }
        }
      })
    ),
    'removeItems',
    { keys: normalizedKeys }
  );

  return promise;
}

function setItem<T>(
  this: MemoryDriverContext,
  key: string,
  value: T
): Promise<T> {
  const normalizedKey = normalizeKey(key);

  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, async () => {
        const normalizedValue = await normalizeStoredValue(value);
        this._dbInfo.store.set(normalizedKey, normalizedValue);
        return normalizedValue as T;
      })
    ),
    'setItem',
    { key: normalizedKey }
  );

  return promise;
}

function setItems<T>(
  this: MemoryDriverContext,
  items: BatchItems<T>
): Promise<BatchResponse<T>> {
  const normalized = normalizeBatchEntries(items);
  const itemKeys = normalized.map((entry) => entry.key);

  const promise = withMemoryErrorContext(
    this.ready().then(() =>
      runStoreOperation(this._dbInfo.store, async () => {
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
      })
    ),
    'setItems',
    { keys: itemKeys }
  );

  return promise;
}

function dropInstance(
  this: MemoryDriverContext,
  options?: LocalSpaceConfig
): Promise<void> {
  const promise = withMemoryErrorContext(
    this.ready().then(async () => {
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
        const store = database[storeName];
        if (store) {
          await runStoreOperation(store, () => store.clear());
        }
        return;
      }

      await Promise.all(
        Object.values(database).map((store) =>
          runStoreOperation(store, () => store.clear())
        )
      );
    }),
    'dropInstance',
    {
      name: options?.name ?? this._dbInfo.name,
      storeName: options?.storeName ?? this._dbInfo.storeName,
    }
  );

  return promise;
}

function runTransaction<T>(
  this: MemoryDriverContext,
  mode: TransactionMode,
  runner: (scope: TransactionScope) => Promise<T> | T
): Promise<T> {
  const promise = withMemoryErrorContext(
    this.ready().then(() => {
      if (mode !== 'readonly' && mode !== 'readwrite') {
        throw createLocalSpaceError(
          'INVALID_ARGUMENT',
          `Unsupported transaction mode: ${String(mode)}`,
          {
            driver: DRIVER_NAME,
            operation: 'runTransaction',
            transactionMode: String(mode),
          }
        );
      }

      const committedStore = this._dbInfo.store;
      return runStoreOperation(committedStore, async () => {
        const transactionStore =
          mode === 'readwrite' ? new Map(committedStore) : committedStore;

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
            if (!transactionStore.has(normalizedKey)) {
              return null;
            }
            return cloneValue(transactionStore.get(normalizedKey) as V);
          },
          set: async <V>(targetKey: string, value: V) => {
            makeReadOnlyGuard();
            const normalizedKey = normalizeKey(targetKey);
            const normalizedValue = await normalizeStoredValue(value);
            transactionStore.set(normalizedKey, normalizedValue);
            return normalizedValue as V;
          },
          remove: async (targetKey: string) => {
            makeReadOnlyGuard();
            transactionStore.delete(normalizeKey(targetKey));
          },
          keys: async () => Array.from(transactionStore.keys()),
          iterate: async <V, U>(
            iterator: (
              value: V,
              key: string,
              iterationNumber: number
            ) => U | Promise<U>
          ) => {
            let iterationNumber = 1;
            for (const [entryKey, entryValue] of transactionStore.entries()) {
              const result = await iterator(
                (await cloneValue(entryValue as V)) as V,
                entryKey,
                iterationNumber++
              );
              if (result !== undefined) {
                return result;
              }
            }
            return undefined;
          },
          clear: async () => {
            makeReadOnlyGuard();
            transactionStore.clear();
          },
        };

        const result = await runner(scope);
        if (mode === 'readwrite') {
          committedStore.clear();
          for (const [entryKey, entryValue] of transactionStore.entries()) {
            committedStore.set(entryKey, entryValue);
          }
        }
        return result;
      });
    }),
    'runTransaction',
    { transactionMode: mode }
  );

  return promise;
}

const memoryStorageWrapper: Driver = {
  _driver: DRIVER_NAME,
  _initStorage,
  _support: true,
  _capabilities: {
    transactions: true,
    atomicBatch: false,
    dropInstance: true,
    persistent: false,
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
  runTransaction,
  dropInstance,
};

export default memoryStorageWrapper;
