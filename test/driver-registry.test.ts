import { describe, expect, it } from 'vitest';
import {
  LocalSpace,
  registerDriver,
  type Driver,
  type LocalSpaceConfig,
  type LocalSpaceInstance,
} from '../src/index';

type SessionReceiver = LocalSpaceInstance & {
  sessionValues: Map<string, unknown>;
  sessionToken: symbol;
};

type ReceiverLog = {
  initialized: SessionReceiver[];
  operated: SessionReceiver[];
  closed: SessionReceiver[];
};

const uniqueDriverName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}`;

const createSessionDriver = (
  name: string,
  receivers: ReceiverLog = {
    initialized: [],
    operated: [],
    closed: [],
  }
): Driver =>
  ({
    _driver: name,
    _support: true,
    async _initStorage(
      this: SessionReceiver,
      config: LocalSpaceConfig
    ): Promise<void> {
      this.sessionValues = new Map();
      this.sessionToken = Symbol(config.name);
      receivers.initialized.push(this);
    },
    async _closeStorage(this: SessionReceiver): Promise<void> {
      receivers.closed.push(this);
    },
    async getItem<T>(this: SessionReceiver, key: string): Promise<T | null> {
      receivers.operated.push(this);
      return this.sessionValues.has(key)
        ? (this.sessionValues.get(key) as T)
        : null;
    },
    async setItem<T>(this: SessionReceiver, key: string, value: T): Promise<T> {
      receivers.operated.push(this);
      this.sessionValues.set(key, value);
      return value;
    },
    async removeItem(this: SessionReceiver, key: string): Promise<void> {
      receivers.operated.push(this);
      this.sessionValues.delete(key);
    },
    async clear(this: SessionReceiver): Promise<void> {
      receivers.operated.push(this);
      this.sessionValues.clear();
    },
    async length(this: SessionReceiver): Promise<number> {
      receivers.operated.push(this);
      return this.sessionValues.size;
    },
    async key(this: SessionReceiver, index: number): Promise<string | null> {
      receivers.operated.push(this);
      return [...this.sessionValues.keys()][index] ?? null;
    },
    async keys(this: SessionReceiver): Promise<string[]> {
      receivers.operated.push(this);
      return [...this.sessionValues.keys()];
    },
    async iterate<T, U>(
      this: SessionReceiver,
      iterator: (value: T, key: string, iterationNumber: number) => U
    ): Promise<U | undefined> {
      receivers.operated.push(this);
      let iteration = 1;
      for (const [key, value] of this.sessionValues) {
        const result = iterator(value as T, key, iteration++);
        if (result !== undefined) return result;
      }
      return undefined;
    },
  }) as Driver;

describe('driver registry and sessions', () => {
  it('keeps construction-scoped drivers isolated to their instance', async () => {
    const driverName = uniqueDriverName('construction-scope');
    const driver = createSessionDriver(driverName);
    const scoped = new LocalSpace({
      name: uniqueDriverName('scoped-store'),
      driver: driverName,
      drivers: [driver],
    });
    const unrelated = new LocalSpace();

    await scoped.ready();
    await expect(scoped.setItem('key', 'scoped')).resolves.toBe('scoped');
    await expect(unrelated.getDriver(driverName)).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
      details: { driver: driverName },
    });

    await scoped.close();
    await unrelated.close();
  });

  it('makes explicit registration realm-wide and protects duplicate names', async () => {
    const driverName = uniqueDriverName('global-scope');
    const existing = new LocalSpace();
    await existing.ready();

    const driver = createSessionDriver(driverName);
    await registerDriver(driver);

    const later = new LocalSpace({ driver: driverName });
    await existing.setDriver(driverName);
    await later.ready();
    await expect(existing.setItem('existing', true)).resolves.toBe(true);
    await expect(later.setItem('later', true)).resolves.toBe(true);

    await expect(
      registerDriver(createSessionDriver(driverName))
    ).rejects.toMatchObject({
      code: 'DRIVER_COMPLIANCE',
      details: { driver: driverName, reason: 'duplicate-driver' },
    });

    const replacement = createSessionDriver(driverName);
    await expect(
      registerDriver(replacement, { overwrite: true })
    ).resolves.toBeUndefined();
    const observer = new LocalSpace();
    const replacementSnapshot = await observer.getDriver(driverName);
    expect(replacementSnapshot).toMatchObject({ _driver: driverName });

    const supportError = new Error('replacement support failed');
    await expect(
      registerDriver(
        {
          ...createSessionDriver(driverName),
          _support: async () => {
            throw supportError;
          },
        },
        { overwrite: true }
      )
    ).rejects.toBe(supportError);
    await expect(observer.getDriver(driverName)).resolves.toBe(
      replacementSnapshot
    );

    await existing.close();
    await later.close();
    await observer.close();
  });

  it('snapshots and freezes definitions without changing caller-owned objects', async () => {
    const driverName = uniqueDriverName('immutable-definition');
    const driver = createSessionDriver(driverName) as Driver &
      Record<PropertyKey, unknown>;
    const metadata = Symbol('metadata');
    Object.defineProperty(driver, 'nonEnumerableMetadata', {
      configurable: true,
      enumerable: false,
      value: 'kept',
      writable: true,
    });
    driver[metadata] = 'symbol-value';
    const originalSetItem = driver.setItem;
    const originalKeys = Reflect.ownKeys(driver);
    const originalDescriptors = Object.getOwnPropertyDescriptors(driver);

    const instance = new LocalSpace({
      driver: driverName,
      drivers: [driver],
    });
    await instance.ready();
    await expect(
      instance.setItems([{ key: 'missing', value: true }])
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: { driver: driverName, operation: 'setItems' },
    });

    expect(Reflect.ownKeys(driver)).toEqual(originalKeys);
    expect(Object.getOwnPropertyDescriptors(driver)).toEqual(
      originalDescriptors
    );
    expect(Object.hasOwn(driver, 'setItems')).toBe(false);
    expect(Object.isFrozen(driver)).toBe(false);

    const snapshot = await instance.getDriver(driverName);
    expect(snapshot).not.toBe(driver);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(snapshot, 'nonEnumerableMetadata')
    ).toEqual({
      configurable: false,
      enumerable: false,
      value: 'kept',
      writable: false,
    });
    expect((snapshot as Driver & Record<PropertyKey, unknown>)[metadata]).toBe(
      'symbol-value'
    );

    driver.setItem = async <T>(_key: string, value: T) => value;
    expect(snapshot.setItem).toBe(originalSetItem);
    await expect(instance.setItem('key', 'snapshotted')).resolves.toBe(
      'snapshotted'
    );
    await expect(instance.getItem('key')).resolves.toBe('snapshotted');

    await instance.close();
  });

  it('detaches inherited driver members from later prototype mutation', async () => {
    const driverName = uniqueDriverName('prototype-definition');
    const driver = createSessionDriver(driverName);
    const originalSetItem = driver.setItem;
    const prototype = Object.create(Object.getPrototypeOf(driver), {
      setItem: {
        configurable: true,
        enumerable: false,
        value: originalSetItem,
        writable: true,
      },
      inheritedMetadata: {
        configurable: true,
        enumerable: false,
        value: 'original',
        writable: true,
      },
    }) as {
      setItem: Driver['setItem'];
      inheritedMetadata: string;
    };
    delete (driver as Partial<Driver>).setItem;
    Object.setPrototypeOf(driver, prototype);

    const instance = new LocalSpace({ driver: driverName, drivers: [driver] });
    prototype.setItem = async () => {
      throw new Error('mutated prototype method must not be observed');
    };
    prototype.inheritedMetadata = 'mutated';

    await instance.ready();
    await expect(instance.setItem('key', 'value')).resolves.toBe('value');
    await expect(instance.getItem('key')).resolves.toBe('value');

    const snapshot = (await instance.getDriver(driverName)) as Readonly<
      Driver & { inheritedMetadata: string }
    >;
    expect(snapshot.setItem).toBe(originalSetItem);
    expect(snapshot.inheritedMetadata).toBe('original');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(snapshot, 'setItem')?.enumerable
    ).toBe(false);

    await instance.close();
  });

  it('gives each instance a private stable receiver for one selected session', async () => {
    const driverName = uniqueDriverName('session-receiver');
    const receivers: ReceiverLog = {
      initialized: [],
      operated: [],
      closed: [],
    };
    const driver = createSessionDriver(driverName, receivers);
    const first = new LocalSpace({ driver: driverName, drivers: [driver] });
    const second = new LocalSpace({ driver: driverName, drivers: [driver] });

    await first.ready();
    await second.ready();
    await first.setItem('same-key', 'first');
    await second.setItem('same-key', 'second');
    await expect(first.getItem('same-key')).resolves.toBe('first');
    await expect(second.getItem('same-key')).resolves.toBe('second');

    expect(receivers.initialized).toHaveLength(2);
    const [firstSession, secondSession] = receivers.initialized;
    expect(firstSession).not.toBe(secondSession);
    expect(firstSession).not.toBe(first);
    expect(secondSession).not.toBe(second);
    expect(firstSession.sessionValues).not.toBe(secondSession.sessionValues);
    expect(receivers.operated.slice(0, 4)).toEqual([
      firstSession,
      secondSession,
      firstSession,
      secondSession,
    ]);
    expect('sessionValues' in first).toBe(false);
    expect('sessionToken' in second).toBe(false);

    await first.close();
    await second.close();
    expect(receivers.closed).toEqual([firstSession, secondSession]);
  });
});
