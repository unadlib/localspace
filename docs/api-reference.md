# API Reference

Complete reference for all localspace methods with TypeScript signatures.

## Core Methods

### `getItem<T>(key: string): Promise<T | null>`

Retrieves an item from storage.

```ts
// Basic usage
const user = await localspace.getItem<User>('user');

// Returns null for non-existent keys
const missing = await localspace.getItem('nonexistent'); // null
```

### `setItem<T>(key: string, value: T): Promise<T>`

Stores an item. Returns the stored value.

```ts
// Basic usage
await localspace.setItem('user', { name: 'Ada', role: 'admin' });

// Store various types
await localspace.setItem('count', 42);
await localspace.setItem('tags', ['a', 'b', 'c']);
await localspace.setItem('active', true);
await localspace.setItem('config', null);

// undefined is converted to null
await localspace.setItem('empty', undefined); // stored as null
```

### `removeItem(key: string): Promise<void>`

Removes an item from storage.

```ts
await localspace.removeItem('user');
```

### `clear(): Promise<void>`

Removes all items from the current store.

```ts
await localspace.clear();
```

### `length(): Promise<number>`

Returns the number of items in the store.

```ts
const count = await localspace.length();
console.log(`Store has ${count} items`);
```

### `key(index: number): Promise<string | null>`

Returns the key at the given index.

```ts
const firstKey = await localspace.key(0);
const lastKey = await localspace.key((await localspace.length()) - 1);
```

### `keys(): Promise<string[]>`

Returns all keys in the store.

```ts
const allKeys = await localspace.keys();
console.log('Keys:', allKeys);
```

### `iterate<T, U>(iterator: (value: T, key: string, index: number) => U): Promise<U>`

Iterates over all items. Return a non-undefined value to stop early.

```ts
// Process all items
await localspace.iterate<User, void>((value, key, index) => {
  console.log(`${index}. ${key}:`, value);
});

// Early termination - find first admin
const admin = await localspace.iterate<User, User>((value, key) => {
  if (value.role === 'admin') {
    return value; // stops iteration and returns this value
  }
});
```

---

## Batch Operations

Each batch chunk executes in a transaction on IndexedDB. When `maxBatchSize` is
unset, the entire call is one chunk. Other drivers expose the same API but may
run grouped work sequentially.

### `setItems<T>(entries: BatchItems<T>): Promise<BatchResponse<T>>`

Stores multiple items atomically on IndexedDB when `maxBatchSize` is unset or
the input fits in one chunk. On other drivers this is a grouped operation with
driver-specific atomicity.

```ts
// Array format
await localspace.setItems([
  { key: 'user:1', value: { name: 'Ada' } },
  { key: 'user:2', value: { name: 'Grace' } },
]);

// Map format
await localspace.setItems(
  new Map([
    ['user:1', { name: 'Ada' }],
    ['user:2', { name: 'Grace' }],
  ])
);

// Object format
await localspace.setItems({
  'user:1': { name: 'Ada' },
  'user:2': { name: 'Grace' },
});

// Returns array of { key, value } pairs
const result = await localspace.setItems([
  { key: 'a', value: 1 },
  { key: 'b', value: 2 },
]);
// [{ key: 'a', value: 1 }, { key: 'b', value: 2 }]
```

### `getItems<T>(keys: string[]): Promise<BatchResponse<T>>`

Retrieves multiple items in order.

```ts
const users = await localspace.getItems(['user:1', 'user:2', 'user:3']);
// [
//   { key: 'user:1', value: { name: 'Ada' } },
//   { key: 'user:2', value: { name: 'Grace' } },
//   { key: 'user:3', value: null }  // doesn't exist
// ]

// Access values
users.forEach(({ key, value }) => {
  if (value) console.log(key, value);
});
```

### `removeItems(keys: string[]): Promise<void>`

Removes multiple items atomically on IndexedDB when `maxBatchSize` is unset or
the input fits in one chunk. On other drivers this is a grouped operation with
driver-specific atomicity.

```ts
await localspace.removeItems(['user:1', 'user:2', 'temp:session']);
```

---

## Transaction API

### `runTransaction<T>(mode: 'readonly' | 'readwrite', runner: (scope: TransactionScope) => Promise<T> | T): Promise<T>`

Executes multiple operations in a single transaction.
IndexedDB provides native atomic transactions. The memory driver provides
snapshot rollback semantics. localStorage and React Native AsyncStorage reject
this method with `UNSUPPORTED_OPERATION` because they cannot provide a real
transaction.

