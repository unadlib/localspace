import type {
  Driver,
  DbInfo,
  LocalSpaceConfig,
  LocalSpaceInstance,
  BatchItems,
  BatchResponse,
  KeyValuePair,
  TransactionMode,
  TransactionScope,
} from '../types.js';
import type { LocalSpaceErrorCode, LocalSpaceErrorDetails } from '../errors.js';
import {
  createLocalSpaceError,
  LocalSpaceError,
  toLocalSpaceError,
} from '../errors.js';
import {
  normalizeBatchEntries,
  normalizeKey,
  createBlob,
  chunkArray,
} from '../utils/helpers.js';
import serializer from '../utils/serializer.js';

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
const DRIVER_NAME = 'asyncStorage';

const READ_ONLY = 'readonly';
const READ_WRITE = 'readwrite';
let detectBlobSupportPromise: Promise<boolean> | null = null;

const IDB_DOM_EXCEPTION_NAMES = new Set([
  'AbortError',
  'ConstraintError',
  'DataCloneError',
  'DataError',
  'InvalidAccessError',
  'InvalidStateError',
  'NotFoundError',
  'QuotaExceededError',
  'ReadOnlyError',
  'TransactionInactiveError',
  'UnknownError',
  'VersionError',
]);

const isQuotaExceededError = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      name?: string;
      code?: number | string;
      cause?: unknown;
    };
    if (
      candidate.name === 'QuotaExceededError' ||
      candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      candidate.code === 22
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
};

const isIdbDomException = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return true;
  }
  return IDB_DOM_EXCEPTION_NAMES.has((error as { name?: string }).name ?? '');
};

const withIdbErrorContext = <T>(
  promise: Promise<T>,
  operation: string,
  details?: LocalSpaceErrorDetails,
  code: LocalSpaceErrorCode = 'OPERATION_FAILED'
): Promise<T> =>
  promise.catch((error) => {
    const quotaExceeded = isQuotaExceededError(error);
    const effectiveCode: LocalSpaceErrorCode = quotaExceeded
      ? 'QUOTA_EXCEEDED'
      : code;
    const stableMessage = quotaExceeded
      ? `IndexedDB quota exceeded during ${operation}.`
      : `IndexedDB ${operation} failed.`;
    const message =
      !isIdbDomException(error) && error instanceof Error && error.message
        ? error.message
        : stableMessage;
    const enrichedDetails = {
      driver: DRIVER_NAME,
      operation,
      ...(details ?? {}),
    };

    if (
      quotaExceeded &&
      error instanceof LocalSpaceError &&
      error.code !== 'QUOTA_EXCEEDED'
    ) {
      throw new LocalSpaceError(
        effectiveCode,
        stableMessage,
        {
          ...enrichedDetails,
          causeName: error.name,
          causeMessage: error.message,
        },
        error
      );
    }

    throw toLocalSpaceError(error, effectiveCode, message, enrichedDetails);
  });

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
  prewarmPromise?: Promise<void> | null;
  prewarmed?: boolean;
  idleTimer?: ReturnType<typeof setTimeout> | null;
  activeTransactions: number;
  pendingTransactions: Array<() => void>;
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
  } catch {
    return false;
  }
}

type ResolvedIdbBackend = {
  factory: IDBFactory;
  contextId: string;
};

async function resolveIdbBackend(
  config: LocalSpaceConfig
): Promise<ResolvedIdbBackend | null> {
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
        if (bucket.indexedDB) {
          return {
            factory: bucket.indexedDB,
            contextId: `bucket:${config.bucket.name}`,
          };
        }
      } catch (error) {
        console.warn(
          `Failed to open storage bucket "${config.bucket.name}", falling back to default bucket.`,
          error
        );
      }
    }
  }

  const factory = getDefaultIDB();
  return factory ? { factory, contextId: 'default' } : null;
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

async function ensureBlobSupportForDb(
  dbInfo: DbInfo,
  dbOverride?: IDBDatabase | null
): Promise<boolean> {
  if (typeof supportsBlobs === 'boolean') {
    return supportsBlobs;
  }

  const activeDb = dbOverride ?? dbInfo.db;
  if (activeDb) {
    return checkBlobSupport(activeDb);
  }

  await tryReconnect(dbInfo);
  if (!dbInfo.db) {
    throw createLocalSpaceError(
      'DRIVER_UNAVAILABLE',
      'IndexedDB not available',
      { driver: DRIVER_NAME }
    );
  }
  return checkBlobSupport(dbInfo.db);
}

