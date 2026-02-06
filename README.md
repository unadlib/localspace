# localspace

![Node CI](https://github.com/unadlib/localspace/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/localspace.svg)](https://www.npmjs.com/package/localspace)
![license](https://img.shields.io/npm/l/localspace)

localspace — modern storage toolkit that keeps localForage compatibility while using async/await, TypeScript, and zero legacy baggage.

## Motivation

The industry still leans on localForage's familiar API, yet modern apps crave stronger typing, async ergonomics, and multi-platform reliability without a painful rewrite. localspace exists to bridge that gap: it honors the old contract while delivering first-class TypeScript types, native async/await, reliable IndexedDB cleanup, and a clean driver architecture.

**Why rebuild instead of fork?** Starting fresh let us eliminate technical debt while maintaining API compatibility. Teams can migrate from localForage without changing application code, then unlock better developer experience and future extensibility.

## Quick Start

Get started in 5 minutes:

### 1. Install

```bash
npm install localspace
# or: yarn add localspace / pnpm add localspace
```

### 2. Basic Usage

```ts
import localspace from 'localspace';

// Store and retrieve data
await localspace.setItem('user', { name: 'Ada', role: 'admin' });
const user = await localspace.getItem<{ name: string; role: string }>('user');

// TypeScript generics for type safety
interface User {
  name: string;
  role: string;
}
const typedUser = await localspace.getItem<User>('user');
```

### 3. Create Isolated Instances

```ts
const cache = localspace.createInstance({
  name: 'my-app',
  storeName: 'cache',
});

await cache.setItem('token', 'abc123');
```

### 4. Batch Operations

```ts
// Write multiple items in one transaction (IndexedDB)
await localspace.setItems([
  { key: 'user:1', value: { name: 'Ada' } },
  { key: 'user:2', value: { name: 'Grace' } },
]);

// Read multiple items
const users = await localspace.getItems(['user:1', 'user:2']);
```

### 5. Use Plugins

```ts
import localspace, { ttlPlugin, encryptionPlugin } from 'localspace';

const secureStore = localspace.createInstance({
  name: 'secure',
  plugins: [
    ttlPlugin({ defaultTTL: 60_000 }), // Auto-expire after 1 minute
    encryptionPlugin({ key: 'your-32-byte-key' }), // Encrypt data
  ],
});
```

That's it! For more details, see the sections below.

---

## Table of Contents

- [Installation](#installation)
- [Core API](#core-api)
- [Batch Operations](#batch-operations)
- [Coalesced Writes](#coalesced-writes)
- [Plugin System](#plugin-system)
- [Configuration](#configuration)
- [Performance Notes](#performance-notes)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [License](#license)

---

## Installation

```bash
npm install localspace
# or
yarn add localspace
# or
pnpm add localspace
```

```ts
import localspace from 'localspace';
```

**Bundles included:** ES modules, CommonJS, UMD, plus `.d.ts` files.

---

## Core API

### Storage Methods

```ts
// Set and get items
await localspace.setItem('key', value);
const value = await localspace.getItem<T>('key');

// Remove items
await localspace.removeItem('key');
await localspace.clear();

// Query
const count = await localspace.length();
const keys = await localspace.keys();

// Iterate
await localspace.iterate<T, void>((value, key, index) => {
  console.log(key, value);
});
```

### Callbacks (Legacy Support)

```ts
localspace.getItem('user', (error, value) => {
  if (error) return console.error(error);
  console.log(value);
});
```

### Driver Selection

```ts
// Web fallback order (default bundled drivers)
await localspace.setDriver([localspace.INDEXEDDB, localspace.LOCALSTORAGE]);

// Check current driver
console.log(localspace.driver());
// 'asyncStorage' | 'localStorageWrapper'
```

### React Native AsyncStorage

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import localspace from 'localspace';
import { createReactNativeInstance } from 'localspace/react-native';

const mobileStore = await createReactNativeInstance(localspace, {
  name: 'myapp',
  storeName: 'kv',
  reactNativeAsyncStorage: AsyncStorage,
});
```

The default `localspace` entry does not bundle the React Native driver; it is included only when importing `localspace/react-native`. Explicit `reactNativeAsyncStorage` injection is recommended.

Advanced usage is still available:

```ts
import localspace from 'localspace';
import { installReactNativeAsyncStorageDriver } from 'localspace/react-native';

await installReactNativeAsyncStorageDriver(localspace);
await localspace.setDriver(localspace.REACTNATIVEASYNCSTORAGE);
```

📖 **Full API Reference:** [docs/api-reference.md](./docs/api-reference.md)

---

## Batch Operations

Use batch APIs for better performance with IndexedDB:

```ts
// Single transaction write
await localspace.setItems([
  { key: 'user:1', value: { name: 'Ada' } },
  { key: 'user:2', value: { name: 'Lin' } },
]);

// Ordered bulk read
const result = await localspace.getItems(['user:1', 'user:2']);
// [{ key: 'user:1', value: {...} }, { key: 'user:2', value: {...} }]

// Single transaction delete
await localspace.removeItems(['user:1', 'user:2']);
```

### Transactions

For atomic multi-step operations:

```ts
await localspace.runTransaction('readwrite', async (tx) => {
  const current = (await tx.get<number>('counter')) ?? 0;
  await tx.set('counter', current + 1);
  await tx.set('lastUpdated', Date.now());
});
```

---

## Coalesced Writes

Opt-in automatic batching of rapid writes for **3-10x performance improvement**:

```ts
const store = localspace.createInstance({
  coalesceWrites: true, // Enable (default: false)
  coalesceWindowMs: 8, // 8ms merge window
});

// These are automatically batched into one transaction
await Promise.all([
  store.setItem('a', 1),
  store.setItem('b', 2),
  store.setItem('c', 3),
]);
```

**Consistency modes:**

- `'strong'` (default): Reads flush pending writes first
- `'eventual'`: Reads may see stale values briefly

```ts
// Get performance stats
const stats = localspace.getPerformanceStats?.();
// { totalWrites: 150, coalescedWrites: 120, transactionsSaved: 100 }
```

---

## Plugin System

localspace ships with a powerful plugin engine:

```ts
import localspace, {
  ttlPlugin,
  compressionPlugin,
  encryptionPlugin,
  syncPlugin,
  quotaPlugin,
} from 'localspace';

const store = localspace.createInstance({
  name: 'secure-store',
  plugins: [
    ttlPlugin({ defaultTTL: 60_000 }), // Auto-expire
    compressionPlugin({ threshold: 1024 }), // Compress > 1KB
    encryptionPlugin({ key: '32-byte-key-here' }), // Encrypt
    syncPlugin({ channelName: 'my-app' }), // Multi-tab sync
    quotaPlugin({ maxSize: 5 * 1024 * 1024 }), // 5MB limit
  ],
  pluginErrorPolicy: 'strict', // Recommended for encryption
});
```

### Built-in Plugins

| Plugin          | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| **TTL**         | Auto-expire items with `{ data, expiresAt }` wrapper |
| **Encryption**  | AES-GCM encryption via Web Crypto API                |
| **Compression** | LZ-string compression for large values               |
| **Sync**        | Multi-tab synchronization via BroadcastChannel       |
| **Quota**       | Storage limit enforcement with LRU eviction          |

📖 **Full Plugin Documentation:** [docs/plugins.md](./docs/plugins.md)
📖 **Real-World Examples:** [docs/examples.md](./docs/examples.md)

---

## Configuration

```ts
const store = localspace.createInstance({
  // Database
  name: 'myapp', // Database name
  storeName: 'data', // Store name
  version: 1, // Schema version

  // Driver
  driver: [localspace.INDEXEDDB, localspace.LOCALSTORAGE],

  // IndexedDB performance
  durability: 'relaxed', // 'relaxed' (fast) or 'strict'
  prewarmTransactions: true, // Pre-warm connection

  // Batching
  maxBatchSize: 200, // Split large batches
  coalesceWrites: false, // Merge rapid writes

  // Plugins
  plugins: [],
  pluginErrorPolicy: 'lenient', // 'strict' for encryption
});
```

```ts
// React Native one-step instance
import localspace from 'localspace';
import { createReactNativeInstance } from 'localspace/react-native';

const mobileStore = await createReactNativeInstance(localspace, {
  name: 'myapp',
  storeName: 'data',
  reactNativeAsyncStorage: AsyncStorage,
});
```

📖 **Full Configuration Options:** [docs/api-reference.md#configuration-options](./docs/api-reference.md#configuration-options)

---

## Performance Notes

- **Batch APIs outperform loops:** `setItems()` ~6x faster, `getItems()` ~7.7x faster than per-item loops
- **Coalesced writes:** 3-10x faster under write bursts (opt-in)
- **Transaction helpers:** `runTransaction()` for atomic migrations
- **IndexedDB durability:** Chrome 121+ uses relaxed durability by default
- **localStorage batches are non-atomic:** Prefer IndexedDB for atomic operations

---

## Troubleshooting

| Issue                       | Solution                                               |
| --------------------------- | ------------------------------------------------------ |
| Driver not ready            | Call `await localspace.ready()` before first operation |
| Quota errors                | Check `error.code === 'QUOTA_EXCEEDED'`                |
| Plugin errors swallowed     | Set `pluginErrorPolicy: 'strict'`                      |
| Stale reads with coalescing | Use `coalesceReadConsistency: 'strong'` (default)      |

**Errors** are `LocalSpaceError` with `code`, `details`, and `cause` properties.

---

## Compatibility

- **Browsers:** Modern Chromium/Edge, Firefox, Safari
- **Drivers:** IndexedDB (primary), localStorage
- **React Native:** AsyncStorage driver available via `localspace/react-native` opt-in entry
- **WebSQL:** Not supported (migrate to IndexedDB)
- **Node/SSR:** Custom driver required

---

## Documentation

| Document                                     | Description                           |
| -------------------------------------------- | ------------------------------------- |
| [API Reference](./docs/api-reference.md)     | Complete method documentation         |
| [Plugin System](./docs/plugins.md)           | Built-in plugins & custom development |
| [Real-World Examples](./docs/examples.md)    | Production-ready code patterns        |
| [Migration Guide](./docs/migration-guide.md) | Upgrading from localForage            |

---

## Roadmap

### Complete ✅

- [x] IndexedDB and localStorage drivers
- [x] React Native AsyncStorage driver
- [x] Full localForage API parity
- [x] TypeScript-first implementation
- [x] Batch operations & write coalescing
- [x] Plugin system (TTL, Encryption, Compression, Sync, Quota)

### Coming Soon

- [ ] OPFS driver (Origin Private File System)
- [ ] Node.js (File system, SQLite)
- [ ] React Native SQLite driver
- [ ] Deno (Native KV store)

---

## License

[MIT](./LICENSE)
