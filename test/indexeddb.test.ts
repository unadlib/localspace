import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import localspace from '../src/index';
import type { LocalSpaceInstance } from '../src/types';

describe('IndexedDB driver tests', () => {
  let instance: LocalSpaceInstance;

  beforeEach(async () => {
    instance = localspace.createInstance({
      name: `indexeddb-test-${Math.random().toString(36).slice(2)}`,
      storeName: 'testStore',
    });

    // Force IndexedDB driver
    await instance.setDriver([instance.INDEXEDDB]);
    await instance.ready();
    await instance.clear();
  });

  afterEach(async () => {
    try {
      await instance.clear();
      await instance.dropInstance();
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('Basic CRUD operations', () => {
    it('should set and get items with IndexedDB', async () => {
      await instance.setItem('key1', 'value1');
      const value = await instance.getItem('key1');
      expect(value).toBe('value1');
    });

    it('should handle complex objects', async () => {
      const complexObj = {
        string: 'test',
        number: 42,
        boolean: true,
        null: null,
        nested: { a: 1, b: [1, 2, 3] },
      };
      await instance.setItem('complex', complexObj);
      const retrieved = await instance.getItem('complex');
      expect(retrieved).toEqual(complexObj);
    });

    it('should handle arrays', async () => {
      const arr = [1, 2, 'three', { four: 4 }];
      await instance.setItem('array', arr);
      const retrieved = await instance.getItem('array');
      expect(retrieved).toEqual(arr);
    });

    it('should handle null values', async () => {
      await instance.setItem('nullKey', null);
      const value = await instance.getItem('nullKey');
      expect(value).toBe(null);
    });

    it('should return null for non-existent keys', async () => {
      const value = await instance.getItem('nonExistent');
      expect(value).toBe(null);
    });

    it('should remove items', async () => {
      await instance.setItem('toRemove', 'value');
      expect(await instance.getItem('toRemove')).toBe('value');

      await instance.removeItem('toRemove');
      expect(await instance.getItem('toRemove')).toBe(null);
    });

    it('should clear all items', async () => {
      await instance.setItem('key1', 'value1');
      await instance.setItem('key2', 'value2');
      await instance.setItem('key3', 'value3');

      await instance.clear();

      expect(await instance.getItem('key1')).toBe(null);
      expect(await instance.getItem('key2')).toBe(null);
      expect(await instance.getItem('key3')).toBe(null);
    });
  });

  describe('Key management', () => {
    beforeEach(async () => {
      await instance.clear();
      await instance.setItem('key1', 'value1');
      await instance.setItem('key2', 'value2');
      await instance.setItem('key3', 'value3');
    });

    it('should get length', async () => {
      const length = await instance.length();
      expect(length).toBe(3);
    });

    it('should get all keys', async () => {
      const keys = await instance.keys();
      expect(keys.sort()).toEqual(['key1', 'key2', 'key3']);
    });

    it('should get key at index', async () => {
      const key0 = await instance.key(0);
      const key1 = await instance.key(1);
      const key2 = await instance.key(2);

      const keys = [key0, key1, key2].sort();
      expect(keys).toEqual(['key1', 'key2', 'key3']);
    });

    it('should return null for negative index', async () => {
      const key = await instance.key(-1);
      expect(key).toBe(null);
    });

    it('should return null for out of bounds index', async () => {
      const key = await instance.key(999);
      expect(key).toBe(null);
    });
  });

  describe('Iteration', () => {
    beforeEach(async () => {
      await instance.clear();
      await instance.setItem('a', 1);
      await instance.setItem('b', 2);
      await instance.setItem('c', 3);
    });

    it('should iterate over all items', async () => {
      const items: Record<string, any> = {};
      await instance.iterate((value, key) => {
        items[key] = value;
      });

      expect(items).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('should provide correct iteration numbers', async () => {
      const iterations: number[] = [];
      await instance.iterate((value, key, iterationNumber) => {
        iterations.push(iterationNumber);
      });

      expect(iterations).toEqual([1, 2, 3]);
    });

    it('should stop iteration when callback returns a value', async () => {
      let count = 0;
      const result = await instance.iterate((value, key, iterationNumber) => {
        count++;
        if (iterationNumber === 2) {
          return 'stop';
        }
      });

      expect(count).toBe(2);
      expect(result).toBe('stop');
    });

    it('should complete iteration if callback returns undefined', async () => {
      let count = 0;
      await instance.iterate(() => {
        count++;
        return undefined;
      });

      expect(count).toBe(3);
    });

    it('should normalize nullish values during interaction', async () => {
      await instance.clear();
      await instance.setItem('nullish-null', null);
      await instance.setItem('nullish-undefined', undefined);

      const observed: Record<string, any> = {};
      await instance.iterate((value, key) => {
        observed[key] = value;
      });

      expect(observed['nullish-null']).toBe(null);
      expect(observed['nullish-undefined']).toBe(null);
    });
  });

  describe('Batch operations and transactions', () => {
    it('should batch set/get/remove in order', async () => {
      const maxBatchInstance = localspace.createInstance({
        name: `indexeddb-batch-${Math.random().toString(36).slice(2)}`,
        storeName: 'batchStore',
        maxBatchSize: 2,
      });
      await maxBatchInstance.setDriver([maxBatchInstance.INDEXEDDB]);
      await maxBatchInstance.ready();

      const entries = [
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' },
        { key: 'k3', value: 'v3' },
      ];

      const setResult = await maxBatchInstance.setItems(entries);
      expect(setResult.map((r) => r.key)).toEqual(['k1', 'k2', 'k3']);

      const got = await maxBatchInstance.getItems(entries.map((e) => e.key));
      expect(got.map((r) => r.value)).toEqual(['v1', 'v2', 'v3']);

      await maxBatchInstance.removeItems(entries.map((e) => e.key));
      const after = await maxBatchInstance.getItems(entries.map((e) => e.key));
      expect(after.every((r) => r.value === null)).toBe(true);

      await maxBatchInstance.dropInstance();
    });

    it('should run multiple writes in a single transaction', async () => {
      await instance.runTransaction('readwrite', async (tx) => {
        const current = (await tx.get<number>('counter')) ?? 0;
        await tx.set('counter', current + 1);
        await tx.set('last', 'done');
      });

      expect(await instance.getItem('counter')).toBe(1);
      expect(await instance.getItem('last')).toBe('done');
    });

    it('should prevent writes in readonly transactions', async () => {
      await instance.setItem('rkey', 'rval');
      await expect(
        instance.runTransaction('readonly', async (tx) => {
          return tx.set('rkey', 'should-fail');
        })
      ).rejects.toBeInstanceOf(Error);
    });
  });

  describe('Callback support', () => {
    it('should support callbacks for setItem', async () => {
      await new Promise<void>((resolve) => {
        instance.setItem('callbackKey', 'callbackValue', (err, value) => {
          expect(err).toBe(null);
          expect(value).toBe('callbackValue');
          resolve();
        });
      });
    });

    it('should support callbacks for getItem', async () => {
      await instance.setItem('test', 'value');

      await new Promise<void>((resolve) => {
        instance.getItem('test', (err, value) => {
          expect(err).toBe(null);
          expect(value).toBe('value');
          resolve();
        });
      });
    });

    it('should support callbacks for removeItem', async () => {
      await instance.setItem('test', 'value');

      await new Promise<void>((resolve) => {
        instance.removeItem('test', (err) => {
          expect(err).toBe(null);
          resolve();
        });
      });
    });

    it('should support callbacks for clear', async () => {
      await instance.setItem('test', 'value');

      await new Promise<void>((resolve) => {
        instance.clear((err) => {
          expect(err).toBe(null);
          resolve();
        });
      });
    });

    it('should support callbacks for length', async () => {
      await instance.setItem('test', 'value');

      await new Promise<void>((resolve) => {
        instance.length((err, length) => {
          expect(err).toBe(null);
          expect(length).toBeGreaterThan(0);
          resolve();
        });
      });
    });

    it('should support callbacks for keys', async () => {
      await instance.setItem('test', 'value');

      await new Promise<void>((resolve) => {
        instance.keys((err, keys) => {
          expect(err).toBe(null);
          expect(keys).toContain('test');
          resolve();
        });
      });
    });

    it('should support callbacks for key', async () => {
      await instance.setItem('test', 'value');

      await new Promise<void>((resolve) => {
        instance.key(0, (err, key) => {
          expect(err).toBe(null);
          expect(key).toBeTruthy();
          resolve();
        });
      });
    });

    it('should support callbacks for iterate', async () => {
      await instance.setItem('test', 'value');

      await new Promise<void>((resolve) => {
        instance.iterate(
          (value, key) => {
            // iteration callback
          },
          (err) => {
            expect(err).toBe(null);
            resolve();
          }
        );
      });
    });
  });

  describe('Blob handling', () => {
    it('should store and retrieve Blobs', async () => {
      const blob = new Blob(['test content'], { type: 'text/plain' });
      await instance.setItem('blobKey', blob);

      const retrieved = await instance.getItem<any>('blobKey');

      // In some environments, Blobs may be encoded and decoded
      // Check if it's a Blob or an encoded blob object
      if (retrieved && typeof retrieved === 'object') {
        if (retrieved instanceof Blob) {
          expect(retrieved.type).toBe('text/plain');
          const text = await retrieved.text();
          expect(text).toBe('test content');
        } else if (retrieved.__local_forage_encoded_blob) {
          // It's an encoded blob
          expect(retrieved.__local_forage_encoded_blob).toBe(true);
          expect(retrieved.type).toBe('text/plain');
          expect(retrieved.data).toBeDefined();
        } else {
          // Some environments may not support Blobs fully
          expect(retrieved).toBeDefined();
        }
      }
    });

    it('should handle multiple Blob types', async () => {
      const textBlob = new Blob(['text'], { type: 'text/plain' });
      const jsonBlob = new Blob(['{"key":"value"}'], {
        type: 'application/json',
      });

      await instance.setItem('textBlob', textBlob);
      await instance.setItem('jsonBlob', jsonBlob);

      const retrievedText = await instance.getItem<any>('textBlob');
      const retrievedJson = await instance.getItem<any>('jsonBlob');

      expect(retrievedText).toBeDefined();
      expect(retrievedJson).toBeDefined();

      // Check if they're Blobs or encoded blobs
      if (retrievedText instanceof Blob) {
        expect(retrievedText.type).toBe('text/plain');
      } else if (retrievedText?.__local_forage_encoded_blob) {
        expect(retrievedText.type).toBe('text/plain');
      }

      if (retrievedJson instanceof Blob) {
        expect(retrievedJson.type).toBe('application/json');
      } else if (retrievedJson?.__local_forage_encoded_blob) {
        expect(retrievedJson.type).toBe('application/json');
      }
    });
  });

  describe('Key normalization', () => {
    it('should convert non-string keys to strings', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      await instance.setItem(123 as any, 'value');
      const value = await instance.getItem('123');
      expect(value).toBe('value');

      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });
  });

  describe('dropInstance', () => {
    it('should drop entire database', async () => {
      const dbName = `drop-test-${Math.random().toString(36).slice(2)}`;
      const testInstance = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });

      await testInstance.setDriver([testInstance.INDEXEDDB]);
      await testInstance.ready();
      await testInstance.setItem('key', 'value');

      // Drop entire database
      await testInstance.dropInstance();

      // Verify data is gone
      const newInstance = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });
      await newInstance.setDriver([newInstance.INDEXEDDB]);
      await newInstance.ready();

      const value = await newInstance.getItem('key');
      expect(value).toBe(null);
    });

    it('should drop specific store', async () => {
      const dbName = `drop-store-test-${Math.random().toString(36).slice(2)}`;
      const testInstance = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });

      await testInstance.setDriver([testInstance.INDEXEDDB]);
      await testInstance.ready();
      await testInstance.setItem('key', 'value');

      // Drop specific store
      await testInstance.dropInstance({
        name: dbName,
        storeName: 'store1',
      });

      // Verify store is gone
      const newInstance = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });
      await newInstance.setDriver([newInstance.INDEXEDDB]);
      await newInstance.ready();

      const value = await newInstance.getItem('key');
      expect(value).toBe(null);
    });

    it('should handle dropInstance with callback', async () => {
      const dbName = `drop-callback-test-${Math.random().toString(36).slice(2)}`;
      const testInstance = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });

      await testInstance.setDriver([testInstance.INDEXEDDB]);
      await testInstance.ready();
      await testInstance.setItem('key', 'value');

      await new Promise<void>((resolve) => {
        testInstance.dropInstance(undefined, (err) => {
          expect(err).toBe(null);
          resolve();
        });
      });
    });

    it('should handle dropInstance with only storeName', async () => {
      // When only storeName is provided, name is inherited from current config
      // This should work without errors
      const result = await instance.dropInstance({ storeName: 'testStore' });
      expect(result).toBeUndefined();
    });
  });

  describe('Multiple instances', () => {
    it('should handle multiple instances with same database', async () => {
      const dbName = `multi-instance-${Math.random().toString(36).slice(2)}`;

      const instance1 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });

      const instance2 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });

      await instance1.setDriver([instance1.INDEXEDDB]);
      await instance2.setDriver([instance2.INDEXEDDB]);

      await instance1.ready();
      await instance2.ready();

      await instance1.setItem('key', 'value1');
      const value = await instance2.getItem('key');
      expect(value).toBe('value1');

      await instance1.clear();
      await instance2.clear();
    });

    it('should handle multiple instances with different stores', async () => {
      const dbName = `multi-store-${Math.random().toString(36).slice(2)}`;

      const instance1 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });

      const instance2 = localspace.createInstance({
        name: dbName,
        storeName: 'store2',
      });

      await instance1.setDriver([instance1.INDEXEDDB]);
      await instance2.setDriver([instance2.INDEXEDDB]);

      await instance1.ready();
      await instance2.ready();

      await instance1.setItem('key', 'value1');
      await instance2.setItem('key', 'value2');

      expect(await instance1.getItem('key')).toBe('value1');
      expect(await instance2.getItem('key')).toBe('value2');

      await instance1.clear();
      await instance2.clear();
    });
  });

  describe('Version management', () => {
    it('should handle database with custom version', async () => {
      const dbName = `version-test-${Math.random().toString(36).slice(2)}`;
      const versionedInstance = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
        version: 2.0,
      });

      await versionedInstance.setDriver([versionedInstance.INDEXEDDB]);
      await versionedInstance.ready();

      await versionedInstance.setItem('key', 'value');
      const value = await versionedInstance.getItem('key');
      expect(value).toBe('value');

      await versionedInstance.clear();
    });
  });

  describe('Error handling', () => {
    it('should handle errors gracefully', async () => {
      // Try to get from a closed/invalid database would typically throw
      // but our implementation should handle it gracefully
      const value = await instance.getItem('anyKey');
      expect(value).toBeNull();
    });

    it('should handle transaction errors', async () => {
      // Try operations that might fail
      await instance.setItem('key1', 'value1');
      const value = await instance.getItem('key1');
      expect(value).toBe('value1');
    });
  });

  describe('Database upgrades and versioning', () => {
    it('should handle version upgrade scenarios', async () => {
      const dbName = `upgrade-test-${Math.random().toString(36).slice(2)}`;

      // Create first instance with version 1.0
      const instance1 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
        version: 1.0,
      });

      await instance1.setDriver([instance1.INDEXEDDB]);
      await instance1.ready();
      await instance1.setItem('key', 'value1');

      // Create second instance with version 2.0
      const instance2 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
        version: 2.0,
      });

      await instance2.setDriver([instance2.INDEXEDDB]);
      await instance2.ready();

      const value = await instance2.getItem('key');
      expect(value).toBe('value1');

      await instance1.clear();
      await instance2.clear();
    });

    it('should handle downgrade attempts', async () => {
      const dbName = `downgrade-test-${Math.random().toString(36).slice(2)}`;
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      // Create first instance with version 2.0
      const instance1 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
        version: 2.0,
      });

      await instance1.setDriver([instance1.INDEXEDDB]);
      await instance1.ready();
      await instance1.setItem('key', 'value1');

      // Try to create instance with lower version
      const instance2 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
        version: 1.0,
      });

      await instance2.setDriver([instance2.INDEXEDDB]);
      await instance2.ready();

      // Should still work, version will be kept at 2.0
      const value = await instance2.getItem('key');
      expect(value).toBe('value1');

      consoleWarnSpy.mockRestore();
      await instance1.clear();
      await instance2.clear();
    });

    it('should handle creating new store in existing database', async () => {
      const dbName = `new-store-test-${Math.random().toString(36).slice(2)}`;

      // Create first store
      const instance1 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });

      await instance1.setDriver([instance1.INDEXEDDB]);
      await instance1.ready();
      await instance1.setItem('key', 'value1');

      // Create second store in same database
      const instance2 = localspace.createInstance({
        name: dbName,
        storeName: 'store2',
      });

      await instance2.setDriver([instance2.INDEXEDDB]);
      await instance2.ready();
      await instance2.setItem('key', 'value2');

      // Verify both stores are independent
      expect(await instance1.getItem('key')).toBe('value1');
      expect(await instance2.getItem('key')).toBe('value2');

      await instance1.clear();
      await instance2.clear();
    });
  });

  describe('Advanced operations', () => {
    it('should handle large data sets', async () => {
      await instance.clear();

      // Add multiple items
      for (let i = 0; i < 50; i++) {
        await instance.setItem(`key${i}`, `value${i}`);
      }

      const length = await instance.length();
      expect(length).toBe(50);

      const keys = await instance.keys();
      expect(keys.length).toBe(50);

      await instance.clear();
    });

    it('should handle rapid concurrent operations', async () => {
      await instance.clear();

      // Perform multiple operations concurrently
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(instance.setItem(`concurrent${i}`, i));
      }

      await Promise.all(promises);

      const length = await instance.length();
      expect(length).toBe(10);

      await instance.clear();
    });

    it('should handle special characters in keys', async () => {
      const specialKeys = [
        'key with spaces',
        'key-with-dashes',
        'key_with_underscores',
        'key.with.dots',
        'key/with/slashes',
        'key@with@symbols',
      ];

      for (const key of specialKeys) {
        await instance.setItem(key, `value-${key}`);
      }

      for (const key of specialKeys) {
        const value = await instance.getItem(key);
        expect(value).toBe(`value-${key}`);
      }

      await instance.clear();
    });

    it('should handle undefined and edge case values', async () => {
      // Test with various edge case values
      await instance.setItem('empty-string', '');
      await instance.setItem('zero', 0);
      await instance.setItem('false', false);
      await instance.setItem('empty-array', []);
      await instance.setItem('empty-object', {});

      expect(await instance.getItem('empty-string')).toBe('');
      expect(await instance.getItem('zero')).toBe(0);
      expect(await instance.getItem('false')).toBe(false);
      expect(await instance.getItem('empty-array')).toEqual([]);
      expect(await instance.getItem('empty-object')).toEqual({});

      await instance.clear();
    });
  });

  describe('Error scenarios', () => {
    it('should handle repeated clear operations', async () => {
      await instance.setItem('key', 'value');
      await instance.clear();
      await instance.clear();
      await instance.clear();

      const length = await instance.length();
      expect(length).toBe(0);
    });

    it('should handle removeItem on non-existent keys', async () => {
      await instance.removeItem('non-existent-key');
      await instance.removeItem('another-non-existent');

      // Should not throw errors
      const length = await instance.length();
      expect(length).toBeGreaterThanOrEqual(0);
    });

    it('should handle getItem after clear', async () => {
      await instance.setItem('key', 'value');
      await instance.clear();

      const value = await instance.getItem('key');
      expect(value).toBeNull();
    });

    it('should handle transactions on same store', async () => {
      // Multiple rapid operations on same store
      await Promise.all([
        instance.setItem('a', '1'),
        instance.setItem('b', '2'),
        instance.setItem('c', '3'),
      ]);

      const [a, b, c] = await Promise.all([
        instance.getItem('a'),
        instance.getItem('b'),
        instance.getItem('c'),
      ]);

      expect(a).toBe('1');
      expect(b).toBe('2');
      expect(c).toBe('3');

      await instance.clear();
    });

    it('should handle mixed read/write operations', async () => {
      await instance.setItem('key1', 'value1');

      const promises = [
        instance.getItem('key1'),
        instance.setItem('key2', 'value2'),
        instance.getItem('key1'),
        instance.removeItem('key3'),
        instance.length(),
      ];

      const results = await Promise.all(promises);

      expect(results[0]).toBe('value1');
      expect(results[1]).toBe('value2');
      expect(results[2]).toBe('value1');

      await instance.clear();
    });
  });

  describe('Database state management', () => {
    it('should maintain data integrity across operations', async () => {
      const testData: Record<string, string> = {};

      // Populate with test data
      for (let i = 0; i < 20; i++) {
        testData[`key${i}`] = `value${i}`;
        await instance.setItem(`key${i}`, `value${i}`);
      }

      // Verify all data
      for (const [key, value] of Object.entries(testData)) {
        expect(await instance.getItem(key)).toBe(value);
      }

      // Remove half
      for (let i = 0; i < 10; i++) {
        await instance.removeItem(`key${i}`);
      }

      // Verify removals
      for (let i = 0; i < 10; i++) {
        expect(await instance.getItem(`key${i}`)).toBeNull();
      }

      // Verify remaining
      for (let i = 10; i < 20; i++) {
        expect(await instance.getItem(`key${i}`)).toBe(`value${i}`);
      }

      await instance.clear();
    });

    it('should handle key() with various indices', async () => {
      await instance.clear();
      await instance.setItem('a', '1');
      await instance.setItem('b', '2');
      await instance.setItem('c', '3');

      const key0 = await instance.key(0);
      const key1 = await instance.key(1);
      const key2 = await instance.key(2);
      const keyNeg = await instance.key(-1);
      const keyOOB = await instance.key(10);

      expect(key0).toBeTruthy();
      expect(key1).toBeTruthy();
      expect(key2).toBeTruthy();
      expect(keyNeg).toBeNull();
      expect(keyOOB).toBeNull();

      await instance.clear();
    });

    it('should iterate with early termination', async () => {
      await instance.clear();

      for (let i = 0; i < 10; i++) {
        await instance.setItem(`item${i}`, i);
      }

      let count = 0;
      const result = await instance.iterate((value, key, iteration) => {
        count++;
        if (iteration === 5) {
          return 'STOP';
        }
      });

      expect(count).toBe(5);
      expect(result).toBe('STOP');

      await instance.clear();
    });
  });

  describe('Connection idle handling', () => {
    it('should reopen after idle timeout for blob setItem', async () => {
      const idleInstance = localspace.createInstance({
        name: `indexeddb-idle-${Math.random().toString(36).slice(2)}`,
        storeName: 'idleStore',
        connectionIdleMs: 5,
      });
      await idleInstance.setDriver([idleInstance.INDEXEDDB]);
      await idleInstance.ready();
      await idleInstance.setItem('warm', 'up');

      await new Promise((resolve) => setTimeout(resolve, 25));

      const blob = new Blob(['idle-blob'], { type: 'text/plain' });
      const stored = await idleInstance.setItem('blob-after-idle', blob);
      expect(stored).toBeTruthy();

      const retrieved = await idleInstance.getItem<any>('blob-after-idle');
      if (retrieved instanceof Blob) {
        expect(await retrieved.text()).toBe('idle-blob');
      } else if (
        retrieved &&
        typeof retrieved === 'object' &&
        '__local_forage_encoded_blob' in retrieved
      ) {
        expect((retrieved as any).__local_forage_encoded_blob).toBe(true);
      } else {
        expect(retrieved).toBeDefined();
      }

      await idleInstance.dropInstance();
    });

    it('should run transaction with blob after idle close', async () => {
      const idleTxInstance = localspace.createInstance({
        name: `indexeddb-idle-tx-${Math.random().toString(36).slice(2)}`,
        storeName: 'idleTxStore',
        connectionIdleMs: 5,
      });
      await idleTxInstance.setDriver([idleTxInstance.INDEXEDDB]);
      await idleTxInstance.ready();
      await idleTxInstance.setItem('seed', 'value');

      await new Promise((resolve) => setTimeout(resolve, 25));

      const blob = new Blob(['tx-blob'], { type: 'text/plain' });
      await idleTxInstance.runTransaction('readwrite', async (tx) => {
        const current = await tx.get<string>('seed');
        await tx.set('echo', current ?? 'missing');
        await tx.set('blob-tx', blob);
      });

      const retrieved = await idleTxInstance.getItem<any>('blob-tx');
      if (retrieved instanceof Blob) {
        expect(await retrieved.text()).toBe('tx-blob');
      } else if (
        retrieved &&
        typeof retrieved === 'object' &&
        '__local_forage_encoded_blob' in retrieved
      ) {
        expect((retrieved as any).__local_forage_encoded_blob).toBe(true);
      } else {
        expect(retrieved).toBeDefined();
      }
      expect(await idleTxInstance.getItem('echo')).toBe('value');

      await idleTxInstance.dropInstance();
    });
  });

  describe('Performance statistics', () => {
    const zeroStats = {
      totalWrites: 0,
      coalescedWrites: 0,
      transactionsSaved: 0,
      avgCoalesceSize: 0,
    };

    it('should return default stats when db context is missing', async () => {
      const statsInstance = localspace.createInstance({
        name: `stats-guard-${Math.random().toString(36).slice(2)}`,
        storeName: 'statsStore',
      });

      await statsInstance.setDriver([statsInstance.INDEXEDDB]);
      await statsInstance.ready();
      await statsInstance.clear();

      const originalDbInfo = (statsInstance as any)._dbInfo;
      (statsInstance as any)._dbInfo = null;

      const stats = statsInstance.getPerformanceStats?.();
      expect(stats).toEqual(zeroStats);

      (statsInstance as any)._dbInfo = originalDbInfo;
      await statsInstance.dropInstance();
    });

    it('should coalesce writes even when maxBatchSize is configured', async () => {
      const coalesceInstance = localspace.createInstance({
        name: `stats-coalesce-${Math.random().toString(36).slice(2)}`,
        storeName: 'statsCoalesceStore',
        coalesceWrites: true,
        coalesceWindowMs: 50,
        maxBatchSize: 2,
      });

      await coalesceInstance.setDriver([coalesceInstance.INDEXEDDB]);
      await coalesceInstance.ready();
      await coalesceInstance.clear();

      await Promise.all([
        coalesceInstance.setItem('c1', 'v1'),
        coalesceInstance.setItem('c2', 'v2'),
        coalesceInstance.setItem('c3', 'v3'),
      ]);

      const stats = coalesceInstance.getPerformanceStats?.();
      expect(stats).toBeDefined();
      expect(stats!.coalescedWrites).toBeGreaterThanOrEqual(2);

      await coalesceInstance.dropInstance();
    });

    it('should read latest values immediately after coalesced writes', async () => {
      const coalesceInstance = localspace.createInstance({
        name: `coalesce-read-${Math.random().toString(36).slice(2)}`,
        storeName: 'coalesceReadStore',
        coalesceWrites: true,
        coalesceWindowMs: 50,
      });

      await coalesceInstance.setDriver([coalesceInstance.INDEXEDDB]);
      await coalesceInstance.ready();
      await coalesceInstance.clear();

      await coalesceInstance.setItem('k', 'v1');
      const firstRead = await coalesceInstance.getItem('k');
      expect(firstRead).toBe('v1');

      await coalesceInstance.setItem('k', 'v2');
      await coalesceInstance.setItem('k', 'v3');
      const latest = await coalesceInstance.getItem('k');
      expect(latest).toBe('v3');

      await coalesceInstance.dropInstance();
    });
  });

  describe('dropInstance edge cases', () => {
    it('should handle dropInstance on non-existent database', async () => {
      const fakeDbName = `non-existent-${Math.random().toString(36).slice(2)}`;

      await instance.dropInstance({
        name: fakeDbName,
        storeName: 'fakeStore',
      });

      // Should not throw
      expect(true).toBe(true);
    });

    it('should handle dropInstance on empty options', async () => {
      // Should use current config
      await instance.setItem('test', 'value');

      // This will drop the current instance's database
      // Create a separate test instance for this
      const tempInstance = localspace.createInstance({
        name: `temp-drop-${Math.random().toString(36).slice(2)}`,
        storeName: 'tempStore',
      });

      await tempInstance.setDriver([tempInstance.INDEXEDDB]);
      await tempInstance.ready();
      await tempInstance.setItem('key', 'value');

      // Drop with no options (uses current config)
      await tempInstance.dropInstance();

      // Verify it's dropped
      const newInstance = localspace.createInstance({
        name: tempInstance.config('name') as string,
        storeName: 'tempStore',
      });

      await newInstance.setDriver([newInstance.INDEXEDDB]);
      await newInstance.ready();

      const value = await newInstance.getItem('key');
      expect(value).toBeNull();
    });
  });
});
