import type {
  Driver,
  DbInfo,
  LocalSpaceConfig,
  Callback,
  LocalSpaceInstance,
  BatchItems,
  BatchResponse,
  KeyValuePair,
  TransactionScope,
} from '../types';
import {
  executeCallback,
  normalizeBatchEntries,
  normalizeKey,
  createBlob,
  chunkArray,
} from '../utils/helpers';
import serializer from '../utils/serializer';

type IndexedDBDriverContext = LocalSpaceInstance &
  Partial<Driver> & {
    _dbInfo: DbInfo;
    _defaultConfig: LocalSpaceConfig;
    _initReady?: () => Promise<void>;
    ready(): Promise<void>;
    config(): LocalSpaceConfig;
  };

const DETECT_BLOB_SUPPORT_STORE = 'local-forage-detect-blob-support';
let supportsBlobs: boolean | undefined;
const dbContexts: Record<string, DbContext> = {};
const toString = Object.prototype.toString;

const READ_ONLY = 'readonly';
const READ_WRITE = 'readwrite';
let detectBlobSupportPromise: Promise<boolean> | null = null;

const getNavigatorObject = (): Navigator | undefined => {
  if (typeof window !== 'undefined' && window.navigator) {
    return window.navigator;
  }

  if (typeof navigator !== 'undefined') {
    return navigator;
  }

  return undefined;
};

interface DbContext {
  forages: IndexedDBDriverContext[];
  db: IDBDatabase | null;
  dbReady: Promise<void> | null;
  deferredOperations: DeferredOperation[];
}

