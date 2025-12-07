import { test, expect } from './coverage-test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDir, 'fixtures', 'localspace.html');
const fixtureUrl = pathToFileURL(fixturePath).href;

const THROUGHPUT_CONFIG = {
  itemCount: 400,
  payloadBytes: 256,
};

const BATCH_CONFIG = {
  itemCount: 320,
  payloadBytes: 384,
  maxBatchSize: 64,
};

const STARTUP_CONFIG = {
  runs: 3,
};

const CONCURRENCY_CONFIG = {
  itemCount: 200,
  payloadBytes: 256,
  concurrency: 8,
};

const COALESCE_CONFIG = {
  itemCount: 200,
  payloadBytes: 256,
  concurrency: 8,
};

const randomStoreName = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

async function ensureStoragesReady(page: Page) {
  await page.goto(fixtureUrl);
  await page.waitForFunction(
    () =>
      ((window as any).__localspaceLoaded || (window as any).__localspaceError) &&
      ((window as any).__localforageLoaded || (window as any).__localforageError),
  );

  const { localspaceError, localforageError } = await page.evaluate(() => ({
    localspaceError:
      (window as any).__localspaceError || (window as any).__localspaceUmdError,
    localforageError: (window as any).__localforageError,
  }));

  if (localspaceError) {
    throw new Error(`localspace fixture failed to load: ${localspaceError}`);
  }

  if (localforageError) {
    throw new Error(`localforage fixture failed to load: ${localforageError}`);
  }
}

