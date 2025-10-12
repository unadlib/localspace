import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDir, 'fixtures', 'localspace.html');
const fixtureUrl = pathToFileURL(fixturePath).href;

const randomStoreName = (label: string) =>
  `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function ensureFixtureReady(page: Page) {
  await page.goto(fixtureUrl);
  await page.waitForFunction(
    () => (window as any).__localspaceLoaded || (window as any).__localspaceError,
  );
  const importError = await page.evaluate(() => (window as any).__localspaceError);
  if (importError) {
    throw new Error(`localspace fixture failed to load: ${importError}`);
  }
}

test.describe('localspace browser interoperability', () => {
  test('setItem/getItem/iterate mirror localForage behaviour', async ({ page }) => {
    await ensureFixtureReady(page);

    const result = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.INDEXEDDB, instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      await instance.setItem('officeX', 'InitechX');
      await instance.setItem('officeY', 'InitrodeY');

      const storedX = await instance.getItem('officeX');
      const length = await instance.length();
      const keys = await instance.keys();

      const iterated: Array<{ key: string; value: any; iteration: number }> = [];
      await instance.iterate((value, key, iterationNumber) => {
        iterated.push({ key, value, iteration: iterationNumber });
      });

      return { storedX, length, keys, iterated };
    }, randomStoreName('iterate-baseline'));

    expect(result.storedX).toBe('InitechX');
    expect(result.length).toBe(2);
    expect(new Set(result.keys)).toEqual(new Set(['officeX', 'officeY']));
    expect(result.iterated.length).toBe(2);
    expect(result.iterated.map((entry) => entry.key)).toEqual(['officeX', 'officeY']);
    expect(result.iterated.map((entry) => entry.value)).toEqual(['InitechX', 'InitrodeY']);
    expect(result.iterated[0]?.iteration).toBe(1);
    expect(result.iterated[1]?.iteration).toBe(2);
  });

  test('clear() resets length and keys (参考 localforage_test/test.api.js:316-360)', async ({ page }) => {
    await ensureFixtureReady(page);

    const result = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      await instance.setItem('taskOne', 'alpha');
      await instance.setItem('taskTwo', 'beta');

      const before = {
        length: await instance.length(),
        keys: await instance.keys(),
      };

      await instance.clear();

      const after = {
        length: await instance.length(),
        keys: await instance.keys(),
      };

      return { before, after };
    }, randomStoreName('clear'));

    expect(result.before.length).toBe(2);
    expect(new Set(result.before.keys)).toEqual(new Set(['taskOne', 'taskTwo']));
    expect(result.after.length).toBe(0);
    expect(result.after.keys).toEqual([]);
  });

  test('iterate breaks early when return value defined (参考 localforage_test/test.api.js:519-569)', async ({ page }) => {
    await ensureFixtureReady(page);

    const breakValue = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      await instance.setItem('officeX', 'InitechX');
      await instance.setItem('officeY', 'InitrodeY');

      return instance.iterate(() => 'Some value!');
    }, randomStoreName('iterate-break'));

    expect(breakValue).toBe('Some value!');
  });

  test('key(n) and keys() follow insertion order (参考 localforage_test/test.api.js:704-736)', async ({ page }) => {
    await ensureFixtureReady(page);

    const keys = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      await instance.setItem('alpha', 'A');
      await instance.setItem('beta', 'B');

      const first = await instance.key(0);
      const second = await instance.key(1);
      const all = await instance.keys();

      return { first, second, all };
    }, randomStoreName('keys'));

    expect(keys.first).toBe('alpha');
    expect(keys.second).toBe('beta');
    expect(keys.all).toEqual(['alpha', 'beta']);
  });

  test('dropInstance removes persisted entries for localStorage (参考 localforage_test/test.api.js:1940-1995)', async ({ page }) => {
    await ensureFixtureReady(page);

    const result = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      await instance.setItem('key1', 'value1');
      await instance.setItem('key2', 'value2');

      await instance.dropInstance();

      const length = await instance.length();
      const value = await instance.getItem('key1');

      return { length, value };
    }, randomStoreName('drop-instance'));

    expect(result.length).toBe(0);
    expect(result.value).toBe(null);
  });
});