interface DeferredOperation {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function getDefaultIDB(): IDBFactory | null {
  if (typeof indexedDB !== 'undefined') {
    return indexedDB;
  }
  if (typeof window !== 'undefined') {
    return (
      window.indexedDB ||
      window.webkitIndexedDB ||
      window.mozIndexedDB ||
      window.OIndexedDB ||
      window.msIndexedDB ||
      null
    );
  }
  return null;
}

function getIDB(dbInfo?: DbInfo): IDBFactory | null {
  if (dbInfo?.idbFactory) {
    return dbInfo.idbFactory;
  }
  return getDefaultIDB();
}

function isIndexedDBValid(): boolean | Promise<boolean> {
  try {
    const idb = getDefaultIDB();
    if (!idb) return false;

    // Check if IndexedDB is available and functional
    const nav = getNavigatorObject();
    const userAgent = nav?.userAgent ?? '';
    const isSafari =
      !!nav && /Safari/.test(userAgent) && !/Chrome/.test(userAgent);

    // Safari private browsing mode throws when trying to access indexedDB
    if (isSafari) {
      return new Promise((resolve) => {
        const openRequest = idb.open('__localforage_test');
        openRequest.onsuccess = () => {
          openRequest.result.close();
          idb.deleteDatabase('__localforage_test');
          resolve(true);
        };
        openRequest.onerror = () => resolve(false);
      });
    }

    return true;
  } catch (e) {
    return false;
  }
}

async function resolveIdbFactory(
  config: LocalSpaceConfig
): Promise<IDBFactory | null> {
  if (config.bucket?.name) {
    const nav =
      typeof navigator !== 'undefined' ? (navigator as Navigator) : undefined;
    const buckets = nav?.storageBuckets;

    if (buckets && typeof buckets.open === 'function') {
      try {
        const bucket = await buckets.open(config.bucket.name, {
          durability: config.bucket.durability,
          persisted: config.bucket.persisted,
        });
        return bucket.indexedDB ?? null;
      } catch (error) {
        console.warn(
          `Failed to open storage bucket "${config.bucket.name}", falling back to default bucket.`,
          error
        );
      }
    }
  }

  return getDefaultIDB();
}

function checkBlobSupport(db: IDBDatabase): Promise<boolean> {
  if (typeof supportsBlobs === 'boolean') {
    return Promise.resolve(supportsBlobs);
  }

  if (detectBlobSupportPromise) {
    return detectBlobSupportPromise;
  }

  detectBlobSupportPromise = new Promise<boolean>((resolve) => {
    const txn = db.transaction(DETECT_BLOB_SUPPORT_STORE, READ_WRITE);
    const blob = createBlob(['']);

    txn.objectStore(DETECT_BLOB_SUPPORT_STORE).put(blob, 'key');

    txn.onabort = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      resolve(false);
    };

    txn.onerror = txn.onabort;

    txn.oncomplete = () => {
      const nav = getNavigatorObject();
      const ua = nav?.userAgent ?? '';
      const matchedChrome = ua.match(/Chrome\/(\d+)/);
      const matchedEdge = ua.match(/Edge\//);
      const chromeVersion = matchedChrome
        ? parseInt(matchedChrome[1], 10)
        : NaN;
      const supportsLargeBlobs =
        !!matchedEdge ||
        !matchedChrome ||
        Number.isNaN(chromeVersion) ||
        chromeVersion >= 43;
      resolve(supportsLargeBlobs);
    };
  })
    .then((result) => {
      supportsBlobs = result;
      detectBlobSupportPromise = null;
      return result;
    })
    .catch(() => {
      detectBlobSupportPromise = null;
      supportsBlobs = false;
      return false;
    });

  return detectBlobSupportPromise;
}

async function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }

  if (typeof FileReader === 'undefined') {
    throw new Error('Blob serialization not supported in this environment');
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onloadend = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

async function encodeBlob(blob: Blob): Promise<{
  __local_forage_encoded_blob: boolean;
  data: string;
  type: string;
}> {
  const arrayBuffer = await readBlobAsArrayBuffer(blob);
  return {
    __local_forage_encoded_blob: true,
    data: serializer.bufferToString(arrayBuffer),
    type: blob.type,
  };
}

function decodeBlob(encodedBlob: {
  __local_forage_encoded_blob: boolean;
  data: string;
  type: string;
}): Blob {
  const buffer = serializer.stringToBuffer(encodedBlob.data);
  return createBlob([buffer], { type: encodedBlob.type });
}

function isEncodedBlob(value?: {
  __local_forage_encoded_blob?: boolean;
}): boolean {
  return !!value?.__local_forage_encoded_blob;
}

function createDbContext(): DbContext {
  return {
    forages: [],
    db: null,
    dbReady: null,
    deferredOperations: [],
  };
}

function requireDbName(dbInfo: DbInfo): string {
  if (dbInfo.name) {
    return dbInfo.name;
  }
  throw new Error('IndexedDB database name is not configured.');
}

function requireStoreName(dbInfo: DbInfo): string {
  if (dbInfo.storeName) {
    return dbInfo.storeName;
  }
  throw new Error('IndexedDB storeName is not configured.');
}

function getDbContextKey(dbInfo: DbInfo): string {
  const dbName = requireDbName(dbInfo);
  return dbInfo.bucket?.name ? `${dbInfo.bucket.name}::${dbName}` : dbName;
}

function deferReadiness(dbInfo: DbInfo): void {
  const dbContext = dbContexts[getDbContextKey(dbInfo)];
  const deferredOperation: DeferredOperation = {
    promise: null as any,
    resolve: null as any,
    reject: null as any,
  };

  deferredOperation.promise = new Promise((resolve, reject) => {
    deferredOperation.resolve = resolve;
    deferredOperation.reject = reject;
  });

  dbContext.deferredOperations.push(deferredOperation);

  if (!dbContext.dbReady) {
    dbContext.dbReady = deferredOperation.promise;
  } else {
    dbContext.dbReady = dbContext.dbReady.then(() => deferredOperation.promise);
  }
}

function advanceReadiness(dbInfo: DbInfo): Promise<void> | undefined {
  const dbContext = dbContexts[getDbContextKey(dbInfo)];
  const deferredOperation = dbContext.deferredOperations.pop();

  if (deferredOperation) {
    deferredOperation.resolve();
    return deferredOperation.promise;
  }
}

function rejectReadiness(
  dbInfo: DbInfo,
  err: Error
): Promise<void> | undefined {
  const dbContext = dbContexts[getDbContextKey(dbInfo)];
  const deferredOperation = dbContext.deferredOperations.pop();

  if (deferredOperation) {
    deferredOperation.reject(err);
    return deferredOperation.promise;
  }
}

function getConnection(
  dbInfo: DbInfo,
  upgradeNeeded: boolean
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = getIDB(dbInfo);
    if (!idb) {
      return reject(new Error('IndexedDB not available'));
    }

    const contextKey = getDbContextKey(dbInfo);
    dbContexts[contextKey] = dbContexts[contextKey] || createDbContext();

    if (dbInfo.db) {
      if (upgradeNeeded) {
        deferReadiness(dbInfo);
        dbInfo.db.close();
      } else {
        return resolve(dbInfo.db);
      }
    }

    const openreq = upgradeNeeded
      ? idb.open(dbInfo.name!, dbInfo.version)
      : idb.open(dbInfo.name!);

    if (upgradeNeeded) {
      openreq.onupgradeneeded = (e: IDBVersionChangeEvent) => {
        const db = (e.target as IDBOpenDBRequest).result;
        try {
          db.createObjectStore(dbInfo.storeName!);
          if (e.oldVersion <= 1) {
            db.createObjectStore(DETECT_BLOB_SUPPORT_STORE);
          }
        } catch (ex: any) {
          if (ex.name === 'ConstraintError') {
            console.warn(
              `The database "${dbInfo.name}" has been upgraded from version ${e.oldVersion} to version ${e.newVersion}, but the storage "${dbInfo.storeName}" already exists.`
            );
          } else {
            throw ex;
          }
        }
      };
    }

    openreq.onerror = (e: Event) => {
      e.preventDefault();
      reject((e.target as IDBOpenDBRequest).error);
    };

    openreq.onsuccess = () => {
      const db = openreq.result;
      db.onversionchange = (e: IDBVersionChangeEvent) => {
        (e.target as IDBDatabase).close();
      };
      resolve(db);
      advanceReadiness(dbInfo);
    };
  });
}