test.describe('localspace vs localforage benchmarks', () => {
  test('set/get/iterate throughput on IndexedDB driver', async ({ page }) => {
    await ensureStoragesReady(page);

    const metrics = await page.evaluate(async (config) => {
      const localspace = (window as any).localspace;
      const localforage = (window as any).localforage;
      const randomStoreName = (label: string) =>
        `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

      const payload = 'x'.repeat(config.payloadBytes);
      const items = Array.from({ length: config.itemCount }, (_, index) => ({
        key: `key-${index}`,
        value: `${payload}-${index}`,
      }));

      const measureLocalspace = async () => {
        const instance = localspace.createInstance({
          name: 'playwright-localspace-throughput',
          storeName: randomStoreName('ls-throughput'),
        });

        await instance.setDriver([instance.INDEXEDDB]);
        const readyStart = performance.now();
        await instance.ready();
        const readyMs = performance.now() - readyStart;
        await instance.clear();

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
        await instance.iterate((value: unknown, key: string, iterationNumber: number) => {
          iterated = iterationNumber;
        });
        const iterateMs = performance.now() - iterateStart;

        await instance.dropInstance();

        const driver = typeof instance.driver === 'function' ? await instance.driver() : 'unknown';
        return {
          library: 'localspace',
          driver,
          itemCount: config.itemCount,
          payloadBytes: config.payloadBytes,
          readyMs,
          setMs,
          getMs,
          iterateMs,
          iterated,
          setOpsPerSec: (config.itemCount / setMs) * 1000,
          getOpsPerSec: (config.itemCount / getMs) * 1000,
          iterateOpsPerSec: (config.itemCount / iterateMs) * 1000,
        };
      };

      const measureLocalforage = async () => {
        const instance = localforage.createInstance({
          name: 'playwright-localforage-throughput',
          storeName: randomStoreName('lf-throughput'),
        });

        if (typeof instance.setDriver === 'function') {
          await instance.setDriver([localforage.INDEXEDDB]);
        }

        const readyStart = performance.now();
        await instance.ready();
        const readyMs = performance.now() - readyStart;
        await instance.clear();

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
        await instance.iterate((value: unknown, key: string, iterationNumber: number) => {
          iterated = iterationNumber;
        });
        const iterateMs = performance.now() - iterateStart;

        if (typeof instance.dropInstance === 'function') {
          await instance.dropInstance();
        } else {
          await instance.clear();
        }

        const driver = typeof instance.driver === 'function' ? await instance.driver() : 'unknown';
        return {
          library: 'localforage',
          driver,
          itemCount: config.itemCount,
          payloadBytes: config.payloadBytes,
          readyMs,
          setMs,
          getMs,
          iterateMs,
          iterated,
          setOpsPerSec: (config.itemCount / setMs) * 1000,
          getOpsPerSec: (config.itemCount / getMs) * 1000,
          iterateOpsPerSec: (config.itemCount / iterateMs) * 1000,
        };
      };

      const [localspaceMetrics, localforageMetrics] = await Promise.all([
        measureLocalspace(),
        measureLocalforage(),
      ]);

      return { localspace: localspaceMetrics, localforage: localforageMetrics };
    }, THROUGHPUT_CONFIG);

    console.log(
      `[throughput] ${THROUGHPUT_CONFIG.itemCount} items x ${THROUGHPUT_CONFIG.payloadBytes}B payload (IndexedDB)`,
    );
    console.log(
      `localspace set/get/iterate ops/sec: ${metrics.localspace.setOpsPerSec.toFixed(2)} / ${metrics.localspace.getOpsPerSec.toFixed(2)} / ${metrics.localspace.iterateOpsPerSec.toFixed(2)}`,
    );
    console.log(
      `localforage set/get/iterate ops/sec: ${metrics.localforage.setOpsPerSec.toFixed(2)} / ${metrics.localforage.getOpsPerSec.toFixed(2)} / ${metrics.localforage.iterateOpsPerSec.toFixed(2)}`,
    );

    expect(metrics.localspace.iterated).toBe(THROUGHPUT_CONFIG.itemCount);
    expect(metrics.localforage.iterated).toBe(THROUGHPUT_CONFIG.itemCount);
    expect(metrics.localspace.readyMs).toBeGreaterThan(0);
    expect(metrics.localforage.readyMs).toBeGreaterThan(0);
    expect(metrics.localspace.setMs).toBeGreaterThan(0);
    expect(metrics.localforage.setMs).toBeGreaterThan(0);
    expect(metrics.localspace.getMs).toBeGreaterThan(0);
    expect(metrics.localforage.getMs).toBeGreaterThan(0);
    expect(metrics.localspace.iterateMs).toBeGreaterThan(0);
    expect(metrics.localforage.iterateMs).toBeGreaterThan(0);
  });

  test('batch APIs vs single-item loops (localspace) and localforage baseline', async ({ page }) => {
    await ensureStoragesReady(page);

    const metrics = await page.evaluate(async (config) => {
      const localspace = (window as any).localspace;
      const localforage = (window as any).localforage;
      const randomStoreName = (label: string) =>
        `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

      const payload = 'y'.repeat(config.payloadBytes);
      const items = Array.from({ length: config.itemCount }, (_, index) => ({
        key: `bulk-${index}`,
        value: `${payload}-${index}`,
      }));
      const keys = items.map((item) => item.key);

      const measureLocalspace = async () => {
        const instance = localspace.createInstance({
          name: 'playwright-localspace-batch',
          storeName: randomStoreName('ls-batch'),
          maxBatchSize: config.maxBatchSize,
        });

        await instance.setDriver([instance.INDEXEDDB]);
        await instance.ready();
        await instance.clear();

        const batchStart = performance.now();
        const setBatchResult = await instance.setItems(items);
        const batchMs = performance.now() - batchStart;

        const getBatchStart = performance.now();
        const getBatchResult = await instance.getItems(keys);
        const getBatchMs = performance.now() - getBatchStart;

        await instance.clear();

        const singleSetStart = performance.now();
        for (const item of items) {
          await instance.setItem(item.key, item.value);
        }
        const singleSetMs = performance.now() - singleSetStart;

        const singleGetStart = performance.now();
        for (const key of keys) {
          await instance.getItem(key);
        }
        const singleGetMs = performance.now() - singleGetStart;

        const removeBatchStart = performance.now();
        await instance.removeItems(keys);
        const removeBatchMs = performance.now() - removeBatchStart;

        await instance.dropInstance();

        return {
          driver: typeof instance.driver === 'function' ? await instance.driver() : 'unknown',
          batch: {
            setMs: batchMs,
            getMs: getBatchMs,
            removeMs: removeBatchMs,
            setCount: setBatchResult.length,
            getCount: getBatchResult.length,
          },
          single: {
            setMs: singleSetMs,
            getMs: singleGetMs,
          },
          speedups: {
            set: singleSetMs / batchMs,
            get: singleGetMs / getBatchMs,
          },
        };
      };

      const measureLocalforage = async () => {
        const instance = localforage.createInstance({
          name: 'playwright-localforage-batch',
          storeName: randomStoreName('lf-batch'),
        });

        if (typeof instance.setDriver === 'function') {
          await instance.setDriver([localforage.INDEXEDDB]);
        }

        await instance.ready();
        await instance.clear();

        const setStart = performance.now();
        for (const item of items) {
          await instance.setItem(item.key, item.value);
        }
        const setMs = performance.now() - setStart;

        const getStart = performance.now();
        for (const key of keys) {
          await instance.getItem(key);
        }
        const getMs = performance.now() - getStart;

        const removeStart = performance.now();
        for (const key of keys) {
          await instance.removeItem(key);
        }
        const removeMs = performance.now() - removeStart;

        if (typeof instance.dropInstance === 'function') {
          await instance.dropInstance();
        } else {
          await instance.clear();
        }

        return {
          driver: typeof instance.driver === 'function' ? await instance.driver() : 'unknown',
          single: {
            setMs,
            getMs,
            removeMs,
          },
        };
      };

      const [localspaceMetrics, localforageMetrics] = await Promise.all([
        measureLocalspace(),
        measureLocalforage(),
      ]);

      return { localspace: localspaceMetrics, localforage: localforageMetrics };
    }, BATCH_CONFIG);

    console.log(
      `[batch] ${BATCH_CONFIG.itemCount} items x ${BATCH_CONFIG.payloadBytes}B (maxBatchSize: ${BATCH_CONFIG.maxBatchSize})`,
    );
    console.log(
      `localspace setItems vs single set: ${metrics.localspace.batch.setMs.toFixed(2)}ms vs ${metrics.localspace.single.setMs.toFixed(2)}ms (x${metrics.localspace.speedups.set.toFixed(2)})`,
    );
    console.log(
      `localspace getItems vs single get: ${metrics.localspace.batch.getMs.toFixed(2)}ms vs ${metrics.localspace.single.getMs.toFixed(2)}ms (x${metrics.localspace.speedups.get.toFixed(2)})`,
    );
    console.log(
      `localforage single set/get/remove: ${metrics.localforage.single.setMs.toFixed(2)}ms / ${metrics.localforage.single.getMs.toFixed(2)}ms / ${metrics.localforage.single.removeMs.toFixed(2)}ms`,
    );

    expect(metrics.localspace.batch.setCount).toBe(BATCH_CONFIG.itemCount);
    expect(metrics.localspace.batch.getCount).toBe(BATCH_CONFIG.itemCount);
    expect(metrics.localspace.batch.setMs).toBeGreaterThan(0);
    expect(metrics.localspace.batch.getMs).toBeGreaterThan(0);
    expect(metrics.localspace.single.setMs).toBeGreaterThan(0);
    expect(metrics.localspace.single.getMs).toBeGreaterThan(0);
    expect(metrics.localforage.single.setMs).toBeGreaterThan(0);
    expect(metrics.localforage.single.getMs).toBeGreaterThan(0);
    expect(metrics.localforage.single.removeMs).toBeGreaterThan(0);
  });

  test('concurrent set/get throughput comparison', async ({ page }) => {
    await ensureStoragesReady(page);

    const metrics = await page.evaluate(async (config) => {
      const localspace = (window as any).localspace;
      const localforage = (window as any).localforage;
      const randomStoreName = (label: string) =>
        `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

      const payload = 'z'.repeat(config.payloadBytes);
      const items = Array.from({ length: config.itemCount }, (_, index) => ({
        key: `concurrent-${index}`,
        value: `${payload}-${index}`,
      }));

      const runWithLimit = async <T>(tasks: Array<() => Promise<T>>, limit: number) => {
        let cursor = 0;
        const results: T[] = [];

        const worker = async () => {
          while (cursor < tasks.length) {
            const current = tasks[cursor];
            cursor += 1;
            results.push(await current());
          }
        };

        const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
        await Promise.all(workers);
        return results;
      };

      const measure = async (label: 'localspace' | 'localforage') => {
        const instance =
          label === 'localspace'
            ? localspace.createInstance({
                name: 'playwright-localspace-concurrency',
                storeName: randomStoreName('ls-concurrent'),
              })
            : localforage.createInstance({
                name: 'playwright-localforage-concurrency',
                storeName: randomStoreName('lf-concurrent'),
              });

        if (typeof instance.setDriver === 'function') {
          await instance.setDriver([
            label === 'localspace' ? instance.INDEXEDDB : localforage.INDEXEDDB,
          ]);
        }

        await instance.ready();
        await instance.clear();

        const setTasks = items.map((item) => () => instance.setItem(item.key, item.value));
        const setStart = performance.now();
        await runWithLimit(setTasks, config.concurrency);
        const setMs = performance.now() - setStart;

        const getTasks = items.map((item) => () => instance.getItem(item.key));
        const getStart = performance.now();
        await runWithLimit(getTasks, config.concurrency);
        const getMs = performance.now() - getStart;

        if (typeof instance.dropInstance === 'function') {
          await instance.dropInstance();
        } else {
          await instance.clear();
        }

        const driver = typeof instance.driver === 'function' ? await instance.driver() : 'unknown';

        return {
          driver,
          setMs,
          getMs,
          setOpsPerSec: (items.length / setMs) * 1000,
          getOpsPerSec: (items.length / getMs) * 1000,
        };
      };

      return {
        localspace: await measure('localspace'),
        localforage: await measure('localforage'),
      };
    }, CONCURRENCY_CONFIG);

    console.log(
      `[concurrent] ${CONCURRENCY_CONFIG.itemCount} items x ${CONCURRENCY_CONFIG.payloadBytes}B, concurrency=${CONCURRENCY_CONFIG.concurrency}`,
    );
    console.log(
      `localspace set/get ops/sec: ${metrics.localspace.setOpsPerSec.toFixed(2)} / ${metrics.localspace.getOpsPerSec.toFixed(2)}`,
    );
    console.log(
      `localforage set/get ops/sec: ${metrics.localforage.setOpsPerSec.toFixed(2)} / ${metrics.localforage.getOpsPerSec.toFixed(2)}`,
    );

    expect(metrics.localspace.setMs).toBeGreaterThan(0);
    expect(metrics.localspace.getMs).toBeGreaterThan(0);
    expect(metrics.localforage.setMs).toBeGreaterThan(0);
    expect(metrics.localforage.getMs).toBeGreaterThan(0);
  });

  test('localspace coalesce modes under concurrency', async ({ page }) => {
    await ensureStoragesReady(page);

    const metrics = await page.evaluate(async (config) => {
      const localspace = (window as any).localspace;
      const randomStoreName = (label: string) =>
        `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

      const payload = 'z'.repeat(config.payloadBytes);
      const items = Array.from({ length: config.itemCount }, (_, index) => ({
        key: `coalesce-${index}`,
        value: `${payload}-${index}`,
      }));

      const runWithLimit = async <T>(tasks: Array<() => Promise<T>>, limit: number) => {
        let cursor = 0;
        const results: T[] = [];

        const worker = async () => {
          while (cursor < tasks.length) {
            const current = tasks[cursor];
            cursor += 1;
            results.push(await current());
          }
        };

        const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
        await Promise.all(workers);
        return results;
      };

      const modes = [
        {
          label: 'default',
          options: {},
        },
        {
          label: 'coalesce-disabled',
          options: { coalesceWrites: false },
        },
        {
          label: 'coalesce-eventual',
          options: {
            coalesceWrites: true,
            coalesceReadConsistency: 'eventual' as const,
            coalesceFireAndForget: false,
          },
        },
      ];

      const measure = async (mode: (typeof modes)[number]) => {
        const instance = localspace.createInstance({
          name: `playwright-localspace-${mode.label}`,
          storeName: randomStoreName(mode.label),
          ...mode.options,
        });

        await instance.setDriver([instance.INDEXEDDB]);
        await instance.ready();
        await instance.clear();

        const setTasks = items.map((item) => () => instance.setItem(item.key, item.value));
        const setStart = performance.now();
        await runWithLimit(setTasks, config.concurrency);
        const setMs = performance.now() - setStart;

        const getTasks = items.map((item) => () => instance.getItem(item.key));
        const getStart = performance.now();
        await runWithLimit(getTasks, config.concurrency);
        const getMs = performance.now() - getStart;

        await instance.dropInstance();

        return {
          label: mode.label,
          setMs,
          getMs,
          setOpsPerSec: (items.length / setMs) * 1000,
          getOpsPerSec: (items.length / getMs) * 1000,
        };
      };

      const results = [] as Array<Awaited<ReturnType<typeof measure>>>;
      for (const mode of modes) {
        results.push(await measure(mode));
      }

      return results;
    }, COALESCE_CONFIG);

    console.log(
      `[coalesce] ${COALESCE_CONFIG.itemCount} items x ${COALESCE_CONFIG.payloadBytes}B, concurrency=${COALESCE_CONFIG.concurrency}`,
    );
    for (const mode of metrics) {
      console.log(
        `${mode.label}: set/get ops/sec ${mode.setOpsPerSec.toFixed(2)} / ${mode.getOpsPerSec.toFixed(2)} (set ${mode.setMs.toFixed(2)}ms, get ${mode.getMs.toFixed(2)}ms)`,
      );
    }

    expect(metrics.length).toBeGreaterThan(0);
    for (const mode of metrics) {
      expect(mode.setMs).toBeGreaterThan(0);
      expect(mode.getMs).toBeGreaterThan(0);
    }
  });

  test('startup/teardown latency comparison', async ({ page }) => {
    await ensureStoragesReady(page);

    const metrics = await page.evaluate(async (config) => {
      const localspace = (window as any).localspace;
      const localforage = (window as any).localforage;
      const randomStoreName = (label: string) =>
        `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

      const measure = async (label: 'localspace' | 'localforage') => {
        const samples: Array<{ readyMs: number; clearMs: number; dropMs: number }> = [];

        for (let i = 0; i < config.runs; i += 1) {
          const storeName = randomStoreName(`${label}-startup`);

          const instance =
            label === 'localspace'
              ? localspace.createInstance({
                  name: 'playwright-localspace-startup',
                  storeName,
                  prewarmTransactions: true,
                })
              : localforage.createInstance({
                  name: 'playwright-localforage-startup',
                  storeName,
                });

          if (typeof instance.setDriver === 'function') {
            await instance.setDriver([
              label === 'localspace' ? instance.INDEXEDDB : localforage.INDEXEDDB,
            ]);
          }

          const readyStart = performance.now();
          await instance.ready();
          const readyMs = performance.now() - readyStart;

          const clearStart = performance.now();
          await instance.clear();
          const clearMs = performance.now() - clearStart;

          const dropStart = performance.now();
          if (typeof instance.dropInstance === 'function') {
            await instance.dropInstance();
          } else {
            await instance.clear();
          }
          const dropMs = performance.now() - dropStart;

          samples.push({ readyMs, clearMs, dropMs });
        }

        const aggregate = samples.reduce(
          (acc, sample) => {
            acc.readyTotal += sample.readyMs;
            acc.clearTotal += sample.clearMs;
            acc.dropTotal += sample.dropMs;
            acc.readyMax = Math.max(acc.readyMax, sample.readyMs);
            acc.clearMax = Math.max(acc.clearMax, sample.clearMs);
            acc.dropMax = Math.max(acc.dropMax, sample.dropMs);
            return acc;
          },
          {
            readyTotal: 0,
            clearTotal: 0,
            dropTotal: 0,
            readyMax: 0,
            clearMax: 0,
            dropMax: 0,
          },
        );

        const divisor = samples.length || 1;

        return {
          runs: samples.length,
          average: {
            readyMs: aggregate.readyTotal / divisor,
            clearMs: aggregate.clearTotal / divisor,
            dropMs: aggregate.dropTotal / divisor,
          },
          max: {
            readyMs: aggregate.readyMax,
            clearMs: aggregate.clearMax,
            dropMs: aggregate.dropMax,
          },
        };
      };

      return {
        localspace: await measure('localspace'),
        localforage: await measure('localforage'),
      };
    }, STARTUP_CONFIG);

    console.log('[startup/teardown] IndexedDB ready/clear/drop averages (ms):');
    console.log(
      `localspace avg: ready ${metrics.localspace.average.readyMs.toFixed(2)}, clear ${metrics.localspace.average.clearMs.toFixed(2)}, drop ${metrics.localspace.average.dropMs.toFixed(2)}`,
    );
    console.log(
      `localforage avg: ready ${metrics.localforage.average.readyMs.toFixed(2)}, clear ${metrics.localforage.average.clearMs.toFixed(2)}, drop ${metrics.localforage.average.dropMs.toFixed(2)}`,
    );

    expect(metrics.localspace.runs).toBe(STARTUP_CONFIG.runs);
    expect(metrics.localforage.runs).toBe(STARTUP_CONFIG.runs);
    expect(metrics.localspace.average.readyMs).toBeGreaterThan(0);
    expect(metrics.localforage.average.readyMs).toBeGreaterThan(0);
    expect(metrics.localspace.average.clearMs).toBeGreaterThanOrEqual(0);
    expect(metrics.localforage.average.clearMs).toBeGreaterThanOrEqual(0);
    expect(metrics.localspace.average.dropMs).toBeGreaterThanOrEqual(0);
    expect(metrics.localforage.average.dropMs).toBeGreaterThanOrEqual(0);
  });
});
