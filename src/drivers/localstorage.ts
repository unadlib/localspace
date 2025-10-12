import type { Driver, DbInfo, LocalspaceConfig, Callback } from '../types';
import { executeCallback, normalizeKey } from '../utils/helpers';
import serializer from '../utils/serializer';

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

function getKeyPrefix(options: LocalspaceConfig, defaultConfig: LocalspaceConfig): string {
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

async function _initStorage(this: any, config: LocalspaceConfig): Promise<void> {
  const self = this;
  const dbInfo: DbInfo = {};

  for (const i in config) {
    (dbInfo as any)[i] = (config as any)[i];
  }

  dbInfo.keyPrefix = getKeyPrefix(config, self._defaultConfig);

  if (!isLocalStorageUsable()) {
    throw new Error('localStorage not usable');
  }

  self._dbInfo = dbInfo;
  dbInfo.serializer = serializer;
}

function clear(this: any, callback?: Callback<void>): Promise<void> {
  const self = this;

  const promise = self.ready().then(() => {
    const keyPrefix = self._dbInfo.keyPrefix;

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
  this: any,
  key: string,
  callback?: Callback<T>
): Promise<T | null> {
  const self = this;
  key = normalizeKey(key);

  const promise = self.ready().then(() => {
    const dbInfo = self._dbInfo;
    let result: any = localStorage.getItem(dbInfo.keyPrefix + key);

    if (result) {
      result = dbInfo.serializer.deserialize(result);
    }

    return result as T | null;
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

  const promise = self.ready().then(() => {
    const dbInfo = self._dbInfo;
    const keyPrefix = dbInfo.keyPrefix;
    const keyPrefixLength = keyPrefix.length;
    const length = localStorage.length;
    let iterationNumber = 1;

    for (let i = 0; i < length; i++) {
      const key = localStorage.key(i);
      if (!key || key.indexOf(keyPrefix) !== 0) {
        continue;
      }

      let value: any = localStorage.getItem(key);
      if (value) {
        value = dbInfo.serializer.deserialize(value);
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

  const promise = self.ready().then(() => {
    const dbInfo = self._dbInfo;
    let result: string | null;

    try {
      result = localStorage.key(n);
    } catch (error) {
      result = null;
    }

    if (result) {
      result = result.substring(dbInfo.keyPrefix.length);
    }

    return result;
  });

  executeCallback(promise, callback);
  return promise;
}

function keys(this: any, callback?: Callback<string[]>): Promise<string[]> {
  const self = this;

  const promise = self.ready().then(() => {
    const dbInfo = self._dbInfo;
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

function length(this: any, callback?: Callback<number>): Promise<number> {
  const self = this;

  const promise = self.keys().then((keys: string[]) => keys.length);

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

  const promise = self.ready().then(() => {
    const dbInfo = self._dbInfo;
    localStorage.removeItem(dbInfo.keyPrefix + key);
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

  const promise = self.ready().then(async () => {
    if (value === undefined) {
      value = null as any;
    }

    const originalValue = value;

    const serializedValue = await self._dbInfo.serializer.serialize(value);

    try {
      localStorage.setItem(self._dbInfo.keyPrefix + key, serializedValue);
      return originalValue;
    } catch (e: any) {
      if (
        e.name === 'QuotaExceededError' ||
        e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      ) {
        throw e;
      }
      throw e;
    }
  });

  executeCallback(promise, callback);
  return promise;
}

function dropInstance(
  this: any,
  options?: LocalspaceConfig,
  callback?: Callback<void>
): Promise<void> {
  const self = this;
  options = options || {};

  if (!options.name) {
    const currentConfig = self.config();
    options.name = options.name || currentConfig.name;
    options.storeName = options.storeName || currentConfig.storeName;
  }

  const promise = !options.name
    ? Promise.reject(new Error('Invalid arguments'))
    : new Promise<void>((resolve) => {
        const keyPrefix = !options!.storeName
          ? `${options!.name}/`
          : getKeyPrefix(options!, self._defaultConfig);

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
  setItem,
  removeItem,
  clear,
  length,
  key,
  keys,
  dropInstance,
};

export default localStorageWrapper;