function isUpgradeNeeded(dbInfo: DbInfo, defaultVersion: number): boolean {
  if (!dbInfo.db) {
    return true;
  }

  const isNewStore = !dbInfo.db.objectStoreNames.contains(dbInfo.storeName!);
  const isDowngrade = dbInfo.version! < dbInfo.db.version;
  const isUpgrade = dbInfo.version! > dbInfo.db.version;

  if (isDowngrade) {
    if (dbInfo.version !== defaultVersion) {
      console.warn(
        `The database "${dbInfo.name}" can't be downgraded from version ${dbInfo.db.version} to version ${dbInfo.version}.`
      );
    }
    dbInfo.version = dbInfo.db.version;
  }

  if (isUpgrade || isNewStore) {
    if (isNewStore) {
      const incVersion = dbInfo.db.version + 1;
      if (incVersion > dbInfo.version!) {
        dbInfo.version = incVersion;
      }
    }
    return true;
  }

  return false;
}

function getTransactionOptions(
  dbInfo: DbInfo,
  mode: IDBTransactionMode
): IDBTransactionOptions | undefined {
  if (mode === READ_WRITE && dbInfo.durability) {
    return { durability: dbInfo.durability };
  }
}

function createTransaction(
  dbInfo: DbInfo,
  mode: IDBTransactionMode,
  callback: (error: Error | null, transaction?: IDBTransaction) => void,
  retries: number = 1
): void {
  try {
    const txOptions = getTransactionOptions(dbInfo, mode);
    const tx = txOptions
      ? dbInfo.db!.transaction(dbInfo.storeName!, mode, txOptions)
      : dbInfo.db!.transaction(dbInfo.storeName!, mode);
    callback(null, tx);
  } catch (err: any) {
    if (
      retries > 0 &&
      (!dbInfo.db ||
        err.name === 'InvalidStateError' ||
        err.name === 'NotFoundError')
    ) {
      Promise.resolve()
        .then(() => {
          if (
            !dbInfo.db ||
            (err.name === 'NotFoundError' &&
              !dbInfo.db.objectStoreNames.contains(dbInfo.storeName!) &&
              dbInfo.version! <= dbInfo.db.version)
          ) {
            if (dbInfo.db) {
              dbInfo.version = dbInfo.db.version + 1;
            }
            return getConnection(dbInfo, true);
          }
        })
        .then(() => {
          return tryReconnect(dbInfo).then(() => {
            createTransaction(dbInfo, mode, callback, retries - 1);
          });
        })
        .catch(callback);
      return;
    }
    callback(err);
  }
}

function tryReconnect(dbInfo: DbInfo): Promise<void> {
  deferReadiness(dbInfo);

  const contextKey = getDbContextKey(dbInfo);
  const dbContext = dbContexts[contextKey];
  const forages = dbContext.forages;

  for (const forage of forages) {
    if (forage._dbInfo.db) {
      forage._dbInfo.db.close();
      forage._dbInfo.db = null;
    }
  }
  dbInfo.db = null;

  return getConnection(dbInfo, false)
    .then((db) => {
      dbInfo.db = db;
      if (isUpgradeNeeded(dbInfo, 1.0)) {
        return getConnection(dbInfo, true);
      }
      return db;
    })
    .then((db) => {
      dbInfo.db = dbContext.db = db;
      for (const forage of forages) {
        forage._dbInfo.db = db;
      }
    })
    .catch((err) => {
      rejectReadiness(dbInfo, err);
      throw err;
    });
}

async function _initStorage(
  this: IndexedDBDriverContext,
  config: LocalSpaceConfig
): Promise<void> {
  const self = this;
  const dbInfo: DbInfo = { db: null };

  for (const i in config) {
    Object.assign(dbInfo, {
      [i]: config[i as keyof LocalSpaceConfig],
    });
  }

  dbInfo.idbFactory = await resolveIdbFactory(config);
  if (!dbInfo.idbFactory) {
    throw new Error('IndexedDB not available');
  }

  const dbName = requireDbName(dbInfo);
  const contextKey = getDbContextKey(dbInfo);
  let dbContext = dbContexts[contextKey];

  if (!dbContext) {
    dbContext = dbContexts[contextKey] = createDbContext();
  }

  dbContext.forages.push(self);

  if (!self._initReady) {
    self._initReady = self.ready;
    self.ready = fullyReady;
  }

  const initPromises: Promise<void>[] = [];

  function ignoreErrors() {
    return Promise.resolve();
  }

  for (const forage of dbContext.forages) {
    if (forage !== self) {
      const initReady = (forage._initReady ?? forage.ready).bind(forage);
      initPromises.push(initReady().catch(ignoreErrors));
    }
  }

  const forages = dbContext.forages.slice(0);

  await Promise.all(initPromises);

  dbInfo.db = dbContext.db;
  const db = await getConnection(dbInfo, false);
  dbInfo.db = db;

  const defaultVersion = self._defaultConfig.version ?? 1;
  if (isUpgradeNeeded(dbInfo, defaultVersion)) {
    const upgradedDb = await getConnection(dbInfo, true);
    dbInfo.db = dbContext.db = upgradedDb;
  } else {
    dbInfo.db = dbContext.db = db;
  }

  self._dbInfo = dbInfo;

  for (const forage of forages) {
    if (forage !== self) {
      forage._dbInfo.db = dbInfo.db;
      forage._dbInfo.version = dbInfo.version;
    }
  }
}

