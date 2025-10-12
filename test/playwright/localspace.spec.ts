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

  test('clear() resets length and keys', async ({ page }) => {
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

  test('iterate breaks early when return value defined', async ({ page }) => {
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

  test('key(n) and keys() follow insertion order', async ({ page }) => {
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

  test('dropInstance removes persisted entries for localStorage', async ({ page }) => {
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

  test('removeItem deletes single item without affecting others', async ({ page }) => {
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

      await instance.setItem('office', 'Initech');
      await instance.setItem('otherOffice', 'Initrode');

      await instance.removeItem('office');

      const removedValue = await instance.getItem('office');
      const existingValue = await instance.getItem('otherOffice');
      const length = await instance.length();

      return { removedValue, existingValue, length };
    }, randomStoreName('removeItem'));

    expect(result.removedValue).toBe(null);
    expect(result.existingValue).toBe('Initrode');
    expect(result.length).toBe(1);
  });

  test('setItem overwrites existing key', async ({ page }) => {
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

      await instance.setItem('floor', 'Mozilla');
      const firstValue = await instance.getItem('floor');

      await instance.setItem('floor', 'Quora');
      const secondValue = await instance.getItem('floor');

      return { firstValue, secondValue };
    }, randomStoreName('overwrite'));

    expect(result.firstValue).toBe('Mozilla');
    expect(result.secondValue).toBe('Quora');
  });

  test('getItem returns null for non-existent key', async ({ page }) => {
    await ensureFixtureReady(page);

    const value = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      return instance.getItem('nonExistentKey');
    }, randomStoreName('null-key'));

    expect(value).toBe(null);
  });
});

test.describe('localspace data type handling', () => {
  test('saves and retrieves string values', async ({ page }) => {
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

      await instance.setItem('office', 'Initech');
      const value = await instance.getItem('office');

      return { value, type: typeof value };
    }, randomStoreName('string-type'));

    expect(result.value).toBe('Initech');
    expect(result.type).toBe('string');
  });

  test('saves and retrieves number values', async ({ page }) => {
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

      await instance.setItem('number', 546);
      const value = await instance.getItem('number');

      return { value, type: typeof value };
    }, randomStoreName('number-type'));

    expect(result.value).toBe(546);
    expect(result.type).toBe('number');
  });

  test('saves and retrieves float values', async ({ page }) => {
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

      await instance.setItem('float', 546.041);
      const value = await instance.getItem('float');

      return { value, type: typeof value };
    }, randomStoreName('float-type'));

    expect(result.value).toBe(546.041);
    expect(result.type).toBe('number');
  });

  test('saves and retrieves boolean values', async ({ page }) => {
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

      await instance.setItem('bool', false);
      const value = await instance.getItem('bool');

      return { value, type: typeof value };
    }, randomStoreName('bool-type'));

    expect(result.value).toBe(false);
    expect(result.type).toBe('boolean');
  });

  test('saves and retrieves null value', async ({ page }) => {
    await ensureFixtureReady(page);

    const value = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      await instance.setItem('null', null);
      return instance.getItem('null');
    }, randomStoreName('null-type'));

    expect(value).toBe(null);
  });

  test('saves undefined as null', async ({ page }) => {
    await ensureFixtureReady(page);

    const value = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      await instance.setItem('undefined', undefined);
      return instance.getItem('undefined');
    }, randomStoreName('undefined-type'));

    expect(value).toBe(null);
  });

  test('saves and retrieves array values', async ({ page }) => {
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

      const arrayToSave = [2, 'one', true];
      await instance.setItem('array', arrayToSave);
      const value = await instance.getItem('array');

      return {
        value,
        isArray: Array.isArray(value),
        length: value?.length,
      };
    }, randomStoreName('array-type'));

    expect(result.isArray).toBe(true);
    expect(result.length).toBe(3);
    expect(result.value).toEqual([2, 'one', true]);
  });

  test('saves and retrieves nested object values', async ({ page }) => {
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

      const objectToSave = {
        floating: 43.01,
        nested: {
          array: [1, 2, 3],
        },
        nestedObjects: [
          { truth: true },
          { theCake: 'is a lie' },
          { happiness: 'is a warm gun' },
          false,
        ],
        string: 'bar',
      };

      await instance.setItem('obj', objectToSave);
      const value = await instance.getItem('obj');

      return {
        value,
        keysCount: Object.keys(value).length,
        hasNested: typeof value.nested === 'object',
        nestedArrayLength: value.nested?.array?.length,
      };
    }, randomStoreName('object-type'));

    expect(result.keysCount).toBe(4);
    expect(result.hasNested).toBe(true);
    expect(result.nestedArrayLength).toBe(3);
    expect(result.value.floating).toBe(43.01);
    expect(result.value.nestedObjects[1]).toEqual({ theCake: 'is a lie' });
    expect(result.value.nestedObjects[3]).toBe(false);
  });
});