```ts
// Atomic counter increment on IndexedDB
const newValue = await localspace.runTransaction('readwrite', async (tx) => {
  const current = (await tx.get<number>('counter')) ?? 0;
  const next = current + 1;
  await tx.set('counter', next);
  return next;
});

// Read multiple values consistently
const snapshot = await localspace.runTransaction('readonly', async (tx) => {
  const user = await tx.get<User>('user');
  const settings = await tx.get<Settings>('settings');
  return { user, settings };
});

// Transaction scope methods:
// tx.get<T>(key) - read a value
// tx.set<T>(key, value) - write a value (readwrite only)
// tx.remove(key) - delete a value (readwrite only)
// tx.keys() - get all keys
// tx.iterate(fn) - iterate all items
// tx.clear() - clear all items (readwrite only)
```

---

## Configuration Methods

### `config(): LocalSpaceConfig`

Returns current configuration.

```ts
const config = localspace.config();
console.log(config.name, config.storeName);
```

### `config<K>(key: K): LocalSpaceConfig[K]`

Returns a specific configuration value.

```ts
const name = localspace.config('name');
const driver = localspace.config('driver');
```

### `config(options: LocalSpaceConfig): true | Error | Promise<void>`

Updates configuration. Must be called before the first storage operation.
Configuration without `driver` returns synchronously. Supplying `driver`
returns the `setDriver()` promise, while invalid or locked configuration is
returned as an `Error` value.

> **Note:** validation and lock errors are **returned, not thrown or
> rejected** (a localForage-compatible contract). This means
> `await localspace.config({ version: 'bad' })` resolves to an `Error`
> object rather than rejecting, so a `try/catch` will not catch it. Inspect
> the return value when you pass options that can fail. Only the `driver`
> form returns a real promise.

```ts
localspace.config({
  name: 'myapp',
  storeName: 'data',
  version: 2,
});

// Non-driver config: check the return value, do not rely on try/catch.
const result = localspace.config({ version: 2 });
if (result instanceof Error) {
  // handle invalid/locked configuration
}

// Only the driver form returns a promise you can await.
await localspace.config({
  driver: [localspace.INDEXEDDB, localspace.LOCALSTORAGE],
});
```

### `createInstance(options?: LocalSpaceOptions): LocalSpaceInstance`

Creates a new independent instance.

```ts
const cache = localspace.createInstance({
  name: 'cache',
  storeName: 'api-responses',
  plugins: [ttlPlugin({ defaultTTL: 60_000 })],
});
```

### `ready(): Promise<void>`

Waits for driver initialization to complete.

```ts
await localspace.ready();
console.log('Driver ready:', localspace.driver());
```

---

## Driver Methods

### `driver(): string | null`

Returns the current driver name.

```ts
const driverName = localspace.driver();
// 'asyncStorage' | 'localStorageWrapper'
```

### `setDriver(drivers: string | string[]): Promise<void>`

Sets the driver(s) to use with fallback order.

```ts
// Single driver
await localspace.setDriver(localspace.INDEXEDDB);

// With fallback
await localspace.setDriver([localspace.INDEXEDDB, localspace.LOCALSTORAGE]);

// Runtime-only fallback when persistent browser storage is blocked
await localspace.setDriver([
  localspace.INDEXEDDB,
  localspace.LOCALSTORAGE,
  localspace.MEMORY,
]);
```

`localspace.MEMORY` uses the built-in in-memory driver
(`'memoryStorageWrapper'`). It is shared by `name`/`storeName` during the current
page lifetime, supports the full storage API, and loses data on reload. It is
opt-in and is not included in the default driver order.

### `supports(driverName: string): boolean`

Checks if a driver is supported.

```ts
if (localspace.supports(localspace.INDEXEDDB)) {
  console.log('IndexedDB is available');
}
```

React Native AsyncStorage is opt-in from a separate entry:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import localspace from 'localspace';
import { createReactNativeInstance } from 'localspace/react-native';

const store = await createReactNativeInstance(localspace, {
  name: 'myapp',
  storeName: 'kv',
  reactNativeAsyncStorage: AsyncStorage,
});
```

For existing instances, use:

```ts
import localspace from 'localspace';
import { installReactNativeAsyncStorageDriver } from 'localspace/react-native';