function fullyReady(
  this: IndexedDBDriverContext,
  callback?: Callback<void>
): Promise<void> {
  const self = this;

  const initReady = (self._initReady ?? self.ready).bind(self);
  const promise = initReady().then(() => {
    if (self._dbInfo) {
      const contextKey = getDbContextKey(self._dbInfo);
      const dbContext = dbContexts[contextKey];
      if (dbContext && dbContext.dbReady) {
        return dbContext.dbReady;
      }
    }
  });

  executeCallback(promise, callback);
  return promise;
}

function getItem<T>(
  this: IndexedDBDriverContext,
  key: string,
  callback?: Callback<T>
): Promise<T | null> {
  const self = this;
  key = normalizeKey(key);

  const promise = new Promise<T | null>((resolve, reject) => {
    self
      .ready()
      .then(() => {
        createTransaction(
          self._dbInfo,
          READ_ONLY,
          (err: Error | null, transaction?: IDBTransaction) => {
            if (err) return reject(err);

            try {
              const storeName = requireStoreName(self._dbInfo);
              const store = transaction!.objectStore(storeName);
              const req = store.get(key);

              req.onsuccess = () => {
                let value = req.result;
                if (value === undefined) {
                  value = null;
                }
                if (isEncodedBlob(value)) {
                  value = decodeBlob(value);
                }
                resolve(value);
              };

              req.onerror = () => reject(req.error);
            } catch (e) {
              reject(e);
            }
          }
        );
      })
      .catch(reject);
  });

  executeCallback(promise, callback as Callback<T | null>);
  return promise;
}

function getItems<T>(
  this: IndexedDBDriverContext,
  keys: string[],
  callback?: Callback<BatchResponse<T>>
): Promise<BatchResponse<T>> {
  const self = this;
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = new Promise<BatchResponse<T>>(async (resolve, reject) => {
    try {
      await self.ready();

      if (normalizedKeys.length === 0) {
        resolve([]);
        return;
      }

      const dbInfo = self._dbInfo;
      const batchSize = dbInfo.maxBatchSize ?? normalizedKeys.length;
      const results: BatchResponse<T> = new Array(normalizedKeys.length);

      const processBatch = (batchKeys: string[], offset: number) =>
        new Promise<void>((batchResolve, batchReject) => {
          createTransaction(
            dbInfo,
            READ_ONLY,
            (err: Error | null, transaction?: IDBTransaction) => {
              if (err) return batchReject(err);

              try {
                const storeName = requireStoreName(dbInfo);
                const store = transaction!.objectStore(storeName);
                let requestError: Error | null = null;
                let remaining = batchKeys.length;

                batchKeys.forEach((key, index) => {
                  const req = store.get(key);
                  req.onsuccess = () => {
                    let value = req.result;
                    if (value === undefined) {
                      value = null;
                    }
                    if (isEncodedBlob(value)) {
                      value = decodeBlob(value);
                    }
                    results[offset + index] = { key, value };
                    remaining -= 1;
                    if (remaining === 0) {
                      batchResolve();
                    }
                  };
                  req.onerror = () => {
                    requestError =
                      req.error || new Error(`Failed to get "${key}"`);
                  };
                });

                transaction!.onabort = transaction!.onerror = () => {
                  batchReject(
                    requestError ||
                      transaction!.error ||
                      new Error('Failed to get items transaction')
                  );
                };
              } catch (e) {
                batchReject(e);
              }
            }
          );
        });

      const batches = chunkArray(normalizedKeys, batchSize);
      let offset = 0;
      for (const batch of batches) {
        await processBatch(batch, offset);
        offset += batch.length;
      }

      resolve(results);
    } catch (err) {
      reject(err as Error);
    }
  });

  executeCallback(promise, callback);
  return promise;
}

function iterate<T, U>(
  this: IndexedDBDriverContext,
  iterator: (value: T, key: string, iterationNumber: number) => U,
  callback?: Callback<U>
): Promise<U> {
  const self = this;

  const promise = new Promise<U>((resolve, reject) => {
    self
      .ready()
      .then(() => {
        createTransaction(
          self._dbInfo,
          READ_ONLY,
          (err: Error | null, transaction?: IDBTransaction) => {
            if (err) return reject(err);

            try {
              const storeName = requireStoreName(self._dbInfo);
              const store = transaction!.objectStore(storeName);
              const req = store.openCursor();
              let iterationNumber = 1;

              req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                  let value = cursor.value;
                  if (value === undefined) {
                    value = null;
                  }
                  if (isEncodedBlob(value)) {
                    value = decodeBlob(value);
                  }
                  const result = iterator(
                    value,
                    cursor.key as string,
                    iterationNumber++
                  );
                  if (result !== undefined) {
                    resolve(result);
                  } else {
                    cursor.continue();
                  }
                } else {
                  resolve(undefined as U);
                }
              };

              req.onerror = () => reject(req.error);
            } catch (e) {
              reject(e);
            }
          }
        );
      })
      .catch(reject);
  });

  executeCallback(promise, callback);
  return promise;
}

