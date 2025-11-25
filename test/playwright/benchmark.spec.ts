import { test, expect } from '@playwright/test';
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
});
