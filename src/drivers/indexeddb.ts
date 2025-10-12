import type { Driver, DbInfo, LocalspaceConfig, Callback } from '../types';
import { executeCallback, normalizeKey, createBlob } from '../utils/helpers';

const DETECT_BLOB_SUPPORT_STORE = 'local-forage-detect-blob-support';
let supportsBlobs: boolean | undefined;
const dbContexts: Record<string, DbContext> = {};
const toString = Object.prototype.toString;

const READ_ONLY = 'readonly';
const READ_WRITE = 'readwrite';

interface DbContext {
  forages: any[];
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
      (window as any).indexedDB ||
      (window as any).webkitIndexedDB ||
      (window as any).mozIndexedDB ||
      (window as any).OIndexedDB ||
      (window as any).msIndexedDB ||
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
    const isSafari =
      typeof window !== 'undefined' &&
      window.navigator &&
      /Safari/.test(navigator.userAgent) &&
      !/Chrome/.test(navigator.userAgent);

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

  return new Promise<boolean>((resolve) => {
    const txn = db.transaction(DETECT_BLOB_SUPPORT_STORE, READ_WRITE);
    const blob = createBlob(['']);

    txn.objectStore(DETECT_BLOB_SUPPORT_STORE).put(blob, 'key');

    txn.onabort = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      resolve(false);
    };

    txn.oncomplete = () => {
      const ua = navigator.userAgent;
      const matchedChrome = ua.match(/Chrome\/(\d+)/);
      const matchedEdge = ua.match(/Edge\//);
      resolve(!!matchedEdge || !matchedChrome || parseInt(matchedChrome[1], 10) >= 43);
    };
  }).catch(() => false);
}

function encodeBlob(blob: Blob): Promise<{
  __local_forage_encoded_blob: boolean;
  data: string;
  type: string;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onloadend = (e: ProgressEvent<FileReader>) => {
      const base64 = btoa(e.target?.result as string || '');
      resolve({
        __local_forage_encoded_blob: true,
        data: base64,
        type: blob.type,
      });
    };
    reader.readAsBinaryString(blob);
  });
}

function decodeBlob(encodedBlob: {
  __local_forage_encoded_blob: boolean;
  data: string;
  type: string;
}): Blob {
  const arrayBuff = binStringToArrayBuffer(atob(encodedBlob.data));
  return createBlob([arrayBuff], { type: encodedBlob.type });
}

function binStringToArrayBuffer(bin: string): ArrayBuffer {
  const length = bin.length;
  const buf = new ArrayBuffer(length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return buf;
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

function rejectReadiness(dbInfo: DbInfo, err: Error): Promise<void> | undefined {
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

async function _initStorage(this: any, config: LocalspaceConfig): Promise<void> {
  const self = this;
  const dbInfo: DbInfo = { db: null };

  for (const i in config) {
    (dbInfo as any)[i] = (config as any)[i];
  }

  const dbContext = dbContexts[dbInfo.name!];

  if (!dbContext) {
    dbContexts[dbInfo.name!] = createDbContext();
  }

  dbContexts[dbInfo.name!].forages.push(self);

  if (!self._initReady) {
    self._initReady = self.ready;
    self.ready = fullyReady;
  }

  const initPromises: Promise<void>[] = [];

  function ignoreErrors() {
    return Promise.resolve();
  }

  for (const forage of dbContexts[dbInfo.name!].forages) {
    if (forage !== self) {
      initPromises.push(forage._initReady().catch(ignoreErrors));
    }
  }

  const forages = dbContexts[dbInfo.name!].forages.slice(0);

  await Promise.all(initPromises);

  dbInfo.db = dbContexts[dbInfo.name!].db;
  const db = await getConnection(dbInfo, false);
  dbInfo.db = db;

  if (isUpgradeNeeded(dbInfo, self._defaultConfig.version)) {
    const upgradedDb = await getConnection(dbInfo, true);
    dbInfo.db = dbContexts[dbInfo.name!].db = upgradedDb;
  } else {
    dbInfo.db = dbContexts[dbInfo.name!].db = db;
  }

  self._dbInfo = dbInfo;

  for (const forage of forages) {
    if (forage !== self) {
      forage._dbInfo.db = dbInfo.db;
      forage._dbInfo.version = dbInfo.version;
    }
  }
}

function fullyReady(this: any, callback?: Callback<void>): Promise<void> {
  const self = this;

  const promise = self._initReady().then(() => {
    const dbContext = dbContexts[self._dbInfo.name];
    if (dbContext && dbContext.dbReady) {
      return dbContext.dbReady;
    }
  });

  executeCallback(promise, callback);
  return promise;
}

function getItem<T>(
  this: any,
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
              const store = transaction!.objectStore(self._dbInfo.storeName);
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
  this: any,
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
              const store = transaction!.objectStore(self._dbInfo.storeName);
              const req = store.openCursor();
              let iterationNumber = 1;

              req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                  let value = cursor.value;
                  if (isEncodedBlob(value)) {
                    value = decodeBlob(value);
                  }
                  const result = iterator(value, cursor.key as string, iterationNumber++);
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
  this: any,
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
            const store = transaction!.objectStore(self._dbInfo.storeName);
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
  this: any,
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
              const store = transaction!.objectStore(self._dbInfo.storeName);
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

function clear(this: any, callback?: Callback<void>): Promise<void> {
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
              const store = transaction!.objectStore(self._dbInfo.storeName);
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

function length(this: any, callback?: Callback<number>): Promise<number> {
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
              const store = transaction!.objectStore(self._dbInfo.storeName);
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
  this: any,
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
              const store = transaction!.objectStore(self._dbInfo.storeName);
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

function keys(this: any, callback?: Callback<string[]>): Promise<string[]> {
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
              const store = transaction!.objectStore(self._dbInfo.storeName);
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
  this: any,
  options?: LocalspaceConfig,
  callback?: Callback<void>
): Promise<void> {
  // This is a complex method - for now, we'll provide a basic implementation
  const promise = Promise.reject(new Error('dropInstance not yet implemented for IndexedDB'));
  executeCallback(promise, callback);
  return promise;
}

const asyncStorage: Driver = {
  _driver: 'asyncStorage',
  _initStorage,
  _support: (() => isIndexedDBValid()) as (() => Promise<boolean>),
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
