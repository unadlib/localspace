import { test, expect } from './coverage-test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDir, 'fixtures', 'localspace.html');
const fixtureUrl = pathToFileURL(fixturePath).href;

async function ensureLocalspaceReady(page: Page) {
  await page.goto(fixtureUrl);
  await page.waitForFunction(
    () => (window as any).__localspaceLoaded || (window as any).__localspaceError,
  );

  const importError = await page.evaluate(() => (window as any).__localspaceError);
  if (importError) {
    throw new Error(`localspace fixture failed to load: ${importError}`);
  }
}

const BENCHMARK_CONFIG = {
  itemCount: 500,
  payloadBytes: 256,
};

const COLD_START_CONFIG = {
  itemCount: 200,
  payloadBytes: 128,
  maxBatchSize: 50,
};

test.describe('IndexedDB benchmark', () => {
  test('reports baseline throughput for set/get/iterate', async ({ page }) => {
    await ensureLocalspaceReady(page);

    const metrics = await page.evaluate(async (config) => {
      const localspace = (window as any).localspace;
      if (!localspace.supports(localspace.INDEXEDDB)) {
        throw new Error('IndexedDB driver not supported in browser');
      }

      const storeName = `benchmark-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const instance = localspace.createInstance({
        name: 'playwright-benchmark',
        storeName,
      });

      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.clear();

      const payload = 'x'.repeat(config.payloadBytes);
      const items = Array.from({ length: config.itemCount }, (_, index) => ({
        key: `key-${index}`,
        value: `${payload}-${index}`,
      }));

      const setStart = performance.now();
      for (const item of items) {
        await instance.setItem(item.key, item.value);
      }
      const setMs = performance.now() - setStart;

      const getStart = performance.now();
      for (const item of items) {
        await instance.getItem(item.key);
      }
      const getMs = performance.now() - getStart;

      let iterated = 0;
      const iterateStart = performance.now();
      await instance.iterate((value, key, iterationNumber) => {
        iterated = iterationNumber;
      });
      const iterateMs = performance.now() - iterateStart;

      await instance.dropInstance();

      return {
        driver: instance.driver(),
        itemCount: config.itemCount,
        payloadBytes: config.payloadBytes,
        setMs,
        getMs,
        iterateMs,
        iterated,
        setOpsPerSec: (config.itemCount / setMs) * 1000,
        getOpsPerSec: (config.itemCount / getMs) * 1000,
        iterateOpsPerSec: (config.itemCount / iterateMs) * 1000,
      };
    }, BENCHMARK_CONFIG);

    console.log(
      `[IndexedDB] ${metrics.itemCount} items x ${metrics.payloadBytes}B payload (driver: ${metrics.driver})`,
    );
    console.log(
      `setItem: ${metrics.setMs.toFixed(2)}ms (${metrics.setOpsPerSec.toFixed(2)} ops/sec)`,
    );
    console.log(
      `getItem: ${metrics.getMs.toFixed(2)}ms (${metrics.getOpsPerSec.toFixed(2)} ops/sec)`,
    );
    console.log(
      `iterate: ${metrics.iterateMs.toFixed(2)}ms (${metrics.iterateOpsPerSec.toFixed(2)} ops/sec)`,
    );

    expect(metrics.driver).toBe('asyncStorage');
    expect(metrics.iterated).toBe(metrics.itemCount);
    expect(metrics.setMs).toBeGreaterThan(0);
    expect(metrics.getMs).toBeGreaterThan(0);
    expect(metrics.iterateMs).toBeGreaterThan(0);
  });

  test('compares batch APIs against single-item loops', async ({ page }) => {
    await ensureLocalspaceReady(page);

    const metrics = await page.evaluate(async (config) => {
      const localspace = (window as any).localspace;
      if (!localspace.supports(localspace.INDEXEDDB)) {
        throw new Error('IndexedDB driver not supported in browser');
      }

      const storeName = `benchmark-batch-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2, 8)}`;
      const instance = localspace.createInstance({
        name: 'playwright-benchmark',
        storeName,
      });

      await instance.setDriver([instance.INDEXEDDB]);
      await instance.ready();
      await instance.clear();

      const payload = 'x'.repeat(config.payloadBytes);
      const items = Array.from({ length: config.itemCount }, (_, index) => ({
        key: `key-${index}`,
        value: `${payload}-${index}`,
      }));
      const keys = items.map((item) => item.key);

      // Baseline single-item loops
      const setSingleStart = performance.now();
      for (const item of items) {
        await instance.setItem(item.key, item.value);
      }
      const setSingleMs = performance.now() - setSingleStart;

      const getSingleStart = performance.now();
      for (const item of items) {
        await instance.getItem(item.key);
      }
      const getSingleMs = performance.now() - getSingleStart;

      const removeSingleStart = performance.now();
      for (const key of keys) {
        await instance.removeItem(key);
      }
      const removeSingleMs = performance.now() - removeSingleStart;

      // Batch APIs
      const setBatchStart = performance.now();
      const setBatchResult = await instance.setItems(items);
      const setBatchMs = performance.now() - setBatchStart;

      const getBatchStart = performance.now();
      const getBatchResult = await instance.getItems(keys);
      const getBatchMs = performance.now() - getBatchStart;

      const removeBatchStart = performance.now();
      await instance.removeItems(keys);
      const removeBatchMs = performance.now() - removeBatchStart;

      await instance.dropInstance();

      return {
        driver: instance.driver(),
        itemCount: config.itemCount,
        payloadBytes: config.payloadBytes,
        set: { singleMs: setSingleMs, batchMs: setBatchMs },
        get: { singleMs: getSingleMs, batchMs: getBatchMs },
        remove: { singleMs: removeSingleMs, batchMs: removeBatchMs },
        setBatchCount: setBatchResult.length,
        getBatchCount: getBatchResult.length,
        setSpeedup: setSingleMs / setBatchMs,
        getSpeedup: getSingleMs / getBatchMs,
        removeSpeedup: removeSingleMs / removeBatchMs,
      };
    }, BENCHMARK_CONFIG);

    const format = (label: string, singleMs: number, batchMs: number, speedup: number) =>
      `${label}: single ${singleMs.toFixed(2)}ms vs batch ${batchMs.toFixed(
        2,
      )}ms (x${speedup.toFixed(2)})`;

    console.log(
      `[IndexedDB] Batch vs single (${metrics.itemCount} items x ${metrics.payloadBytes}B, driver: ${metrics.driver})`,
    );
    console.log(format('set', metrics.set.singleMs, metrics.set.batchMs, metrics.setSpeedup));
    console.log(format('get', metrics.get.singleMs, metrics.get.batchMs, metrics.getSpeedup));
    console.log(
      format('remove', metrics.remove.singleMs, metrics.remove.batchMs, metrics.removeSpeedup),
    );

    expect(metrics.driver).toBe('asyncStorage');
    expect(metrics.setBatchCount).toBe(metrics.itemCount);
    expect(metrics.getBatchCount).toBe(metrics.itemCount);
    expect(metrics.set.batchMs).toBeGreaterThan(0);
    expect(metrics.get.batchMs).toBeGreaterThan(0);
    expect(metrics.remove.batchMs).toBeGreaterThan(0);
    expect(metrics.setSpeedup).toBeGreaterThan(1);
    expect(metrics.removeSpeedup).toBeGreaterThan(1);
  });

  test('compares runTransaction and batched chunks (with prewarm toggle)', async ({ page }) => {
    await ensureLocalspaceReady(page);

    const metrics = await page.evaluate(async (config) => {
      const localspace = (window as any).localspace;
      if (!localspace.supports(localspace.INDEXEDDB)) {
        throw new Error('IndexedDB driver not supported in browser');
      }

      const payload = 'x'.repeat(config.payloadBytes);
      const items = Array.from({ length: config.itemCount }, (_, index) => ({
        key: `key-${index}`,
        value: `${payload}-${index}`,
      }));
      const keys = items.map((i) => i.key);

      const create = (prewarm: boolean) =>
        localspace.createInstance({
          name: `run-tx-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
          storeName: `store-${Math.random().toString(16).slice(2, 6)}`,
          maxBatchSize: config.maxBatchSize,
          prewarmTransactions: prewarm,
        });

      const measureInstance = async (prewarm: boolean) => {
        const instance = create(prewarm);
        await instance.setDriver([instance.INDEXEDDB]);
        const readyStart = performance.now();
        await instance.ready();
        const readyMs = performance.now() - readyStart;
        await instance.clear();

        const chunkStart = performance.now();
        await instance.setItems(items);
        const chunkMs = performance.now() - chunkStart;

        const txStart = performance.now();
        await instance.runTransaction('readwrite', async (tx) => {
          for (const item of items) {
            await tx.set(item.key, item.value);
          }
          // one read batch to keep it realistic
          for (const key of keys) {
            await tx.get(key);
          }
        });
        const txMs = performance.now() - txStart;

        await instance.dropInstance();

        return { readyMs, chunkMs, txMs };
      };

      const cold = await measureInstance(false);
      const warm = await measureInstance(true);

      return {
        cold,
        warm,
        readySpeedup: cold.readyMs / warm.readyMs,
        chunkSpeedup: cold.chunkMs / warm.chunkMs,
        txSpeedup: cold.txMs / warm.txMs,
      };
    }, COLD_START_CONFIG);

    console.log('[IndexedDB] runTransaction vs chunked batch (prewarm toggle)');
    console.log(
      `ready: cold ${metrics.cold.readyMs.toFixed(2)}ms vs warm ${metrics.warm.readyMs.toFixed(
        2,
      )}ms (x${metrics.readySpeedup.toFixed(2)})`,
    );
    console.log(
      `setItems (chunked): cold ${metrics.cold.chunkMs.toFixed(
        2,
      )}ms vs warm ${metrics.warm.chunkMs.toFixed(2)}ms (x${metrics.chunkSpeedup.toFixed(2)})`,
    );
    console.log(
      `runTransaction: cold ${metrics.cold.txMs.toFixed(
        2,
      )}ms vs warm ${metrics.warm.txMs.toFixed(2)}ms (x${metrics.txSpeedup.toFixed(2)})`,
    );

    expect(metrics.readySpeedup).toBeGreaterThan(0);
    expect(metrics.chunkSpeedup).toBeGreaterThan(0);
    expect(metrics.txSpeedup).toBeGreaterThan(0);
  });
});