await installReactNativeAsyncStorageDriver(localspace);
await localspace.setDriver(localspace.REACTNATIVEASYNCSTORAGE);
```

Integration smoke test harness (official AsyncStorage Jest mock) lives in `integration/react-native-jest/`.
Real device-runtime template (Detox on simulator/emulator) lives in `integration/react-native-detox/` with CI workflow `.github/workflows/detox-mobile.yml`.

### `defineDriver(driver: Driver): Promise<void>`

Registers a custom driver.

```ts
import localspace, { type Driver } from 'localspace';

const values = new Map<string, unknown>();
const customDriver: Driver = {
  _driver: 'customDriver',
  _initStorage: async () => undefined,
  getItem: async <T>(key: string) =>
    values.has(key) ? (values.get(key) as T) : null,
  setItem: async <T>(key: string, value: T) => {
    values.set(key, value);
    return value;
  },
  removeItem: async (key) => {
    values.delete(key);
  },
  clear: async () => {
    values.clear();
  },
  length: async () => values.size,
  key: async (index) => [...values.keys()][index] ?? null,
  keys: async () => [...values.keys()],
  iterate: async <T, U>(iterator: (value: T, key: string, n: number) => U) => {
    let iteration = 1;
    for (const [key, value] of values) {
      const result = iterator(value as T, key, iteration++);
      if (result !== undefined) return result;
    }
    return undefined as U;
  },
};

await localspace.defineDriver(customDriver);
await localspace.setDriver('customDriver');
```

`_support`, batch methods, `runTransaction()`, and `dropInstance()` are optional
driver capabilities. Calling an omitted capability through a selected instance
rejects with `UNSUPPORTED_OPERATION`.

### `getDriver(driverName: string): Promise<Driver>`

Returns a registered driver by name.

```ts
const idbDriver = await localspace.getDriver(localspace.INDEXEDDB);
```

Built-in web driver exports are also available:

```ts
import { indexedDBDriver, localStorageDriver, memoryDriver } from 'localspace';
```

### `dropInstance(options?: LocalSpaceConfig): Promise<void>`

Deletes the database or specific store.

```ts
// Drop current instance's store
await localspace.dropInstance();

// Drop specific store
await localspace.dropInstance({
  name: 'myapp',
  storeName: 'temp-data',
});

// Drop entire database (all stores)
await localspace.dropInstance({
  name: 'myapp',
  // omit storeName to drop entire DB
});
```

---

## Plugin Methods

### `use(plugin: LocalSpacePlugin | LocalSpacePlugin[]): LocalSpaceInstance`

Registers plugins after instance creation.

```ts
const store = localspace.createInstance({ name: 'mystore' });
store.use(ttlPlugin({ defaultTTL: 60_000 }));
store.use([compressionPlugin(), encryptionPlugin({ key: myKey })]);
```

### `destroy(): Promise<void>`

Tears down plugins and releases resources.

```ts
// Always call when disposing an instance with plugins
await store.destroy();
```

## Configuration Options

Full `LocalSpaceConfig` interface:

```ts
interface LocalSpaceConfig {
  // Database configuration
  name?: string; // Database name (default: 'localforage')
  storeName?: string; // Store/table name (default: 'keyvaluepairs')
  version?: number; // Database version (default: 1.0)
  description?: string; // Database description

  // Driver configuration
  driver?: string | string[]; // Driver(s) to use
  // Built-ins: localspace.INDEXEDDB, localspace.LOCALSTORAGE, localspace.MEMORY
  reactNativeAsyncStorage?: ReactNativeAsyncStorage; // Optional adapter used by the react-native driver

  // IndexedDB specific
  durability?: 'relaxed' | 'strict'; // Transaction durability hint
  bucket?: {
    // Storage Buckets API (Chromium 122+)
    name: string;
    durability?: 'relaxed' | 'strict';
    persisted?: boolean;
  };
  prewarmTransactions?: boolean; // Pre-warm connection (default: true)
  connectionIdleMs?: number; // Auto-close idle connections
  maxConcurrentTransactions?: number; // Throttle concurrent transactions

  // Batch operations
  maxBatchSize?: number; // Split large batches into chunks

  // Plugin configuration
  pluginInitPolicy?: 'fail' | 'disable-and-continue';
  pluginErrorPolicy?: 'strict' | 'lenient';
}
```

> **Default database name.** When `name`/`storeName` are omitted, localspace
> uses `'localforage'` / `'keyvaluepairs'`. This is intentional: it lets an app
> migrating from localForage read its existing data with no rewrite (the
> serializer and key layout are compatible). Set `name` and `storeName`
> explicitly for a fresh, app-owned namespace.
