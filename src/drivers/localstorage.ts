import type {
  Driver,
  DbInfo,
  LocalSpaceConfig,
  Callback,
  Serializer,
  LocalSpaceInstance,
  BatchItems,
  BatchResponse,
} from '../types';
import {
  executeCallback,
  normalizeBatchEntries,
  normalizeKey,
} from '../utils/helpers';
import serializer from '../utils/serializer';

type LocalStorageDbInfo = DbInfo & {
  keyPrefix: string;
  serializer: Serializer;
};

type LocalStorageDriverContext = LocalSpaceInstance &
  Partial<Driver> & {
    _dbInfo: LocalStorageDbInfo;
    _defaultConfig: LocalSpaceConfig;
    ready(): Promise<void>;
    config(): LocalSpaceConfig;
  };

function isLocalStorageValid(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      'setItem' in localStorage &&
      !!localStorage.setItem
    );
  } catch (e) {
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

function checkIfLocalStorageThrows(): boolean {
  const localStorageTestKey = '_localforage_support_test';

  try {
    localStorage.setItem(localStorageTestKey, 'true');
    localStorage.removeItem(localStorageTestKey);
    return false;
  } catch (e) {
    return true;
  }
}

function isLocalStorageUsable(): boolean {
  return !checkIfLocalStorageThrows() || localStorage.length > 0;
}

async function _initStorage(
  this: LocalStorageDriverContext,
  config: LocalSpaceConfig
): Promise<void> {
  const dbInfo: LocalStorageDbInfo = {
    ...config,
    keyPrefix: getKeyPrefix(config, this._defaultConfig),
    serializer,
  };

  if (!isLocalStorageUsable()) {
    throw new Error('localStorage not usable');
  }

  this._dbInfo = dbInfo;
}

function clear(
  this: LocalStorageDriverContext,
  callback?: Callback<void>
): Promise<void> {
  const promise = this.ready().then(() => {
    const keyPrefix = this._dbInfo.keyPrefix;

    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.indexOf(keyPrefix) === 0) {
        localStorage.removeItem(key);
      }
    }
  });

  executeCallback(promise, callback);
  return promise;
}

function getItem<T>(
  this: LocalStorageDriverContext,
  key: string,
  callback?: Callback<T>
): Promise<T | null> {
  const normalizedKey = normalizeKey(key);

  const promise = this.ready().then(() => {
    const dbInfo = this._dbInfo;
    const raw = localStorage.getItem(dbInfo.keyPrefix + normalizedKey);

    if (raw === null) {
      return null;
    }

    return dbInfo.serializer.deserialize(raw) as T;
  });

  executeCallback(
    promise as Promise<T | null>,
    callback as Callback<T | null> | undefined
  );
  return promise;
}

function iterate<T, U>(
  this: LocalStorageDriverContext,
  iterator: (value: T, key: string, iterationNumber: number) => U,
  callback?: Callback<U>
): Promise<U> {
  const promise = this.ready().then(() => {
    const dbInfo = this._dbInfo;
    const keyPrefix = dbInfo.keyPrefix;
    const keyPrefixLength = keyPrefix.length;
    const length = localStorage.length;
    let iterationNumber = 1;

    for (let i = 0; i < length; i++) {
      const key = localStorage.key(i);
      if (!key || key.indexOf(keyPrefix) !== 0) {
        continue;
      }

      const rawValue = localStorage.getItem(key);
      let value: T | null = null;
      if (rawValue !== null) {
        value = dbInfo.serializer.deserialize(rawValue) as T;
      }

      const result = iterator(
        value as T,
        key.substring(keyPrefixLength),
        iterationNumber++
      );

      if (result !== undefined) {
        return result;
      }
    }

    return undefined as unknown as U;
  });

  executeCallback(promise, callback);
  return promise;
}

function key(
  this: LocalStorageDriverContext,
  n: number,
  callback?: Callback<string>
): Promise<string | null> {
  const promise = this.ready().then(() => {
    const dbInfo = this._dbInfo;
    const keyPrefix = dbInfo.keyPrefix;
    const keys: string[] = [];

    // Collect keys that match the prefix; keep native storage iteration order
    for (let i = 0; i < localStorage.length; i++) {
      const itemKey = localStorage.key(i);
      if (itemKey && itemKey.indexOf(keyPrefix) === 0) {
        keys.push(itemKey.substring(keyPrefix.length));
      }
    }

    if (n < 0 || n >= keys.length) {
      return null;
    }

    return keys[n];
  });

  executeCallback(promise, callback as Callback<string | null> | undefined);
  return promise;
}

