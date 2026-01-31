import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import localspace, { LocalSpace, ttlPlugin, quotaPlugin } from '../src/index';
import type { LocalSpaceInstance } from '../src/types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Edge cases and concurrency tests', () => {
  describe('Concurrent write operations', () => {
    let instance: LocalSpaceInstance;

    beforeEach(async () => {
      instance = localspace.createInstance({
        name: `concurrent-test-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
      });
      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.clear();
    });

    afterEach(async () => {
      try {
        await instance.clear();
        await instance.dropInstance();
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should handle concurrent writes to the same key', async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        instance.setItem('sameKey', `value-${i}`)
      );

      await Promise.all(writes);

      const value = await instance.getItem('sameKey');
      // The final value should be one of the written values
      expect(value).toMatch(/^value-\d$/);
    });

    it('should handle concurrent writes to different keys', async () => {
      const writes = Array.from({ length: 50 }, (_, i) =>
        instance.setItem(`key-${i}`, `value-${i}`)
      );

      await Promise.all(writes);

      // Verify all keys were written
      const keys = await instance.keys();
      expect(keys.length).toBe(50);

      // Verify values are correct
      for (let i = 0; i < 50; i++) {
        const value = await instance.getItem(`key-${i}`);
        expect(value).toBe(`value-${i}`);
      }
    });

    it('should handle concurrent read and write operations', async () => {
      await instance.setItem('readWriteKey', 'initial');

      const operations = [
        instance.getItem('readWriteKey'),
        instance.setItem('readWriteKey', 'updated1'),
        instance.getItem('readWriteKey'),
        instance.setItem('readWriteKey', 'updated2'),
        instance.getItem('readWriteKey'),
      ];

      const results = await Promise.all(operations);

      // All operations should complete without error
      expect(results).toHaveLength(5);

      // Final value should be 'updated2'
      const finalValue = await instance.getItem('readWriteKey');
      expect(finalValue).toBe('updated2');
    });

    it('should handle concurrent setItems batch operations', async () => {
      const batch1 = Array.from({ length: 20 }, (_, i) => ({
        key: `batch1-key-${i}`,
        value: `batch1-value-${i}`,
      }));

      const batch2 = Array.from({ length: 20 }, (_, i) => ({
        key: `batch2-key-${i}`,
        value: `batch2-value-${i}`,
      }));

      await Promise.all([
        instance.setItems(batch1),
        instance.setItems(batch2),
      ]);

      const keys = await instance.keys();
      expect(keys.length).toBe(40);
    });

    it('should handle concurrent remove operations', async () => {
      // Setup: create 20 keys
      for (let i = 0; i < 20; i++) {
        await instance.setItem(`remove-key-${i}`, `value-${i}`);
      }

      // Concurrent removes
      const removes = Array.from({ length: 20 }, (_, i) =>
        instance.removeItem(`remove-key-${i}`)
      );

      await Promise.all(removes);

      const keys = await instance.keys();
      expect(keys.length).toBe(0);
    });

    it('should handle rapid successive writes (race condition test)', async () => {
      const iterations = 100;
      const results: Promise<number>[] = [];

      for (let i = 0; i < iterations; i++) {
        results.push(instance.setItem('counter', i));
      }

      await Promise.all(results);

      const finalValue = await instance.getItem<number>('counter');
      // Final value should be a valid number from 0 to iterations-1
      expect(finalValue).toBeGreaterThanOrEqual(0);
      expect(finalValue).toBeLessThan(iterations);
    });
  });

  describe('Write coalescing edge cases', () => {
    let instance: LocalSpaceInstance;

    beforeEach(async () => {
      instance = localspace.createInstance({
        name: `coalesce-test-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
        coalesceWrites: true,
        coalesceWindowMs: 10,
        coalesceMaxBatchSize: 5,
      });
      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.clear();
    });

    afterEach(async () => {
      try {
        await instance.clear();
        await instance.dropInstance();
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should coalesce rapid writes within the window', async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        instance.setItem(`coalesce-key-${i}`, `value-${i}`)
      );

      await Promise.all(writes);

      // All values should be written correctly
      for (let i = 0; i < 10; i++) {
        const value = await instance.getItem(`coalesce-key-${i}`);
        expect(value).toBe(`value-${i}`);
      }
    });

    it('should handle overwrites to the same key during coalesce window', async () => {
      const writes = [
        instance.setItem('overwrite-key', 'first'),
        instance.setItem('overwrite-key', 'second'),
        instance.setItem('overwrite-key', 'third'),
      ];

      await Promise.all(writes);

      // The final value should be 'third'
      const value = await instance.getItem('overwrite-key');
      expect(value).toBe('third');
    });

    it('should flush when maxBatchSize is exceeded', async () => {
      // coalesceMaxBatchSize is 5, so writing 10 items should trigger flush
      const writes = Array.from({ length: 10 }, (_, i) =>
        instance.setItem(`batch-key-${i}`, `value-${i}`)
      );

      await Promise.all(writes);

      const keys = await instance.keys();
      expect(keys.length).toBe(10);
    });

    it('should handle mixed set and remove operations', async () => {
      await instance.setItem('mixed-key', 'initial');

      // Rapid set and remove
      const ops = [
        instance.setItem('mixed-key', 'updated1'),
        instance.removeItem('mixed-key'),
        instance.setItem('mixed-key', 'final'),
      ];

      await Promise.all(ops);

      // Final value should be 'final' (last write wins)
      const value = await instance.getItem('mixed-key');
      expect(value).toBe('final');
    });
  });

  describe('Transaction isolation', () => {
    let instance: LocalSpaceInstance;

    beforeEach(async () => {
      instance = localspace.createInstance({
        name: `transaction-test-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
      });
      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.clear();
    });

    afterEach(async () => {
      try {
        await instance.clear();
        await instance.dropInstance();
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should handle concurrent transactions', async () => {
      await instance.setItem('counter', 0);

      const transaction1 = instance.runTransaction('readwrite', async (scope) => {
        const val = await scope.get<number>('counter');
        await scope.set('counter', (val ?? 0) + 1);
        return val;
      });

      const transaction2 = instance.runTransaction('readwrite', async (scope) => {
        const val = await scope.get<number>('counter');
        await scope.set('counter', (val ?? 0) + 10);
        return val;
      });

      await Promise.all([transaction1, transaction2]);

      // Both transactions should complete; final value depends on execution order
      const finalValue = await instance.getItem<number>('counter');
      expect(finalValue).toBeGreaterThanOrEqual(1);
    });

    it('should rollback on transaction error', async () => {
      await instance.setItem('rollback-key', 'original');

      try {
        await instance.runTransaction('readwrite', async (scope) => {
          await scope.set('rollback-key', 'modified');
          throw new Error('Intentional error');
        });
      } catch {
        // Expected
      }

      // Value should remain 'original' due to rollback
      const value = await instance.getItem('rollback-key');
      expect(value).toBe('original');
    });

    it('should prevent writes in readonly transaction', async () => {
      await instance.setItem('readonly-key', 'value');

      await expect(
        instance.runTransaction('readonly', async (scope) => {
          await scope.set('readonly-key', 'modified');
        })
      ).rejects.toThrow(/readonly/i);

      // Value should remain unchanged
      const value = await instance.getItem('readonly-key');
      expect(value).toBe('value');
    });
  });

  describe('Empty and null edge cases', () => {
    let instance: LocalSpaceInstance;

    beforeEach(async () => {
      instance = localspace.createInstance({
        name: `null-test-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
      });
      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.clear();
    });

    afterEach(async () => {
      try {
        await instance.clear();
        await instance.dropInstance();
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should handle empty string key', async () => {
      await instance.setItem('', 'empty-key-value');
      const value = await instance.getItem('');
      expect(value).toBe('empty-key-value');
    });

    it('should handle empty string value', async () => {
      await instance.setItem('empty-value', '');
      const value = await instance.getItem('empty-value');
      expect(value).toBe('');
    });

    it('should handle undefined value (converts to null)', async () => {
      await instance.setItem('undefined-value', undefined as any);
      const value = await instance.getItem('undefined-value');
      expect(value).toBe(null);
    });

    it('should handle very long keys', async () => {
      const longKey = 'k'.repeat(1000);
      await instance.setItem(longKey, 'long-key-value');
      const value = await instance.getItem(longKey);
      expect(value).toBe('long-key-value');
    });

    it('should handle special characters in keys', async () => {
      const specialKeys = [
        'key/with/slashes',
        'key\\with\\backslashes',
        'key:with:colons',
        'key with spaces',
        'key\twith\ttabs',
        'key\nwith\nnewlines',
        '键值中文',
        'キー日本語',
        'مفتاح عربي',
        '🔑emoji🔐',
      ];

      for (const key of specialKeys) {
        await instance.setItem(key, `value-for-${key}`);
      }

      for (const key of specialKeys) {
        const value = await instance.getItem(key);
        expect(value).toBe(`value-for-${key}`);
      }
    });

    it('should handle empty batch operations', async () => {
      const result = await instance.setItems([]);
      expect(result).toEqual([]);

      const getResult = await instance.getItems([]);
      expect(getResult).toEqual([]);

      await instance.removeItems([]);
      // Should complete without error
    });

    it('should handle getItems with non-existent keys', async () => {
      await instance.setItem('exists', 'value');

      const result = await instance.getItems(['exists', 'not-exists', 'also-not-exists']);
      expect(result).toEqual([
        { key: 'exists', value: 'value' },
        { key: 'not-exists', value: null },
        { key: 'also-not-exists', value: null },
      ]);
    });
  });

  describe('Large data handling', () => {
    let instance: LocalSpaceInstance;

    beforeEach(async () => {
      instance = localspace.createInstance({
        name: `large-data-test-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
      });
      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.clear();
    });

    afterEach(async () => {
      try {
        await instance.clear();
        await instance.dropInstance();
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should handle large string values', async () => {
      const largeString = 'x'.repeat(1024 * 100); // 100KB
      await instance.setItem('large-string', largeString);
      const value = await instance.getItem('large-string');
      expect(value).toBe(largeString);
    });

    it('should handle large arrays', async () => {
      const largeArray = Array.from({ length: 10000 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        data: 'x'.repeat(50),
      }));
      await instance.setItem('large-array', largeArray);
      const value = await instance.getItem<typeof largeArray>('large-array');
      expect(value).toHaveLength(10000);
      expect(value?.[5000]).toEqual({
        id: 5000,
        name: 'item-5000',
        data: 'x'.repeat(50),
      });
    });

    it('should handle deeply nested objects', async () => {
      const createDeepObject = (depth: number): object => {
        if (depth === 0) return { value: 'leaf' };
        return { nested: createDeepObject(depth - 1) };
      };

      const deepObject = createDeepObject(50);
      await instance.setItem('deep-object', deepObject);
      const value = await instance.getItem<typeof deepObject>('deep-object');
      expect(value).toEqual(deepObject);
    });

    it('should handle large batch operations', async () => {
      const entries = Array.from({ length: 500 }, (_, i) => ({
        key: `batch-key-${i}`,
        value: { id: i, data: 'x'.repeat(100) },
      }));

      await instance.setItems(entries);

      const keys = await instance.keys();
      expect(keys.length).toBe(500);

      const values = await instance.getItems(keys);
      expect(values.length).toBe(500);
    });
  });

  describe('Plugin edge cases', () => {
    it('should handle TTL with concurrent access', async () => {
      const instance = localspace.createInstance({
        name: `ttl-concurrent-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
        plugins: [ttlPlugin({ defaultTTL: 100 })],
      });

      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();

      // Set value
      await instance.setItem('ttl-key', 'value');

      // Concurrent reads before expiry
      const reads = Array.from({ length: 10 }, () =>
        instance.getItem('ttl-key')
      );
      const results = await Promise.all(reads);
      expect(results.every((v) => v === 'value')).toBe(true);

      // Wait for TTL to expire
      await sleep(150);

      // Value should be expired
      const expired = await instance.getItem('ttl-key');
      expect(expired).toBe(null);

      await instance.destroy();
    });

    it('should handle quota plugin with concurrent writes', async () => {
      const instance = localspace.createInstance({
        name: `quota-concurrent-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
        plugins: [quotaPlugin({ maxSize: 10000, evictionPolicy: 'error' })],
      });

      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();

      // Small concurrent writes should succeed
      const writes = Array.from({ length: 10 }, (_, i) =>
        instance.setItem(`quota-key-${i}`, `value-${i}`)
      );

      await Promise.all(writes);

      const keys = await instance.keys();
      expect(keys.length).toBe(10);

      await instance.destroy();
    });
  });

  describe('Instance lifecycle edge cases', () => {
    it('should handle operations after dropInstance', async () => {
      const instance = localspace.createInstance({
        name: `lifecycle-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
      });

      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.setItem('key', 'value');
      await instance.dropInstance();

      // Operations after drop should still work (recreates DB)
      await instance.setItem('new-key', 'new-value');
      const value = await instance.getItem('new-key');
      expect(value).toBe('new-value');

      await instance.dropInstance();
    });

    it('should handle multiple createInstance with same name', async () => {
      const name = `shared-${Math.random().toString(36).slice(2)}`;

      const instance1 = localspace.createInstance({ name, storeName: 'store1' });
      const instance2 = localspace.createInstance({ name, storeName: 'store2' });

      await instance1.setDriver([instance1.INDEXEDDB]);
      await instance2.setDriver([instance2.INDEXEDDB]);
      await instance1.ready();
      await instance2.ready();

      await instance1.setItem('key1', 'value1');
      await instance2.setItem('key2', 'value2');

      // Each store should have its own data
      expect(await instance1.getItem('key1')).toBe('value1');
      expect(await instance1.getItem('key2')).toBe(null);
      expect(await instance2.getItem('key1')).toBe(null);
      expect(await instance2.getItem('key2')).toBe('value2');

      await instance1.dropInstance();
      await instance2.dropInstance();
    });

    it('should handle rapid ready() calls', async () => {
      const instance = localspace.createInstance({
        name: `rapid-ready-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
      });

      await instance.setDriver([instance.INDEXEDDB]);

      // Multiple rapid ready calls
      const readyCalls = Array.from({ length: 10 }, () => instance.ready());
      await Promise.all(readyCalls);

      // Should work normally
      await instance.setItem('key', 'value');
      expect(await instance.getItem('key')).toBe('value');

      await instance.dropInstance();
    });
  });

  describe('Error recovery', () => {
    let instance: LocalSpaceInstance;

    beforeEach(async () => {
      instance = localspace.createInstance({
        name: `error-recovery-${Math.random().toString(36).slice(2)}`,
        storeName: 'testStore',
      });
      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.clear();
    });

    afterEach(async () => {
      try {
        await instance.clear();
        await instance.dropInstance();
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should recover from failed operation and continue working', async () => {
      await instance.setItem('key1', 'value1');

      // Force an error by using invalid key type (will be converted to string)
      await instance.setItem(null as any, 'value');

      // Should continue working
      await instance.setItem('key2', 'value2');
      expect(await instance.getItem('key1')).toBe('value1');
      expect(await instance.getItem('key2')).toBe('value2');
    });

    it('should handle iterate early termination', async () => {
      for (let i = 0; i < 100; i++) {
        await instance.setItem(`iterate-key-${i}`, i);
      }

      let count = 0;
      await instance.iterate((value, key) => {
        count++;
        if (count === 10) {
          return 'stop'; // Early termination
        }
      });

      expect(count).toBe(10);
    });
  });
});