function setItems<T>(
  this: IndexedDBDriverContext,
  items: BatchItems<T>,
  callback?: Callback<BatchResponse<T>>
): Promise<BatchResponse<T>> {
  const self = this;
  const normalized = normalizeBatchEntries(items);

  const promise = new Promise<BatchResponse<T>>(async (resolve, reject) => {
    try {
      await self.ready();
      const dbInfo = self._dbInfo;

      let blobSupport: boolean | undefined;

      const needsBlobCheck = normalized.some(
        (entry) => toString.call(entry.value) === '[object Blob]'
      );

  if (needsBlobCheck) {
    blobSupport = await checkBlobSupport(dbInfo.db!);
  }

  const batches = chunkArray(
    normalized,
    dbInfo.maxBatchSize ?? normalized.length
  );

  const allResults: BatchResponse<T> = [];

  const processBatch = async (batch: KeyValuePair<T>[]) => {
    const payloads: BatchResponse<T> = [];

    for (const entry of batch) {
      let value: T | null | undefined = entry.value;
      if (value === undefined) {
        value = null;
      }

      if (toString.call(entry.value) === '[object Blob]') {
        const canStoreBlob =
          typeof blobSupport === 'boolean'
            ? blobSupport
            : await checkBlobSupport(dbInfo.db!);
        if (!canStoreBlob) {
          value = (await encodeBlob(entry.value as unknown as Blob)) as T;
        }
      }

      payloads.push({ key: entry.key, value });
    }

    return new Promise<BatchResponse<T>>((batchResolve, batchReject) => {
      createTransaction(
        dbInfo,
        READ_WRITE,
        (err: Error | null, transaction?: IDBTransaction) => {
          if (err) return batchReject(err);

          try {
            const storeName = requireStoreName(dbInfo);
            const store = transaction!.objectStore(storeName);
            let requestError: Error | null = null;

            for (const entry of payloads) {
              const req = store.put(entry.value, entry.key);
              req.onerror = () => {
                requestError =
                  req.error ||
                  new Error(`Failed to set "${String(entry.key)}"`);
              };
            }

            transaction!.oncomplete = () => batchResolve(payloads);
            transaction!.onabort = transaction!.onerror = () => {
              batchReject(
                requestError ||
                  transaction!.error ||
                  new Error('Failed to set items transaction')
              );
            };
          } catch (e) {
            batchReject(e);
          }
        }
      );
    });
  };

  for (const batch of batches) {
    const result = await processBatch(batch);
    allResults.push(...result);
  }

  resolve(allResults);
    } catch (err) {
      reject(err as Error);
    }
  });

  executeCallback(promise, callback);
  return promise;
}

async function setItem<T>(
  this: IndexedDBDriverContext,
  key: string,
  value: T,
  callback?: Callback<T>
): Promise<T> {
  const self = this;
  key = normalizeKey(key);

  const promise = new Promise<T | null | undefined>(async (resolve, reject) => {
    let dbInfo: DbInfo;
    try {
      await self.ready();
      dbInfo = self._dbInfo;

      if (toString.call(value) === '[object Blob]') {
        const blobSupport = await checkBlobSupport(dbInfo.db!);
        if (!blobSupport) {
          value = (await encodeBlob(value as Blob)) as T;
        }
      }

      createTransaction(
        dbInfo,
        READ_WRITE,
        (err: Error | null, transaction?: IDBTransaction) => {
          if (err) return reject(err);

          try {
            const storeName = requireStoreName(dbInfo);
            const store = transaction!.objectStore(storeName);
            let actualValue: T | null | undefined = value;

            if (actualValue === undefined) {
              actualValue = null;
            }

            const req = store.put(actualValue, key);

            transaction!.oncomplete = () => {
              resolve(actualValue);
            };

            transaction!.onabort = transaction!.onerror = () => {
              const err = req.error || transaction!.error;
              reject(err);
            };
          } catch (e) {
            reject(e);
          }
        }
      );
    } catch (err) {
      reject(err);
    }
  });

  executeCallback(promise as Promise<T>, callback);
  return promise as Promise<T>;
}

function removeItem(
  this: IndexedDBDriverContext,
  key: string,
  callback?: Callback<void>
): Promise<void> {
  const self = this;
  key = normalizeKey(key);

  const promise = new Promise<void>((resolve, reject) => {
    self
      .ready()
      .then(() => {
        createTransaction(
          self._dbInfo,
          READ_WRITE,
          (err: Error | null, transaction?: IDBTransaction) => {
            if (err) return reject(err);

            try {
              const storeName = requireStoreName(self._dbInfo);
              const store = transaction!.objectStore(storeName);
              const req = store.delete(key);

              transaction!.oncomplete = () => resolve();
              transaction!.onerror = () => reject(req.error);
              transaction!.onabort = () => {
                const err = req.error || transaction!.error;
                reject(err);
              };
            } catch (e) {
              reject(e);
            }
          }
        );
      })
      .catch(reject);
  });

  executeCallback(promise, callback);
  return promise;
}