function keys(
  this: LocalStorageDriverContext,
  callback?: Callback<string[]>
): Promise<string[]> {
  const promise = this.ready().then(() => {
    const dbInfo = this._dbInfo;
    const length = localStorage.length;
    const keys: string[] = [];

    for (let i = 0; i < length; i++) {
      const itemKey = localStorage.key(i);
      if (itemKey && itemKey.indexOf(dbInfo.keyPrefix) === 0) {
        keys.push(itemKey.substring(dbInfo.keyPrefix.length));
      }
    }

    return keys;
  });

  executeCallback(promise, callback);
  return promise;
}

function length(
  this: LocalStorageDriverContext,
  callback?: Callback<number>
): Promise<number> {
  const promise = keys.call(this).then((derivedKeys) => derivedKeys.length);

  executeCallback(promise, callback);
  return promise;
}

function removeItem(
  this: LocalStorageDriverContext,
  key: string,
  callback?: Callback<void>
): Promise<void> {
  const normalizedKey = normalizeKey(key);

  const promise = this.ready().then(() => {
    const dbInfo = this._dbInfo;
    localStorage.removeItem(dbInfo.keyPrefix + normalizedKey);
  });

  executeCallback(promise, callback);
  return promise;
}

function removeItems(
  this: LocalStorageDriverContext,
  keys: string[],
  callback?: Callback<void>
): Promise<void> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = this.ready().then(() => {
    const dbInfo = this._dbInfo;
    for (const key of normalizedKeys) {
      localStorage.removeItem(dbInfo.keyPrefix + key);
    }
  });

  executeCallback(promise, callback);
  return promise;
}

async function setItem<T>(
  this: LocalStorageDriverContext,
  key: string,
  value: T,
  callback?: Callback<T>
): Promise<T> {
  const normalizedKey = normalizeKey(key);

  const promise = this.ready().then(async () => {
    const normalizedValue = (value === undefined ? null : value) as T;
    const serializedValue =
      await this._dbInfo.serializer.serialize(normalizedValue);

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
        throw error;
      }
      throw error;
    }
  });

  executeCallback(promise, callback);
  return promise;
}

function setItems<T>(
  this: LocalStorageDriverContext,
  items: BatchItems<T>,
  callback?: Callback<BatchResponse<T>>
): Promise<BatchResponse<T>> {
  const normalized = normalizeBatchEntries(items);

  const promise = this.ready().then(async () => {
    const dbInfo = this._dbInfo;
    const stored: BatchResponse<T> = [];

    for (const entry of normalized) {
      const normalizedValue = (entry.value === undefined
        ? null
        : entry.value) as T;
      const serializedValue = await dbInfo.serializer.serialize(
        normalizedValue
      );

      localStorage.setItem(
        dbInfo.keyPrefix + entry.key,
        serializedValue
      );
      stored.push({ key: entry.key, value: normalizedValue });
    }

    return stored;
  });

  executeCallback(promise, callback);
  return promise;
}

function getItems<T>(
  this: LocalStorageDriverContext,
  keys: string[],
  callback?: Callback<BatchResponse<T>>
): Promise<BatchResponse<T>> {
  const normalizedKeys = keys.map((key) => normalizeKey(key));

  const promise = this.ready().then(() => {
    const dbInfo = this._dbInfo;
    const results: BatchResponse<T> = [];

    for (const key of normalizedKeys) {
      const raw = localStorage.getItem(dbInfo.keyPrefix + key);
      if (raw === null) {
        results.push({ key, value: null });
        continue;
      }
      const value = dbInfo.serializer.deserialize(raw) as T;
      results.push({ key, value });
    }

    return results;
  });

  executeCallback(promise, callback);
  return promise;
}

function dropInstance(
  this: LocalStorageDriverContext,
  options?: LocalSpaceConfig,
  callback?: Callback<void>
): Promise<void> {
  const effectiveOptions: LocalSpaceConfig = { ...(options || {}) };

  if (!effectiveOptions.name) {
    const currentConfig = this.config();
    effectiveOptions.name = currentConfig.name;
    effectiveOptions.storeName = currentConfig.storeName;
  }

  const promise = !effectiveOptions.name
    ? Promise.reject(new Error('Invalid arguments'))
    : new Promise<void>((resolve) => {
        const keyPrefix = !effectiveOptions.storeName
          ? `${effectiveOptions.name}/`
          : getKeyPrefix(effectiveOptions, this._defaultConfig);

        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.indexOf(keyPrefix) === 0) {
            localStorage.removeItem(key);
          }
        }
        resolve();
      });

  executeCallback(promise, callback);
  return promise;
}

const localStorageWrapper: Driver = {
  _driver: 'localStorageWrapper',
  _initStorage,
  _support: isLocalStorageValid(),
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