async function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }

  if (typeof FileReader === 'undefined') {
    throw createLocalSpaceError(
      'BLOB_UNSUPPORTED',
      'Blob serialization not supported in this environment',
      { driver: DRIVER_NAME }
    );
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
    prewarmPromise: null,
    prewarmed: false,
    idleTimer: null,
    activeTransactions: 0,
    pendingTransactions: [],
  };
}

function requireDbName(dbInfo: DbInfo): string {
  if (dbInfo.name) {
    return dbInfo.name;
  }
  throw createLocalSpaceError(
    'INVALID_CONFIG',
    'IndexedDB database name is not configured.',
    { driver: DRIVER_NAME, configKey: 'name' }
  );
}

function requireStoreName(dbInfo: DbInfo): string {
  if (dbInfo.storeName) {
    return dbInfo.storeName;
  }
  throw createLocalSpaceError(
    'INVALID_CONFIG',
    'IndexedDB storeName is not configured.',
    { driver: DRIVER_NAME, configKey: 'storeName' }
  );
}

function getDbContextKey(dbInfo: DbInfo): string {
  const dbName = requireDbName(dbInfo);
  const contextId =
    dbInfo.idbContextId ??
    (dbInfo.bucket?.name ? `bucket:${dbInfo.bucket.name}` : 'default');
  return `${contextId}::${dbName}`;
}

function getDbContext(dbInfo: DbInfo): DbContext | undefined {
  return dbContexts[getDbContextKey(dbInfo)];
}

function ensureDbContext(dbInfo: DbInfo): DbContext {
  const key = getDbContextKey(dbInfo);
  dbContexts[key] = dbContexts[key] || createDbContext();
  return dbContexts[key];
}

function disposeDbContextIfUnused(
  dbInfo: DbInfo,
  dbContext: DbContext
): boolean {
  if (
    dbContext.forages.length > 0 ||
    dbContext.activeTransactions > 0 ||
    dbContext.pendingTransactions.length > 0 ||
    dbContext.deferredOperations.length > 0 ||
    dbContext.prewarmPromise
  ) {
    return false;
  }

  if (dbContext.idleTimer) {
    clearTimeout(dbContext.idleTimer);
    dbContext.idleTimer = null;
  }
  try {
    dbContext.db?.close();
  } catch {
    // The registry can still be released after a best-effort close.
  }
  dbContext.db = null;
  dbContext.prewarmed = false;

  const contextKey = getDbContextKey(dbInfo);
  if (dbContexts[contextKey] === dbContext) {
    delete dbContexts[contextKey];
  }
  return true;
}

function deferReadiness(dbInfo: DbInfo): void {
  const dbContext = ensureDbContext(dbInfo);
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
  const dbContext = getDbContext(dbInfo);
  if (!dbContext) return;
  const deferredOperation = dbContext.deferredOperations.pop();

  if (deferredOperation) {
    deferredOperation.resolve();
    return deferredOperation.promise;
  }

  return undefined;
}

function rejectReadiness(
  dbInfo: DbInfo,
  err: Error
): Promise<void> | undefined {
  const dbContext = getDbContext(dbInfo);
  if (!dbContext) return;
  const deferredOperation = dbContext.deferredOperations.pop();

  if (deferredOperation) {
    deferredOperation.reject(err);
    return deferredOperation.promise;
  }

  return undefined;
}