function removeItems(
  this: IndexedDBDriverContext,
  keys: string[],
  callback?: Callback<void>
): Promise<void> {
  const self = this;
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = new Promise<void>(async (resolve, reject) => {
    try {
      await self.ready();
      if (normalizedKeys.length === 0) {
        resolve();
        return;
      }

      const dbInfo = self._dbInfo;
      const batchSize = dbInfo.maxBatchSize ?? normalizedKeys.length;

      const processBatch = (batchKeys: string[]) =>
        new Promise<void>((batchResolve, batchReject) => {
          createTransaction(
            dbInfo,
            READ_WRITE,
            (err: Error | null, transaction?: IDBTransaction) => {
              if (err) return batchReject(err);

              try {
                const storeName = requireStoreName(dbInfo);
                const store = transaction!.objectStore(storeName);
                let requestError: Error | null = null;

                for (const key of batchKeys) {
                  const req = store.delete(key);
                  req.onerror = () => {
                    requestError =
                      req.error || new Error(`Failed to remove "${key}"`);
                  };
                }

                transaction!.oncomplete = () => batchResolve();
                transaction!.onabort = transaction!.onerror = () => {
                  batchReject(
                    requestError ||
                      transaction!.error ||
                      new Error('Failed to remove items transaction')
                  );
                };
              } catch (e) {
                batchReject(e);
              }
            }
          );
        });

      const batches = chunkArray(normalizedKeys, batchSize);
      for (const batch of batches) {
        await processBatch(batch);
      }

      resolve();
    } catch (err) {
      reject(err as Error);
    }
  });

  executeCallback(promise, callback);
  return promise;
}

function runTransaction<T>(
  this: IndexedDBDriverContext,
  mode: IDBTransactionMode,
  runner: (scope: TransactionScope) => Promise<T> | T,
  callback?: Callback<T>
): Promise<T> {
  const self = this;

  const promise = new Promise<T>(async (resolve, reject) => {
    try {
      await self.ready();
      const dbInfo = self._dbInfo;
      const storeName = requireStoreName(dbInfo);
      const txOptions = getTransactionOptions(dbInfo, mode);
      const tx = txOptions
        ? dbInfo.db!.transaction(storeName, mode, txOptions)
        : dbInfo.db!.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let blobSupport: boolean | undefined;

      const ensureBlobSupport = async (): Promise<boolean> => {
        if (typeof blobSupport === 'boolean') return blobSupport;
        blobSupport = await checkBlobSupport(dbInfo.db!);
        return blobSupport!;
      };

      const makeReadOnlyGuard = () => {
        if (mode === READ_ONLY) {
          throw new Error('Transaction is readonly');
        }
      };

      const scope: TransactionScope = {
        get: <V>(key: string) =>
          new Promise<V | null>((res, rej) => {
            const req = store.get(normalizeKey(key));
            req.onsuccess = () => {
              let value = req.result;
              if (value === undefined) value = null;
              if (isEncodedBlob(value)) {
                value = decodeBlob(value);
              }
              res(value);
            };
            req.onerror = () => rej(req.error);
          }),
        set: async <V>(key: string, value: V) => {
          makeReadOnlyGuard();
          let actual: V | null | undefined = value;
          if (actual === undefined) actual = null;

          if (toString.call(value) === '[object Blob]') {
            const canStoreBlob = await ensureBlobSupport();
            if (!canStoreBlob) {
              actual = (await encodeBlob(value as unknown as Blob)) as V;
            }
          }

          return new Promise<V>((res, rej) => {
            const req = store.put(actual, normalizeKey(key));
            req.onsuccess = () => res(actual as V);
            req.onerror = () => rej(req.error);
          });
        },
        remove: (key: string) =>
          new Promise<void>((res, rej) => {
            makeReadOnlyGuard();
            const req = store.delete(normalizeKey(key));
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          }),
        keys: () =>
          new Promise<string[]>((res, rej) => {
            const all: string[] = [];
            const req = store.openKeyCursor();
            req.onsuccess = () => {
              const cursor = req.result;
              if (!cursor) {
                res(all);
                return;
              }
              all.push(cursor.key as string);
              cursor.continue();
            };
            req.onerror = () => rej(req.error);
          }),
        iterate: <V, U>(fn: (value: V, key: string, iteration: number) => U) =>
          new Promise<U>((res, rej) => {
            const req = store.openCursor();
            let iteration = 1;
            req.onsuccess = () => {
              const cursor = req.result;
              if (cursor) {
                let value = cursor.value;
                if (value === undefined) value = null;
                if (isEncodedBlob(value)) {
                  value = decodeBlob(value);
                }
                const out = fn(value, cursor.key as string, iteration++);
                if (out !== undefined) {
                  res(out);
                } else {
                  cursor.continue();
                }
              } else {
                res(undefined as U);
              }
            };
            req.onerror = () => rej(req.error);
          }),
        clear: () =>
          new Promise<void>((res, rej) => {
            makeReadOnlyGuard();
            const req = store.clear();
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          }),
      };

      const runnerPromise = Promise.resolve().then(() => runner(scope));
      const completion = new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
        tx.onerror = () => rej(tx.error || new Error('Transaction error'));
      });

      const guardedRunner = runnerPromise.catch((err) => {
        try {
          tx.abort();
        } catch {
          // ignore abort issues
        }
        throw err;
      });

      const [runnerOutcome, completionOutcome] = await Promise.allSettled([
        guardedRunner,
        completion,
      ]);

      if (runnerOutcome.status === 'rejected') {
        throw runnerOutcome.reason;
      }
      if (completionOutcome.status === 'rejected') {
        throw completionOutcome.reason;
      }

      resolve(runnerOutcome.value);
    } catch (err) {
      reject(err as Error);
    }
  });

  executeCallback(promise, callback);
  return promise;
}

