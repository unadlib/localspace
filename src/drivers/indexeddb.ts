import type {
  Driver,
  DbInfo,
  LocalSpaceConfig,
  Callback,
  LocalSpaceInstance,
} from '../types';
import { executeCallback, normalizeKey, createBlob } from '../utils/helpers';
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

function getIDB(): IDBFactory | null {
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

function isIndexedDBValid(): boolean | Promise<boolean> {
  try {
    const idb = getIDB();
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

function isEncodedBlob(value: any): boolean {
  return value && value.__local_forage_encoded_blob;
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

function deferReadiness(dbInfo: DbInfo): void {
  const dbContext = dbContexts[dbInfo.name!];
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
  const dbContext = dbContexts[dbInfo.name!];
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
  const dbContext = dbContexts[dbInfo.name!];
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
    const idb = getIDB();
    if (!idb) {
      return reject(new Error('IndexedDB not available'));
    }

    dbContexts[dbInfo.name!] = dbContexts[dbInfo.name!] || createDbContext();

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

function createTransaction(
  dbInfo: DbInfo,
  mode: IDBTransactionMode,
  callback: (error: Error | null, transaction?: IDBTransaction) => void,
  retries: number = 1
): void {
  try {
    const tx = dbInfo.db!.transaction(dbInfo.storeName!, mode);
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

  const dbContext = dbContexts[dbInfo.name!];
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
    (dbInfo as any)[i] = (config as any)[i];
  }

  const dbName = requireDbName(dbInfo);
  let dbContext = dbContexts[dbName];

  if (!dbContext) {
    dbContext = dbContexts[dbName] = createDbContext();
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
    const dbName = requireDbName(self._dbInfo);
    const dbContext = dbContexts[dbName];
    if (dbContext && dbContext.dbReady) {
      return dbContext.dbReady;
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

async function setItem<T>(
  this: IndexedDBDriverContext,
  key: string,
  value: T,
  callback?: Callback<T>
): Promise<T> {
  const self = this;
  key = normalizeKey(key);

  const promise = new Promise<T>(async (resolve, reject) => {
    let dbInfo: DbInfo;
    try {
      await self.ready();
      dbInfo = self._dbInfo;

      if (toString.call(value) === '[object Blob]') {
        const blobSupport = await checkBlobSupport(dbInfo.db!);
        if (!blobSupport) {
          value = (await encodeBlob(value as any)) as any;
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
            let actualValue = value;

            if (actualValue === null) {
              actualValue = undefined as any;
            }

            const req = store.put(actualValue, key);

            transaction!.oncomplete = () => {
              if (actualValue === undefined) {
                actualValue = null as any;
              }
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

  executeCallback(promise, callback);
  return promise;
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

  const targetName = effectiveOptions.name!;
  const currentDb = self._dbInfo?.db ?? null;
  const shouldReuseCurrentDb =
    targetName === currentConfig.name && currentDb !== null;

  let dbPromise: Promise<IDBDatabase>;
  if (shouldReuseCurrentDb && currentDb) {
    dbPromise = Promise.resolve(currentDb);
  } else {
    dbPromise = getConnection(effectiveOptions as DbInfo, false).then((db) => {
      const dbContext = dbContexts[targetName];
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
      deferReadiness(effectiveOptions as DbInfo);

      const dbContext = dbContexts[targetName];
      const forages = dbContext?.forages || [];

      // Close all connections
      db.close();
      for (const forage of forages) {
        forage._dbInfo.db = null;
      }

      // Delete the entire database
      const dropDBPromise = new Promise<void>((resolve, reject) => {
        const idb = getIDB();
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
            rejectReadiness(effectiveOptions as DbInfo, err);
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

      deferReadiness(effectiveOptions as DbInfo);

      const dbContext = dbContexts[targetName];
      const forages = dbContext?.forages || [];

      // Close all connections
      db.close();
      for (const forage of forages) {
        forage._dbInfo.db = null;
        forage._dbInfo.version = newVersion;
      }

      // Delete the object store by upgrading the database
      const dropObjectPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const idb = getIDB();
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
          // Close the database after use
          db.close();
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
  setItem,
  removeItem,
  clear,
  length,
  key,
  keys,
  dropInstance,
};

export default asyncStorage;
