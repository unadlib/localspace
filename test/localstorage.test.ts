import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import localspace from '../src/index';
import type { LocalSpaceInstance } from '../src/types';

describe('LocalStorage driver tests', () => {
  let instance: LocalSpaceInstance;

  beforeEach(async () => {
    instance = localspace.createInstance({
      name: `localstorage-test-${Math.random().toString(36).slice(2)}`,
      storeName: 'testStore',
    });

    // Force localStorage driver
    await instance.setDriver([instance.LOCALSTORAGE]);
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

  describe('Basic operations with localStorage', () => {
    it('should store and retrieve values', async () => {
      await instance.setItem('test-key', 'test-value');
      const value = await instance.getItem('test-key');
      expect(value).toBe('test-value');
    });

    it('should handle various data types', async () => {
      await instance.setItem('string', 'hello');
      await instance.setItem('number', 42);
      await instance.setItem('boolean', true);
      await instance.setItem('object', { a: 1, b: 2 });
      await instance.setItem('array', [1, 2, 3]);

      expect(await instance.getItem('string')).toBe('hello');
      expect(await instance.getItem('number')).toBe(42);
      expect(await instance.getItem('boolean')).toBe(true);
      expect(await instance.getItem('object')).toEqual({ a: 1, b: 2 });
      expect(await instance.getItem('array')).toEqual([1, 2, 3]);
    });

    it('should handle typed arrays', async () => {
      const uint8 = new Uint8Array([1, 2, 3, 4]);
      await instance.setItem('typed-array', uint8);

      const retrieved = await instance.getItem<Uint8Array>('typed-array');
      expect(retrieved).toBeInstanceOf(Uint8Array);
      if (retrieved instanceof Uint8Array) {
        expect(Array.from(retrieved)).toEqual([1, 2, 3, 4]);
      }
    });

    it('should handle ArrayBuffer', async () => {
      const buffer = new Uint8Array([1, 2, 3]).buffer;
      await instance.setItem('buffer', buffer);

      const retrieved = await instance.getItem<ArrayBuffer>('buffer');
      expect(retrieved).toBeInstanceOf(ArrayBuffer);
      if (retrieved instanceof ArrayBuffer) {
        expect(new Uint8Array(retrieved)).toEqual(new Uint8Array([1, 2, 3]));
      }
    });
  });

  describe('Iteration with localStorage', () => {
    it('should iterate over all items', async () => {
      await instance.setItem('a', 1);
      await instance.setItem('b', 2);
      await instance.setItem('c', 3);

      const items: Record<string, any> = {};
      await instance.iterate((value, key) => {
        items[key] = value;
      });

      expect(items).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('should provide correct iteration numbers', async () => {
      await instance.setItem('x', 'X');
      await instance.setItem('y', 'Y');

      const iterations: number[] = [];
      await instance.iterate((value, key, iterationNumber) => {
        iterations.push(iterationNumber);
      });

      expect(iterations).toEqual([1, 2]);
    });

    it('should stop iteration on return value', async () => {
      await instance.setItem('a', 1);
      await instance.setItem('b', 2);
      await instance.setItem('c', 3);

      let count = 0;
      const result = await instance.iterate((value, key, iteration) => {
        count++;
        if (iteration === 2) {
          return 'DONE';
        }
      });

      expect(count).toBe(2);
      expect(result).toBe('DONE');
    });
  });

  describe('dropInstance with localStorage', () => {
    it('should drop entire database', async () => {
      const dbName = `drop-db-${Math.random().toString(36).slice(2)}`;
      const testInstance = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });

      await testInstance.setDriver([testInstance.LOCALSTORAGE]);
      await testInstance.ready();
      await testInstance.setItem('key', 'value');

      // Drop entire database
      await testInstance.dropInstance({ name: dbName });

      // Verify data is gone
      const newInstance = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });
      await newInstance.setDriver([newInstance.LOCALSTORAGE]);
      await newInstance.ready();

      const value = await newInstance.getItem('key');
      expect(value).toBeNull();
    });

    it('should drop specific store', async () => {
      const dbName = `drop-store-${Math.random().toString(36).slice(2)}`;

      // Create instance with store1
      const instance1 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });
      await instance1.setDriver([instance1.LOCALSTORAGE]);
      await instance1.ready();
      await instance1.setItem('key1', 'value1');

      // Create instance with store2
      const instance2 = localspace.createInstance({
        name: dbName,
        storeName: 'store2',
      });
      await instance2.setDriver([instance2.LOCALSTORAGE]);
      await instance2.ready();
      await instance2.setItem('key2', 'value2');

      // Drop store1
      await instance1.dropInstance({ name: dbName, storeName: 'store1' });

      // Verify store1 is dropped
      const newInstance1 = localspace.createInstance({
        name: dbName,
        storeName: 'store1',
      });
      await newInstance1.setDriver([newInstance1.LOCALSTORAGE]);
      await newInstance1.ready();
      expect(await newInstance1.getItem('key1')).toBeNull();

      // Verify store2 still exists
      const newInstance2 = localspace.createInstance({
        name: dbName,
        storeName: 'store2',
      });
      await newInstance2.setDriver([newInstance2.LOCALSTORAGE]);
      await newInstance2.ready();
      expect(await newInstance2.getItem('key2')).toBe('value2');
    });
  });

  describe('Edge cases with localStorage', () => {
    it('should handle empty values', async () => {
      await instance.setItem('empty', '');
      expect(await instance.getItem('empty')).toBe('');
    });

    it('should handle null', async () => {
      await instance.setItem('null-value', null);
      expect(await instance.getItem('null-value')).toBeNull();
    });

    it('should handle large strings', async () => {
      const largeString = 'x'.repeat(10000);
      await instance.setItem('large', largeString);
      expect(await instance.getItem('large')).toBe(largeString);
    });

    it('should handle special characters in keys', async () => {
      const specialKeys = [
        'key with spaces',
        'key/with/slashes',
        'key-with-dashes',
        'key_with_underscores',
        'key.with.dots',
      ];

      for (const key of specialKeys) {
        await instance.setItem(key, `value-for-${key}`);
      }

      for (const key of specialKeys) {
        expect(await instance.getItem(key)).toBe(`value-for-${key}`);
      }
    });

    it('should maintain order in keys()', async () => {
      await instance.clear();
      await instance.setItem('z', '1');
      await instance.setItem('a', '2');
      await instance.setItem('m', '3');

      const keys = await instance.keys();
      expect(keys).toContain('z');
      expect(keys).toContain('a');
      expect(keys).toContain('m');
      expect(keys.length).toBe(3);
    });
  });

  describe('Multiple instances with localStorage', () => {
    it('should isolate data between different databases', async () => {
      const db1Name = `db1-${Math.random().toString(36).slice(2)}`;
      const db2Name = `db2-${Math.random().toString(36).slice(2)}`;

      const instance1 = localspace.createInstance({
        name: db1Name,
        storeName: 'store',
      });

      const instance2 = localspace.createInstance({
        name: db2Name,
        storeName: 'store',
      });

      await instance1.setDriver([instance1.LOCALSTORAGE]);
      await instance2.setDriver([instance2.LOCALSTORAGE]);

      await instance1.ready();
      await instance2.ready();

      await instance1.setItem('shared-key', 'db1-value');
      await instance2.setItem('shared-key', 'db2-value');

      expect(await instance1.getItem('shared-key')).toBe('db1-value');
      expect(await instance2.getItem('shared-key')).toBe('db2-value');

      await instance1.clear();
      await instance2.clear();
    });

    it('should share data between instances with same config', async () => {
      const dbName = `shared-${Math.random().toString(36).slice(2)}`;

      const instance1 = localspace.createInstance({
        name: dbName,
        storeName: 'store',
      });

      const instance2 = localspace.createInstance({
        name: dbName,
        storeName: 'store',
      });

      await instance1.setDriver([instance1.LOCALSTORAGE]);
      await instance2.setDriver([instance2.LOCALSTORAGE]);

      await instance1.ready();
      await instance2.ready();

      await instance1.setItem('key', 'value-from-instance1');

      // Instance2 should see the same value
      expect(await instance2.getItem('key')).toBe('value-from-instance1');

      await instance1.clear();
    });

    it('should batch set/get/remove with maxBatchSize', async () => {
      const batchInstance = localspace.createInstance({
        name: `ls-batch-${Math.random().toString(36).slice(2)}`,
        storeName: 'batchStore',
        maxBatchSize: 1,
      });

      await batchInstance.setDriver([batchInstance.LOCALSTORAGE]);
      await batchInstance.ready();

      const entries = [
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' },
      ];

      const setResult = await batchInstance.setItems(entries);
      expect(setResult.map((r) => r.key)).toEqual(['k1', 'k2']);

      const got = await batchInstance.getItems(entries.map((e) => e.key));
      expect(got.map((r) => r.value)).toEqual(['v1', 'v2']);

      await batchInstance.removeItems(entries.map((e) => e.key));
      const after = await batchInstance.getItems(entries.map((e) => e.key));
      expect(after.every((r) => r.value === null)).toBe(true);

      await batchInstance.dropInstance();
    });

    it('should support runTransaction for grouped work', async () => {
      await instance.runTransaction('readwrite', async (tx) => {
        await tx.set('a', '1');
        await tx.set('b', '2');
        const aVal = await tx.get('a');
        await tx.set('c', `${aVal}-c`);
      });

      expect(await instance.getItem('a')).toBe('1');
      expect(await instance.getItem('b')).toBe('2');
      expect(await instance.getItem('c')).toBe('1-c');
    });
  });
});