function clear(
  this: IndexedDBDriverContext,
  callback?: Callback<void>
): Promise<void> {
  const self = this;

  const promise = new Promise<void>((resolve, reject) => {
    self
      .ready()
      .then(() => {
        createTransaction(
          self._dbInfo,
          READ_WRITE,
          (err: Error | null, transaction?: IDBTransaction) => {
            if (err) return reject(err);

            try {
              const storeName = requireStoreName(self._dbInfo);
              const store = transaction!.objectStore(storeName);
              const req = store.clear();

              transaction!.oncomplete = () => resolve();
              transaction!.onabort = transaction!.onerror = () => {
                const err = req.error || transaction!.error;
                reject(err);
              };
            } catch (e) {
              reject(e);
            }
          }
        );
      })
      .catch(reject);
  });

  executeCallback(promise, callback);
  return promise;
}

function length(
  this: IndexedDBDriverContext,
  callback?: Callback<number>
): Promise<number> {
  const self = this;

  const promise = new Promise<number>((resolve, reject) => {
    self
      .ready()
      .then(() => {
        createTransaction(
          self._dbInfo,
          READ_ONLY,
          (err: Error | null, transaction?: IDBTransaction) => {
            if (err) return reject(err);

            try {
              const storeName = requireStoreName(self._dbInfo);
              const store = transaction!.objectStore(storeName);
              const req = store.count();

              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            } catch (e) {
              reject(e);
            }
          }
        );
      })
      .catch(reject);
  });

  executeCallback(promise, callback);
  return promise;
}

function key(
  this: IndexedDBDriverContext,
  n: number,
  callback?: Callback<string>
): Promise<string | null> {
  const self = this;

  const promise = new Promise<string | null>((resolve, reject) => {
    if (n < 0) {
      resolve(null);
      return;
    }

    self
      .ready()
      .then(() => {
        createTransaction(
          self._dbInfo,
          READ_ONLY,
          (err: Error | null, transaction?: IDBTransaction) => {
            if (err) return reject(err);

            try {
              const storeName = requireStoreName(self._dbInfo);
              const store = transaction!.objectStore(storeName);
              let advanced = false;
              const req = store.openKeyCursor();

              req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                  resolve(null);
                  return;
                }

                if (n === 0) {
                  resolve(cursor.key as string);
                } else {
                  if (!advanced) {
                    advanced = true;
                    cursor.advance(n);
                  } else {
                    resolve(cursor.key as string);
                  }
                }
              };

              req.onerror = () => reject(req.error);
            } catch (e) {
              reject(e);
            }
          }
        );
      })
      .catch(reject);
  });

  executeCallback(promise, callback as Callback<string | null>);
  return promise;
}

function keys(
  this: IndexedDBDriverContext,
  callback?: Callback<string[]>
): Promise<string[]> {
  const self = this;

  const promise = new Promise<string[]>((resolve, reject) => {
    self
      .ready()
      .then(() => {
        createTransaction(
          self._dbInfo,
          READ_ONLY,
          (err: Error | null, transaction?: IDBTransaction) => {
            if (err) return reject(err);

            try {
              const storeName = requireStoreName(self._dbInfo);
              const store = transaction!.objectStore(storeName);
              const req = store.openKeyCursor();
              const keys: string[] = [];

              req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                  resolve(keys);
                  return;
                }
                keys.push(cursor.key as string);
                cursor.continue();
              };

              req.onerror = () => reject(req.error);
            } catch (e) {
              reject(e);
            }
          }
        );
      })
      .catch(reject);
  });

  executeCallback(promise, callback);
  return promise;
}