function getConnection(
  dbInfo: DbInfo,
  upgradeNeeded: boolean
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = getIDB(dbInfo);
    if (!idb) {
      return reject(
        createLocalSpaceError('DRIVER_UNAVAILABLE', 'IndexedDB not available', {
          driver: DRIVER_NAME,
        })
      );
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
        const contextKey = getDbContextKey(dbInfo);
        const dbContext = dbContexts[contextKey];
        if (dbContext) {
          dbContext.db = null;
          dbContext.prewarmed = false;
          for (const forage of dbContext.forages) {
            forage._dbInfo.db = null;
          }
        }
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
  mode: TransactionMode
): IDBTransactionOptions | undefined {
  if (mode === READ_WRITE && dbInfo.durability) {
    return { durability: dbInfo.durability };
  }
  return undefined;
}

function maybePrewarmTransaction(
  dbInfo: DbInfo,
  dbContext: DbContext
): Promise<void> | undefined {
  if (dbInfo.prewarmTransactions === false) {
    return undefined;
  }
  if (dbContext.prewarmed || dbContext.prewarmPromise) {
    return dbContext.prewarmPromise || Promise.resolve();
  }

  const promise = new Promise<void>((resolve) => {
    try {
      const storeName = requireStoreName(dbInfo);
      const txOptions = getTransactionOptions(dbInfo, READ_ONLY);
      const tx = txOptions
        ? dbInfo.db!.transaction(storeName, READ_ONLY, txOptions)
        : dbInfo.db!.transaction(storeName, READ_ONLY);
      // A lightweight request warms up the connection without mutating data.
      tx.objectStore(storeName).count();

      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });

  dbContext.prewarmPromise = promise;
  promise.finally(() => {
    dbContext.prewarmPromise = null;
    dbContext.prewarmed = true;
  });
  return promise;
}

function scheduleIdleClose(dbInfo: DbInfo): void {
  const dbContext = getDbContext(dbInfo);
  const idleMs = dbInfo.connectionIdleMs;
  if (!dbContext || !dbContext.db || !idleMs || idleMs <= 0) {
    return;
  }

  if (dbContext.idleTimer) {
    clearTimeout(dbContext.idleTimer);
  }

  dbContext.idleTimer = setTimeout(() => {
    if (
      dbContext.pendingTransactions.length > 0 ||
      dbContext.activeTransactions > 0
    ) {
      // Defer closing until the queue drains.
      scheduleIdleClose(dbInfo);
      return;
    }
    try {
      dbContext.db?.close();
    } catch {
      // ignore close errors
    }
    dbContext.db = null;
    dbContext.prewarmed = false;
    for (const forage of dbContext.forages) {
      forage._dbInfo.db = null;
    }
  }, idleMs);
}

function createTransaction(
  dbInfo: DbInfo,
  mode: TransactionMode,
  callback: (error: Error | null, transaction?: IDBTransaction) => void,
  retries: number = 1
): void {
  const handleError = (err: any) => {
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
          return undefined;
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
  };

  try {
    const dbContext = ensureDbContext(dbInfo);
    if (dbContext.idleTimer) {
      clearTimeout(dbContext.idleTimer);
      dbContext.idleTimer = null;
    }

    const maxTx = dbInfo.maxConcurrentTransactions;
    const processPending = (): boolean => {
      if (dbContext.pendingTransactions.length > 0) {
        const next = dbContext.pendingTransactions.shift();
        if (next) {
          setTimeout(next, 0);
          return true;
        }
      }
      return false;
    };

    const start = () => {
      try {
        const txOptions = getTransactionOptions(dbInfo, mode);
        const tx = txOptions
          ? dbInfo.db!.transaction(dbInfo.storeName!, mode, txOptions)
          : dbInfo.db!.transaction(dbInfo.storeName!, mode);

        dbContext.activeTransactions += 1;

        let finalized = false;
        const finalize = () => {
          if (finalized) {
            return;
          }
          finalized = true;
          dbContext.activeTransactions = Math.max(
            0,
            dbContext.activeTransactions - 1
          );
          const scheduledPendingTransaction = processPending();
          if (
            scheduledPendingTransaction ||
            !disposeDbContextIfUnused(dbInfo, dbContext)
          ) {
            scheduleIdleClose(dbInfo);
          }
        };

        tx.addEventListener('complete', finalize);
        tx.addEventListener('abort', finalize);
        tx.addEventListener('error', finalize);

        callback(null, tx);
      } catch (error) {
        handleError(error);
      }
    };

    if (maxTx && maxTx > 0 && dbContext.activeTransactions >= maxTx) {
      dbContext.pendingTransactions.push(start);
      return;
    }

    start();
  } catch (err: any) {
    handleError(err);
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
  dbContext.db = null;

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

  const backend = await resolveIdbBackend(config);
  if (!backend) {
    throw createLocalSpaceError(
      'DRIVER_UNAVAILABLE',
      'IndexedDB not available',
      { driver: DRIVER_NAME }
    );
  }
  dbInfo.idbFactory = backend.factory;
  dbInfo.idbContextId = backend.contextId;

  // Validates that a database name is configured (throws otherwise).
  requireDbName(dbInfo);
  self._dbInfo = dbInfo;
  const dbContext = ensureDbContext(dbInfo);

  if (!dbContext.forages.includes(self)) {
    dbContext.forages.push(self);
  }

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

  for (const forage of forages) {
    if (forage !== self) {
      forage._dbInfo.db = dbInfo.db;
      forage._dbInfo.version = dbInfo.version;
    }
  }

  // Opportunistic prewarm to avoid cold-start latency on first operation
  const prewarm = maybePrewarmTransaction(dbInfo, dbContext);
  if (prewarm) {
    prewarm.catch(() => undefined);
  }
}

async function _closeStorage(this: IndexedDBDriverContext): Promise<void> {
  const self = this;
  const dbInfo = self._dbInfo;
  if (!dbInfo) {
    return;
  }

  const contextKey = getDbContextKey(dbInfo);
  const dbContext = dbContexts[contextKey];
  if (!dbContext) {
    dbInfo.db = null;
    return;
  }

  for (let index = dbContext.forages.length - 1; index >= 0; index--) {
    if (dbContext.forages[index] === self) {
      dbContext.forages.splice(index, 1);
    }
  }
  dbInfo.db = null;

  if (dbContext.forages.length > 0) {
    return;
  }

  if (dbContext.idleTimer) {
    clearTimeout(dbContext.idleTimer);
    dbContext.idleTimer = null;
  }
  if (dbContext.prewarmPromise) {
    await dbContext.prewarmPromise.catch(() => undefined);
  }

  try {
    dbContext.db?.close();
  } finally {
    dbContext.db = null;
    dbContext.prewarmed = false;
    disposeDbContextIfUnused(dbInfo, dbContext);
  }
}

function fullyReady(this: IndexedDBDriverContext): Promise<void> {
  const self = this;
  const initReady = (self._initReady ?? self.ready).bind(self);
  const promise = withIdbErrorContext(
    initReady().then(() => {
      if (self._dbInfo) {
        const dbContext = getDbContext(self._dbInfo);
        if (dbContext && dbContext.dbReady) {
          return dbContext.dbReady;
        }
      }
      return undefined;
    }),
    'ready'
  );

  return promise;
}

function getItem<T>(
  this: IndexedDBDriverContext,
  key: string
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

  const wrappedPromise = withIdbErrorContext(
    promise,
    'getItem',
    { key },
    'OPERATION_FAILED'
  );

  return wrappedPromise;
}

function getItems<T>(
  this: IndexedDBDriverContext,
  keys: string[]
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

  const wrappedPromise = withIdbErrorContext(
    promise,
    'getItems',
    { keys: normalizedKeys },
    'OPERATION_FAILED'
  );

  return wrappedPromise;
}

function iterate<T, U>(
  this: IndexedDBDriverContext,
  iterator: (value: T, key: string, iterationNumber: number) => U
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

  const wrappedPromise = withIdbErrorContext(promise, 'iterate');

  return wrappedPromise;
}

function setItems<T>(
  this: IndexedDBDriverContext,
  items: BatchItems<T>
): Promise<BatchResponse<T>> {
  const self = this;
  const normalized = normalizeBatchEntries(items);
  const itemKeys = normalized.map((entry) => entry.key);

  const promise = new Promise<BatchResponse<T>>(async (resolve, reject) => {
    try {
      await self.ready();
      const dbInfo = self._dbInfo;

      let blobSupport: boolean | undefined;

      const needsBlobCheck = normalized.some(
        (entry) => toString.call(entry.value) === '[object Blob]'
      );

      if (needsBlobCheck) {
        blobSupport = await ensureBlobSupportForDb(dbInfo);
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
                : await ensureBlobSupportForDb(dbInfo);
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

  const wrappedPromise = withIdbErrorContext(
    promise,
    'setItems',
    { keys: itemKeys },
    'OPERATION_FAILED'
  );

  return wrappedPromise;
}

async function setItem<T>(
  this: IndexedDBDriverContext,
  key: string,
  value: T
): Promise<T> {
  const self = this;
  key = normalizeKey(key);

  const promise = new Promise<T | null | undefined>(async (resolve, reject) => {
    let dbInfo: DbInfo;
    try {
      dbInfo = self._dbInfo;
      if (!dbInfo || !dbInfo.db) {
        await self.ready();
        dbInfo = self._dbInfo;
      }

      if (toString.call(value) === '[object Blob]') {
        const blobSupport = await ensureBlobSupportForDb(dbInfo);
        if (!blobSupport) {
          value = (await encodeBlob(value as Blob)) as T;
        }
      }

      const normalizedValue = (value === undefined ? null : value) as T;

      createTransaction(
        dbInfo,
        READ_WRITE,
        (err: Error | null, transaction?: IDBTransaction) => {
          if (err) return reject(err);

          try {
            const storeName = requireStoreName(dbInfo);
            const store = transaction!.objectStore(storeName);
            const req = store.put(normalizedValue, key);

            transaction!.oncomplete = () => {
              resolve(normalizedValue);
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

  const wrappedPromise = withIdbErrorContext(promise as Promise<T>, 'setItem', {
    key,
  });

  return wrappedPromise as Promise<T>;
}

function removeItem(this: IndexedDBDriverContext, key: string): Promise<void> {
  const self = this;
  key = normalizeKey(key);

  const promise = new Promise<void>((resolve, reject) => {
    (async () => {
      let dbInfo = self._dbInfo;
      if (!dbInfo || !dbInfo.db) {
        await self.ready();
        dbInfo = self._dbInfo;
      }

      createTransaction(
        dbInfo,
        READ_WRITE,
        (err: Error | null, transaction?: IDBTransaction) => {
          if (err) return reject(err);

          try {
            const storeName = requireStoreName(dbInfo);
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
    })().catch(reject);
  });

  const wrappedPromise = withIdbErrorContext(promise, 'removeItem', { key });

  return wrappedPromise;
}

function removeItems(
  this: IndexedDBDriverContext,
  keys: string[]
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

  const wrappedPromise = withIdbErrorContext(promise, 'removeItems', {
    keys: normalizedKeys,
  });

  return wrappedPromise;
}

function runTransaction<T>(
  this: IndexedDBDriverContext,
  mode: TransactionMode,
  runner: (scope: TransactionScope) => Promise<T> | T
): Promise<T> {
  const self = this;

  const promise = new Promise<T>(async (resolve, reject) => {
    try {
      if (mode !== READ_ONLY && mode !== READ_WRITE) {
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

      await self.ready();
      const dbInfo = self._dbInfo;
      // Compute blob support once up front so we don't pause an empty transaction later.
      let precomputedBlobSupport: boolean | undefined;
      if (mode === READ_WRITE) {
        try {
          precomputedBlobSupport = await ensureBlobSupportForDb(dbInfo);
        } catch {
          precomputedBlobSupport = undefined;
        }
      }
      createTransaction(
        dbInfo,
        mode,
        (err: Error | null, transaction?: IDBTransaction) => {
          if (err || !transaction) {
            reject(err || new Error('Failed to create transaction'));
            return;
          }

          try {
            const storeName = requireStoreName(dbInfo);
            const store = transaction.objectStore(storeName);
            let blobSupport: boolean | undefined = precomputedBlobSupport;

            const isTransactionActive = (): boolean => {
              try {
                transaction.objectStore(storeName);
                return true;
              } catch {
                return false;
              }
            };

            const ensureBlobSupport = async (): Promise<boolean> => {
              if (typeof blobSupport === 'boolean') return blobSupport;
              blobSupport = await ensureBlobSupportForDb(
                dbInfo,
                transaction.db
              );
              return blobSupport!;
            };

            const makeReadOnlyGuard = () => {
              if (mode === READ_ONLY) {
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

                if (!isTransactionActive()) {
                  throw new Error(
                    'Transaction became inactive while preparing data.'
                  );
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
              iterate: <V, U>(
                fn: (value: V, key: string, iteration: number) => U
              ) =>
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
              transaction.oncomplete = () => res();
              transaction.onabort = () =>
                rej(transaction.error || new Error('Transaction aborted'));
              transaction.onerror = () =>
                rej(transaction.error || new Error('Transaction error'));
            });

            const guardedRunner = runnerPromise.catch((runnerError) => {
              try {
                transaction.abort();
              } catch {
                // The transaction may have committed while the async runner
                // was awaiting unrelated work. Preserve the 2.x runner result.
              }
              throw runnerError;
            });

            Promise.allSettled([guardedRunner, completion]).then(
              ([runnerOutcome, completionOutcome]) => {
                if (runnerOutcome.status === 'rejected') {
                  reject(runnerOutcome.reason);
                  return;
                }
                if (completionOutcome.status === 'rejected') {
                  reject(completionOutcome.reason);
                  return;
                }
                resolve(runnerOutcome.value);
              }
            );
          } catch (error) {
            reject(error as Error);
          }
        }
      );
    } catch (err) {
      reject(err as Error);
    }
  });

  const wrappedPromise = withIdbErrorContext(promise, 'runTransaction', {
    transactionMode: mode,
  });

  return wrappedPromise;
}

function clear(this: IndexedDBDriverContext): Promise<void> {
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

  const wrappedPromise = withIdbErrorContext(promise, 'clear');

  return wrappedPromise;
}

function length(this: IndexedDBDriverContext): Promise<number> {
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

  const wrappedPromise = withIdbErrorContext(promise, 'length');

  return wrappedPromise;
}

function key(this: IndexedDBDriverContext, n: number): Promise<string | null> {
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

  const wrappedPromise = withIdbErrorContext(promise, 'key', { keyIndex: n });

  return wrappedPromise;
}

function keys(this: IndexedDBDriverContext): Promise<string[]> {
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

  const wrappedPromise = withIdbErrorContext(promise, 'keys');

  return wrappedPromise;
}

function dropInstance(
  this: IndexedDBDriverContext,
  options?: LocalSpaceConfig
): Promise<void> {
  const self = this;
  const currentConfig = self._config;

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
    const promise = Promise.reject(
      createLocalSpaceError('INVALID_ARGUMENT', 'Invalid arguments', {
        driver: DRIVER_NAME,
        operation: 'dropInstance',
      })
    );
    const wrappedInvalid = withIdbErrorContext(promise, 'dropInstance', {
      name: effectiveOptions.name,
      storeName: effectiveOptions.storeName,
    });
    return wrappedInvalid;
  }

  const currentDbInfo = self._dbInfo as DbInfo | undefined;

  const dropDbInfo: DbInfo = {
    ...(effectiveOptions as DbInfo),
    idbFactory: currentDbInfo?.idbFactory ?? undefined,
    idbContextId: currentDbInfo?.idbContextId,
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
    promise = dbPromise.then(async (db) => {
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
          return reject(
            createLocalSpaceError(
              'DRIVER_UNAVAILABLE',
              'IndexedDB not available',
              { driver: DRIVER_NAME }
            )
          );
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
            delete dbContexts[contextKey];
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
    promise = dbPromise.then(async (db) => {
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
          return reject(
            createLocalSpaceError(
              'DRIVER_UNAVAILABLE',
              'IndexedDB not available',
              { driver: DRIVER_NAME }
            )
          );
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
            rejectReadiness(dropDbInfo, err);
          }
          throw err;
        });
    });
  }

  const wrappedPromise = withIdbErrorContext(promise, 'dropInstance', {
    name: effectiveOptions.name,
    storeName: effectiveOptions.storeName,
  });

  return wrappedPromise;
}

const asyncStorage: Driver = {
  _driver: 'asyncStorage',
  _initStorage,
  _closeStorage,
  _support: isIndexedDBValid,
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

// Expose limited internals for testing without altering public API surface.
// Browser-native ESM consumers do not provide Node's `process` global.
if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test') {
  (asyncStorage as any).__test__ = {
    createTransaction,
    getDbContext,
  };
}

export default asyncStorage;
