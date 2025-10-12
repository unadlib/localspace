import { describe, it, expect, beforeEach } from 'vitest';
import localspace from '../src/index';

describe('localspace basic API', () => {
  beforeEach(async () => {
    await localspace.clear();
  });

  it('should export INDEXEDDB and LOCALSTORAGE constants', () => {
    expect(localspace.INDEXEDDB).toBe('asyncStorage');
    expect(localspace.LOCALSTORAGE).toBe('localStorageWrapper');
  });

  it('should set and get a string value', async () => {
    await localspace.setItem('testKey', 'testValue');
    const value = await localspace.getItem('testKey');
    expect(value).toBe('testValue');
  });

  it('should set and get a number value', async () => {
    await localspace.setItem('numberKey', 42);
    const value = await localspace.getItem('numberKey');
    expect(value).toBe(42);
  });

  it('should set and get an object', async () => {
    const obj = { foo: 'bar', nested: { a: 1, b: 2 } };
    await localspace.setItem('objectKey', obj);
    const value = await localspace.getItem('objectKey');
    expect(value).toEqual(obj);
  });

  it('should set and get an array', async () => {
    const arr = [1, 'two', { three: 3 }];
    await localspace.setItem('arrayKey', arr);
    const value = await localspace.getItem('arrayKey');
    expect(value).toEqual(arr);
  });

  it('should set and get null', async () => {
    await localspace.setItem('nullKey', null);
    const value = await localspace.getItem('nullKey');
    expect(value).toBe(null);
  });

  it('should return null for non-existent key', async () => {
    const value = await localspace.getItem('nonExistentKey');
    expect(value).toBe(null);
  });

  it('should remove an item', async () => {
    await localspace.setItem('removeKey', 'removeValue');
    await localspace.removeItem('removeKey');
    const value = await localspace.getItem('removeKey');
    expect(value).toBe(null);
  });

  it('should clear all items', async () => {
    await localspace.setItem('key1', 'value1');
    await localspace.setItem('key2', 'value2');
    await localspace.clear();
    const value1 = await localspace.getItem('key1');
    const value2 = await localspace.getItem('key2');
    expect(value1).toBe(null);
    expect(value2).toBe(null);
  });

  it('should get length', async () => {
    await localspace.clear();
    await localspace.setItem('key1', 'value1');
    await localspace.setItem('key2', 'value2');
    const length = await localspace.length();
    expect(length).toBe(2);
  });

  it('should get keys', async () => {
    await localspace.clear();
    await localspace.setItem('key1', 'value1');
    await localspace.setItem('key2', 'value2');
    const keys = await localspace.keys();
    expect(keys.sort()).toEqual(['key1', 'key2']);
  });

  it('should get key at index', async () => {
    await localspace.clear();
    await localspace.setItem('key1', 'value1');
    await localspace.setItem('key2', 'value2');
    const key = await localspace.key(0);
    expect(['key1', 'key2']).toContain(key);
  });

  it('should iterate over items', async () => {
    await localspace.clear();
    await localspace.setItem('key1', 'value1');
    await localspace.setItem('key2', 'value2');

    const items: Record<string, any> = {};
    await localspace.iterate((value, key) => {
      items[key] = value;
    });

    expect(items).toEqual({ key1: 'value1', key2: 'value2' });
  });

  it('should support callbacks', async () => {
    await new Promise<void>((resolve) => {
      localspace.setItem('callbackKey', 'callbackValue', (err, value) => {
        expect(err).toBe(null);
        expect(value).toBe('callbackValue');

        localspace.getItem('callbackKey', (err, value) => {
          expect(err).toBe(null);
          expect(value).toBe('callbackValue');
          resolve();
        });
      });
    });
  });

  it('should get driver name', () => {
    const driver = localspace.driver();
    expect(driver).toBeTruthy();
  });

  it('should check if driver is supported', () => {
    const supportsIndexedDB = localspace.supports(localspace.INDEXEDDB);
    const supportsLocalStorage = localspace.supports(localspace.LOCALSTORAGE);
    expect(supportsIndexedDB || supportsLocalStorage).toBe(true);
  });

  it('should create new instance', async () => {
    const instance = localspace.createInstance({
      name: 'testDB',
      storeName: 'testStore'
    });

    await instance.setItem('instanceKey', 'instanceValue');
    const value = await instance.getItem('instanceKey');
    expect(value).toBe('instanceValue');
  });

  it('should configure instance', () => {
    const config = localspace.config();
    expect(config).toBeDefined();
    expect(config.name).toBe('localforage');
    expect(config.storeName).toBe('keyvaluepairs');
  });
});