function dropInstance(
  this: IndexedDBDriverContext,
  options?: LocalSpaceConfig,
  callback?: Callback<void>
): Promise<void> {
  const self = this;
  const currentConfig = self.config();

  // Normalize options
  const effectiveOptions: LocalSpaceConfig = {
    ...(typeof options === 'object' ? options : {}),
  };

  if (!effectiveOptions.name) {
    effectiveOptions.name = currentConfig.name;
    if (!effectiveOptions.storeName) {
      effectiveOptions.storeName = currentConfig.storeName;
    }
  }

  // Validate options
  if (!effectiveOptions.name) {
    const promise = Promise.reject(new Error('Invalid arguments'));
    executeCallback(promise, callback);
    return promise;
  }

  const dropDbInfo: DbInfo = {
    ...(effectiveOptions as DbInfo),
    idbFactory: self._dbInfo?.idbFactory ?? undefined,
  };
  if (!dropDbInfo.bucket && currentConfig.bucket) {
    dropDbInfo.bucket = currentConfig.bucket;
  }

  const targetName = effectiveOptions.name!;
  const currentDb = self._dbInfo?.db ?? null;
  const shouldReuseCurrentDb =
    targetName === currentConfig.name && currentDb !== null;
  const contextKey = getDbContextKey(dropDbInfo);

  let dbPromise: Promise<IDBDatabase>;
  if (shouldReuseCurrentDb && currentDb) {
    dbPromise = Promise.resolve(currentDb);
  } else {
    dbPromise = getConnection(dropDbInfo, false).then((db) => {
      const dbContext = dbContexts[contextKey];
      if (dbContext) {
        const forages = dbContext.forages;
        dbContext.db = db;
        for (const forage of forages) {
          forage._dbInfo.db = db;
        }
      }
      return db;
    });
  }

  let promise: Promise<void>;

  // Case 1: Drop entire database (no storeName specified)
  if (!effectiveOptions.storeName) {
    promise = dbPromise.then((db) => {
      deferReadiness(dropDbInfo);

      const dbContext = dbContexts[contextKey];
      const forages = dbContext?.forages || [];

      // Close all connections
      db.close();
      for (const forage of forages) {
        forage._dbInfo.db = null;
      }

      // Delete the entire database
      const dropDBPromise = new Promise<void>((resolve, reject) => {
        const idb = getIDB(dropDbInfo);
        if (!idb) {
          return reject(new Error('IndexedDB not available'));
        }

        const req = idb.deleteDatabase(targetName);

        req.onerror = () => {
          reject(req.error || new Error('Failed to delete database'));
        };

        req.onblocked = () => {
          console.warn(
            `dropInstance blocked for database "${targetName}" until all open connections are closed`
          );
        };

        req.onsuccess = () => {
          resolve();
        };
      });

      return dropDBPromise
        .then(() => {
          if (dbContext) {
            dbContext.db = null;
            for (const forage of forages) {
              advanceReadiness(forage._dbInfo);
            }
          }
        })
        .catch((err) => {
          if (dbContext) {
            rejectReadiness(dropDbInfo, err);
          }
          throw err;
        });
    });
  } else {
    // Case 2: Drop specific object store
    promise = dbPromise.then((db) => {
      if (!db.objectStoreNames.contains(effectiveOptions.storeName!)) {
        // Store doesn't exist, nothing to do
        return;
      }

      const newVersion = db.version + 1;

      deferReadiness(dropDbInfo);

      const dbContext = dbContexts[contextKey];
      const forages = dbContext?.forages || [];

      // Close all connections
      db.close();
      for (const forage of forages) {
        forage._dbInfo.db = null;
        forage._dbInfo.version = newVersion;
      }

      // Delete the object store by upgrading the database
      const dropObjectPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const idb = getIDB(dropDbInfo);
        if (!idb) {
          return reject(new Error('IndexedDB not available'));
        }

        const req = idb.open(targetName, newVersion);

        req.onerror = () => {
          const db = req.result;
          if (db) {
            db.close();
          }
          reject(req.error || new Error('Failed to open database'));
        };

        req.onupgradeneeded = () => {
          const db = req.result;
          if (db.objectStoreNames.contains(effectiveOptions.storeName!)) {
            db.deleteObjectStore(effectiveOptions.storeName!);
          }
        };

        req.onsuccess = () => {
          const db = req.result;
          resolve(db);
        };
      });

      return dropObjectPromise
        .then((db) => {
          if (dbContext) {
            dbContext.db = db;
            for (const forage of forages) {
              forage._dbInfo.db = db;
              advanceReadiness(forage._dbInfo);
            }
          }
        })
        .catch((err) => {
          if (dbContext) {
            rejectReadiness(effectiveOptions as DbInfo, err);
          }
          throw err;
        });
    });
  }

  executeCallback(promise, callback);
  return promise;
}

const asyncStorage: Driver = {
  _driver: 'asyncStorage',
  _initStorage,
  _support: (() => isIndexedDBValid()) as () => Promise<boolean>,
  iterate,
  getItem,
  getItems,
  setItem,
  setItems,
  removeItem,
  removeItems,
  runTransaction,
  clear,
  length,
  key,
  keys,
  dropInstance,
};

export default asyncStorage;