test.describe('localspace multiple instances', () => {
  test('different instances cannot access each other\'s data', async ({ page }) => {
    await ensureFixtureReady(page);

    const result = await page.evaluate(async () => {
      const localspace = (window as any).localspace;
      const instance1 = localspace.createInstance({
        name: 'playwright-suite',
        storeName: 'store1',
      });
      const instance2 = localspace.createInstance({
        name: 'playwright-suite',
        storeName: 'store2',
      });

      await instance1.setDriver([instance1.LOCALSTORAGE]);
      await instance2.setDriver([instance2.LOCALSTORAGE]);
      await instance1.ready();
      await instance2.ready();
      await instance1.clear();
      await instance2.clear();

      await instance1.setItem('key1', 'value1');
      await instance2.setItem('key2', 'value2');

      const instance1HasKey2 = await instance1.getItem('key2');
      const instance2HasKey1 = await instance2.getItem('key1');
      const instance1Value = await instance1.getItem('key1');
      const instance2Value = await instance2.getItem('key2');

      return {
        instance1HasKey2,
        instance2HasKey1,
        instance1Value,
        instance2Value,
      };
    });

    expect(result.instance1HasKey2).toBe(null);
    expect(result.instance2HasKey1).toBe(null);
    expect(result.instance1Value).toBe('value1');
    expect(result.instance2Value).toBe('value2');
  });

  test('multiple instances can use same key with different values', async ({ page }) => {
    await ensureFixtureReady(page);

    const result = await page.evaluate(async () => {
      const localspace = (window as any).localspace;
      const instance1 = localspace.createInstance({
        name: 'playwright-suite',
        storeName: 'storeA',
      });
      const instance2 = localspace.createInstance({
        name: 'playwright-suite',
        storeName: 'storeB',
      });
      const instance3 = localspace.createInstance({
        name: 'playwright-suite',
        storeName: 'storeC',
      });

      await instance1.setDriver([instance1.LOCALSTORAGE]);
      await instance2.setDriver([instance2.LOCALSTORAGE]);
      await instance3.setDriver([instance3.LOCALSTORAGE]);
      await Promise.all([instance1.ready(), instance2.ready(), instance3.ready()]);
      await Promise.all([instance1.clear(), instance2.clear(), instance3.clear()]);

      await instance1.setItem('key', 'value1');
      await instance2.setItem('key', 'value2');
      await instance3.setItem('key', 'value3');

      const value1 = await instance1.getItem('key');
      const value2 = await instance2.getItem('key');
      const value3 = await instance3.getItem('key');

      return { value1, value2, value3 };
    });

    expect(result.value1).toBe('value1');
    expect(result.value2).toBe('value2');
    expect(result.value3).toBe('value3');
  });
});

test.describe('localspace configuration', () => {
  test('casts non-string keys to string', async ({ page }) => {
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

      // Test with number key
      await instance.setItem(537.35737, 'goodness!');
      const numberKeyValue = await instance.getItem(537.35737);

      // Test with null key
      await instance.setItem(null, 'null-value');
      const nullKeyValue = await instance.getItem(null);

      // Test with undefined key
      await instance.setItem(undefined, 'undefined-value');
      const undefinedKeyValue = await instance.getItem(undefined);

      const length = await instance.length();

      return { numberKeyValue, nullKeyValue, undefinedKeyValue, length };
    }, randomStoreName('key-casting'));

    expect(result.numberKeyValue).toBe('goodness!');
    expect(result.nullKeyValue).toBe('null-value');
    expect(result.undefinedKeyValue).toBe('undefined-value');
    expect(result.length).toBe(3);
  });
});

test.describe('localspace error handling', () => {
  test('handles clear within getItem gracefully', async ({ page }) => {
    await ensureFixtureReady(page);

    const value = await page.evaluate(async (storeName) => {
      const localspace = (window as any).localspace;
      const instance = localspace.createInstance({
        name: 'playwright-suite',
        storeName,
      });

      await instance.setDriver([instance.LOCALSTORAGE]);
      await instance.ready();
      await instance.clear();

      await instance.setItem('hello', 'Hello World!');
      await instance.clear();
      return instance.getItem('hello');
    }, randomStoreName('nested-clear'));

    expect(value).toBe(null);
  });
});
