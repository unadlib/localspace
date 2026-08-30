import { afterEach, describe, expect, it, vi } from 'vitest';
import localspace, { indexedDBDriver, type Driver } from '../src';
import type { DbInfo } from '../src/types';

type IndexedDbTestHooks = {
  getDbContext(dbInfo: DbInfo):
    | {
        forages: unknown[];
        dbReady: Promise<void> | null;
      }
    | undefined;
};

const testHooks = (indexedDBDriver as Driver & { __test__: IndexedDbTestHooks })
  .__test__;

const uniqueName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const installStorageBuckets = (open: (...args: unknown[]) => unknown) => {
  const target = navigator as Navigator & {
    storageBuckets?: { open: (...args: unknown[]) => unknown };
  };
  const descriptor = Object.getOwnPropertyDescriptor(target, 'storageBuckets');
  Object.defineProperty(target, 'storageBuckets', {
    configurable: true,
    value: { open },
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(target, 'storageBuckets', descriptor);
    } else {
      delete target.storageBuckets;
    }
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndexedDB shared context lifecycle', () => {
  it('does not retain duplicate registrations across driver switches', async () => {
    const name = uniqueName('context-driver-switch');
    const instance = localspace.createInstance({
      name,
      storeName: 'store',
    });
    await instance.setDriver([instance.INDEXEDDB]);
    await instance.setItem('persisted', 'value');
    const firstDbInfo = instance._dbInfo!;
    const firstSession = testHooks.getDbContext(firstDbInfo)?.forages[0];
    expect(firstSession).toBeDefined();
    expect(firstSession).not.toBe(instance);

    await instance.setDriver([instance.MEMORY]);
    await instance.ready();
    expect(testHooks.getDbContext(firstDbInfo)).toBeUndefined();

    await instance.setDriver([instance.INDEXEDDB]);
    await instance.ready();
    await instance.setDriver([instance.INDEXEDDB]);
    await instance.ready();

    const currentDbInfo = instance._dbInfo!;
    const currentSessions = testHooks.getDbContext(currentDbInfo)?.forages;
    expect(currentSessions).toHaveLength(1);
    expect(currentSessions?.[0]).not.toBe(instance);
    expect(currentSessions?.[0]).not.toBe(firstSession);
    await expect(instance.getItem('persisted')).resolves.toBe('value');
    await instance.dropInstance();
    await instance.close();
  });

  it('removes only the closed instance from a shared context', async () => {
    const name = uniqueName('shared-close');
    const first = localspace.createInstance({
      name,
      storeName: 'store',
    });
    const second = localspace.createInstance({
      name,
      storeName: 'store',
    });
    await first.setDriver([first.INDEXEDDB]);
    await second.setDriver([second.INDEXEDDB]);
    await first.ready();
    await second.ready();

    const dbInfo = first._dbInfo!;
    const sessions = testHooks.getDbContext(dbInfo)?.forages.slice() ?? [];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(first);
    expect(sessions[1]).not.toBe(second);
    expect(sessions[0]).not.toBe(sessions[1]);

    await first.close();
    expect(testHooks.getDbContext(dbInfo)?.forages).toEqual([sessions[1]]);
    await second.setItem('key', 'value');
    await expect(second.getItem('key')).resolves.toBe('value');

    await second.close();
    await vi.waitFor(() => {
      expect(testHooks.getDbContext(dbInfo)).toBeUndefined();
    });

    const cleanup = localspace.createInstance({ name, storeName: 'store' });
    await cleanup.setDriver([cleanup.INDEXEDDB]);
    await cleanup.dropInstance();
    await cleanup.close();
  });

  it('keeps live registrations after dropping a shared database', async () => {
    const name = uniqueName('shared-drop');
    const first = localspace.createInstance({
      name,
      storeName: 'store',
    });
    const second = localspace.createInstance({
      name,
      storeName: 'store',
    });
    await first.setDriver([first.INDEXEDDB]);
    await second.setDriver([second.INDEXEDDB]);
    await first.ready();
    await second.ready();

    const dbInfo = first._dbInfo!;
    const context = testHooks.getDbContext(dbInfo);
    const sessions = context?.forages.slice() ?? [];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(first);
    expect(sessions[1]).not.toBe(second);

    await first.dropInstance({ name });
    expect(testHooks.getDbContext(dbInfo)).toBe(context);
    expect(context?.forages).toEqual(sessions);

    await first.setItem('first', 'one');
    expect(first._dbInfo?.db).toBe(second._dbInfo?.db);
    await second.setItem('second', 'two');
    await expect(first.getItem('second')).resolves.toBe('two');
    await expect(second.getItem('first')).resolves.toBe('one');

    await first.close();
    expect(testHooks.getDbContext(dbInfo)?.forages).toEqual([sessions[1]]);

    const secondDbInfo = second._dbInfo!;
    await second.dropInstance({ name });
    await second.close();
    expect(testHooks.getDbContext(secondDbInfo)).toBeUndefined();
  });

  it('rejects a failed bucket open without falling back to another driver', async () => {
    const restoreBuckets = installStorageBuckets(async () => {
      throw new Error('bucket unavailable');
    });
    const name = uniqueName('bucket-open-failure');
    const bucketInstance = localspace.createInstance({
      name,
      storeName: 'store',
      bucket: { name: 'requested-bucket' },
      driver: [localspace.INDEXEDDB, localspace.LOCALSTORAGE],
    });
    const defaultOpen = vi.spyOn(indexedDB, 'open');

    try {
      await expect(bucketInstance.ready()).rejects.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        details: {
          bucketName: 'requested-bucket',
          operation: 'initialize',
          reason: 'storage-bucket-open-failed',
        },
      });
      expect(defaultOpen).not.toHaveBeenCalled();
      expect(bucketInstance.driver()).toBe(bucketInstance.INDEXEDDB);
    } finally {
      await bucketInstance.close();
      restoreBuckets();
    }
  });

  it('rejects when the Storage Buckets API is unavailable', async () => {
    const target = navigator as Navigator & { storageBuckets?: unknown };
    const descriptor = Object.getOwnPropertyDescriptor(
      target,
      'storageBuckets'
    );
    delete target.storageBuckets;
    const instance = localspace.createInstance({
      name: uniqueName('bucket-api-unavailable'),
      storeName: 'store',
      bucket: { name: 'requested-bucket' },
      driver: [localspace.INDEXEDDB, localspace.LOCALSTORAGE],
    });
    const defaultOpen = vi.spyOn(indexedDB, 'open');

    try {
      await expect(instance.ready()).rejects.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        details: {
          reason: 'storage-buckets-unavailable',
        },
      });
      expect(defaultOpen).not.toHaveBeenCalled();
    } finally {
      await instance.close();
      if (descriptor) {
        Object.defineProperty(target, 'storageBuckets', descriptor);
      }
    }
  });

  it('rejects a bucket that does not expose IndexedDB', async () => {
    const restoreBuckets = installStorageBuckets(async () => ({}));
    const instance = localspace.createInstance({
      name: uniqueName('bucket-without-indexeddb'),
      storeName: 'store',
      bucket: { name: 'requested-bucket' },
      driver: [localspace.INDEXEDDB, localspace.LOCALSTORAGE],
    });
    const defaultOpen = vi.spyOn(indexedDB, 'open');

    try {
      await expect(instance.ready()).rejects.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        details: {
          reason: 'storage-bucket-indexeddb-unavailable',
        },
      });
      expect(defaultOpen).not.toHaveBeenCalled();
    } finally {
      await instance.close();
      restoreBuckets();
    }
  });

  it('rejects the matching bucket readiness when object-store drop fails', async () => {
    const restoreBuckets = installStorageBuckets(async () => ({
      indexedDB,
    }));
    const name = uniqueName('bucket-drop-readiness');
    const instance = localspace.createInstance({
      name,
      storeName: 'store',
      bucket: { name: 'working-bucket' },
    });

    try {
      await instance.setDriver([instance.INDEXEDDB]);
      await instance.setItem('key', 'value');
      const dbInfo = instance._dbInfo!;
      let requestCreated!: () => void;
      const created = new Promise<void>((resolve) => {
        requestCreated = resolve;
      });
      const openError = new DOMException('upgrade failed', 'UnknownError');
      const request = {
        error: openError,
        result: null,
        onerror: null as ((event: Event) => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
      };
      vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
        requestCreated();
        setTimeout(() => request.onerror?.(new Event('error')), 0);
        return request as unknown as IDBOpenDBRequest;
      });

      const dropping = instance.dropInstance({ name, storeName: 'store' });
      await created;
      const context = testHooks.getDbContext(dbInfo)!;
      const readinessResult = context.dbReady!.catch((error) => error);

      await expect(dropping).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
        details: { operation: 'dropInstance' },
      });
      await expect(readinessResult).resolves.toBe(openError);
    } finally {
      await instance.close();
      restoreBuckets();
    }

    const cleanup = localspace.createInstance({ name, storeName: 'store' });
    await cleanup.setDriver([cleanup.INDEXEDDB]);
    await cleanup.dropInstance();
    await cleanup.close();
  });
});
