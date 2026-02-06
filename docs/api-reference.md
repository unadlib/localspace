# API Reference

Complete reference for all localspace methods with TypeScript signatures.

## Core Methods

### `getItem<T>(key: string, callback?: Callback<T>): Promise<T | null>`

Retrieves an item from storage.

```ts
// Basic usage
const user = await localspace.getItem<User>('user');

// With callback
localspace.getItem('user', (err, value) => {
  if (err) return console.error(err);
  console.log(value);
});

// Returns null for non-existent keys
const missing = await localspace.getItem('nonexistent'); // null
```

### `setItem<T>(key: string, value: T, callback?: Callback<T>): Promise<T>`

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

### `removeItem(key: string, callback?: Callback<void>): Promise<void>`

Removes an item from storage.

```ts
await localspace.removeItem('user');
```

### `clear(callback?: Callback<void>): Promise<void>`

Removes all items from the current store.

```ts
await localspace.clear();
```

### `length(callback?: Callback<number>): Promise<number>`

Returns the number of items in the store.

```ts
const count = await localspace.length();
console.log(`Store has ${count} items`);
```

### `key(index: number, callback?: Callback<string>): Promise<string | null>`

Returns the key at the given index.

```ts
const firstKey = await localspace.key(0);
const lastKey = await localspace.key((await localspace.length()) - 1);
```

### `keys(callback?: Callback<string[]>): Promise<string[]>`

Returns all keys in the store.

```ts
const allKeys = await localspace.keys();
console.log('Keys:', allKeys);
```

### `iterate<T, U>(iterator: (value: T, key: string, index: number) => U, callback?: Callback<U>): Promise<U>`

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

Batch operations execute in a single transaction (IndexedDB) for better performance.

### `setItems<T>(entries: BatchItems<T>, callback?: Callback<BatchResponse<T>>): Promise<BatchResponse<T>>`

Stores multiple items atomically.

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

### `getItems<T>(keys: string[], callback?: Callback<BatchResponse<T>>): Promise<BatchResponse<T>>`

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

### `removeItems(keys: string[], callback?: Callback<void>): Promise<void>`

Removes multiple items atomically.

```ts
await localspace.removeItems(['user:1', 'user:2', 'temp:session']);
```

---

## Transaction API

### `runTransaction<T>(mode: 'readonly' | 'readwrite', runner: (scope: TransactionScope) => Promise<T> | T, callback?: Callback<T>): Promise<T>`

Executes multiple operations in a single transaction.

```ts
// Atomic counter increment
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

### `config(options: LocalSpaceConfig): true | Error`

Updates configuration. Must be called before first storage operation.

```ts
localspace.config({
  name: 'myapp',
  storeName: 'data',
  version: 2,
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

### `ready(callback?: Callback<void>): Promise<void>`

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

### `setDriver(drivers: string | string[], callback?, errorCallback?): Promise<void>`

Sets the driver(s) to use with fallback order.

```ts
// Single driver
await localspace.setDriver(localspace.INDEXEDDB);

// With fallback
await localspace.setDriver([localspace.INDEXEDDB, localspace.LOCALSTORAGE]);
```

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

### `defineDriver(driver: Driver, callback?, errorCallback?): Promise<void>`

Registers a custom driver.

```ts
const customDriver: Driver = {
  _driver: 'customDriver',
  _support: true,
  _initStorage: async (config) => {
    /* ... */
  },
  getItem: async (key) => {
    /* ... */
  },
  setItem: async (key, value) => {
    /* ... */
  },
  removeItem: async (key) => {
    /* ... */
  },
  clear: async () => {
    /* ... */
  },
  length: async () => {
    /* ... */
  },
  key: async (index) => {
    /* ... */
  },
  keys: async () => {
    /* ... */
  },
  iterate: async (iterator) => {
    /* ... */
  },
};

await localspace.defineDriver(customDriver);
await localspace.setDriver('customDriver');
```

### `getDriver(driverName: string): Promise<Driver>`

Returns a registered driver by name.

```ts
const idbDriver = await localspace.getDriver(localspace.INDEXEDDB);
```

### `dropInstance(options?: LocalSpaceConfig, callback?: Callback<void>): Promise<void>`

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

### `getPerformanceStats(): PerformanceStats` (IndexedDB only)

Returns write coalescing statistics.

```ts
const stats = localspace.getPerformanceStats?.();
// {
//   totalWrites: 150,
//   coalescedWrites: 120,
//   transactionsSaved: 100,
//   avgCoalesceSize: 4.8
// }
```

---

## Configuration Options

Full `LocalSpaceConfig` interface:

```ts
interface LocalSpaceConfig {
  // Database configuration
  name?: string; // Database name (default: 'localforage')
  storeName?: string; // Store/table name (default: 'keyvaluepairs')
  version?: number; // Database version (default: 1.0)
  description?: string; // Database description
  size?: number; // Database size hint

  // Driver configuration
  driver?: string | string[]; // Driver(s) to use
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

  // Write coalescing (IndexedDB only)
  coalesceWrites?: boolean; // Enable write merging (default: false)
  coalesceWindowMs?: number; // Merge window in ms (default: 8)
  coalesceMaxBatchSize?: number; // Max ops per flush
  coalesceReadConsistency?: 'strong' | 'eventual'; // Read behavior
  coalesceFireAndForget?: boolean; // Resolve immediately in eventual mode

  // Compatibility
  compatibilityMode?: boolean; // Legacy callback style for driver methods

  // Plugin configuration
  pluginInitPolicy?: 'fail' | 'disable-and-continue';
  pluginErrorPolicy?: 'strict' | 'lenient';
}
```
