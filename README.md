# localspace

![Node CI](https://github.com/unadlib/localspace/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/localspace.svg)](https://www.npmjs.com/package/localspace)
![license](https://img.shields.io/npm/l/localspace)

localspace is a Promise-first storage toolkit for IndexedDB, localStorage, and React Native AsyncStorage, with TypeScript types and a focused plugin system.

## Motivation

localspace keeps the familiar key-value shape of localForage while making Promise semantics, explicit batching, and driver capabilities the actual contract. It adds first-class TypeScript types, IndexedDB transactions, multi-platform drivers, and a plugin architecture.

It is not a callback-compatible drop-in replacement. Existing Promise-based localForage usage is usually straightforward to migrate; callback-based code must be converted to `await` or `.then()`.

## Quick Start

Get started in 5 minutes:

### 1. Install

```bash
pnpm add localspace
# or: npm install localspace
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
- [Plugin System](#plugin-system)
- [Configuration](#configuration)
- [Performance Notes](#performance-notes)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [License](#license)

---

## Installation

```bash
pnpm add localspace
# or
npm install localspace
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

### Driver Selection

```ts
// Web fallback order (default bundled drivers)
await localspace.setDriver([localspace.INDEXEDDB, localspace.LOCALSTORAGE]);

// Check current driver
console.log(localspace.driver());
// 'asyncStorage' | 'localStorageWrapper'
```

### In-Memory Fallback

When browser persistent storage is unavailable (for example, cookies/site data are blocked), opt in to the memory driver explicitly:

```ts
await localspace.setDriver([
  localspace.INDEXEDDB,
  localspace.LOCALSTORAGE,
  localspace.MEMORY,
]);
```

The memory driver is runtime-only: data is shared by `name`/`storeName` while the page is alive and is lost on reload. It is not part of the default fallback order so persistent-storage failures remain visible unless you opt in.

### Instance Lifecycle

Dispose an isolated instance without deleting its data by calling `close()`:

```ts
const cache = localspace.createInstance({ name: 'my-app', storeName: 'cache' });
await cache.setItem('token', 'abc123');
await cache.close();
```

`close()` is idempotent. It cleans initialized plugins and releases the active driver connection; later operations reject with `INSTANCE_CLOSED`. Use `clear()` or `dropInstance()` only when stored data should be removed.

If custom-driver cleanup rejects, the instance remains closed but retains the unfinished cleanup handle; call `close()` again to retry it. Concurrent calls share one attempt, and cleanup that already succeeded is not repeated. Cleanup that rejects after `_initStorage()` fails is retained as well; a later `setDriver()` or `close()` retries it without replacing the original initialization error.

`destroy()` is deprecated and retains its legacy plugin-only behavior in 2.x. If a concurrent legacy `destroy()` has already started plugin initialization, `close()` waits for that complete initialization pass before teardown.

An in-progress built-in TTL storage sweep is allowed to finish before cleanup, and its timer is stopped before the instance is marked closed. User `onExpire` notifications started by a background sweep are not part of that barrier, so they may safely await `close()` or `destroy()` on the same instance.

Call `close()` and `setDriver()` only while the instance is idle. If a storage operation is active, they reject with `OPERATION_FAILED` and `details.reason === 'active-operations'`; await the operation and retry. This also prevents lifecycle calls made inside hooks, transaction runners, or custom drivers from waiting on themselves. `context.instance` remains the public instance with stable identity across every plugin hook. Plugin lifecycle callbacks must use the callback-scoped `context.lifecycleInstance` for same-instance calls across an async boundary; custom-driver lifecycle callbacks must use their `this` receiver. Those guarded receivers reject same-instance storage and lifecycle calls with `details.reason === 'lifecycle-reentrancy'` while the callback is pending, including across `await`. After they settle, retained receivers forward normally for later timer or event-handler work. A custom driver uses the same receiver object for its lifecycle and operation methods, so identity-keyed state remains available. Guard state is isolated per plugin lifecycle callback and per selected custom driver, so unrelated retained receivers and concurrent callers are never treated as lifecycle reentry.

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

Integration smoke (official AsyncStorage Jest mock):

```bash
pnpm test:rn:integration
```

See `integration/react-native-jest/README.md` for details.

Manual Detox smoke workflow (real simulator/emulator runtime):

- Workflow: `.github/workflows/detox-mobile.yml`
- Fixture app folder: `integration/react-native-detox/`
- Fixture README: `integration/react-native-detox/README.md`

📖 **Full API Reference:** [docs/api-reference.md](./docs/api-reference.md)

---

## Batch Operations

Use batch APIs for better performance. IndexedDB runs each batch chunk inside a transaction; when `maxBatchSize` is unset, the entire call is one chunk. Other drivers expose the same API but may perform grouped work sequentially.

```ts
// One transaction on IndexedDB when maxBatchSize is unset
await localspace.setItems([
  { key: 'user:1', value: { name: 'Ada' } },
  { key: 'user:2', value: { name: 'Lin' } },
]);

// Ordered bulk read
const result = await localspace.getItems(['user:1', 'user:2']);
// [{ key: 'user:1', value: {...} }, { key: 'user:2', value: {...} }]

// One transaction on IndexedDB when maxBatchSize is unset
await localspace.removeItems(['user:1', 'user:2']);
```

### Transactions

For atomic multi-step operations on IndexedDB:

```ts
await localspace.runTransaction('readwrite', async (tx) => {
  const current = (await tx.get<number>('counter')) ?? 0;
  await tx.set('counter', current + 1);
  await tx.set('lastUpdated', Date.now());
});
```

`runTransaction()` is supported by the IndexedDB and memory drivers. On localStorage and React Native AsyncStorage it rejects with `UNSUPPORTED_OPERATION`; use explicit operations when atomicity is unnecessary.

---

## Plugin System

localspace ships with a powerful plugin engine:

```ts
import localspace, {
  ttlPlugin,
  compressionPlugin,
  encryptionPlugin,
} from 'localspace';

const store = localspace.createInstance({
  name: 'secure-store',
  plugins: [
    ttlPlugin({ defaultTTL: 60_000 }), // Auto-expire
    compressionPlugin({ threshold: 1024 }), // Compress > 1KB
    encryptionPlugin({ key: '32-byte-key-here' }), // Encrypt
  ],
  pluginErrorPolicy: 'strict', // Fail on every plugin error
});
```

### Built-in Plugins

| Plugin          | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| **TTL**         | Auto-expire items with `{ data, expiresAt }` wrapper |
| **Encryption**  | AES-GCM encryption via Web Crypto API                |
| **Compression** | LZ-string compression for large values               |

Encryption always fails closed in 2.1, including under the default lenient plugin policy. When encryption, compression, or TTL is active, `runTransaction()` and `iterate()` reject with `UNSUPPORTED_OPERATION` rather than bypassing transformations or exposing internal payloads. Use item/batch methods; plugin-aware transactions are planned for 3.0.

Cross-context replication is intentionally not built in. For best-effort single-item notifications, adapt [`examples/broadcast-notification-plugin.ts`](./examples/broadcast-notification-plugin.ts) to your application-level synchronization protocol.

Serialized-size limits are also application policy rather than browser quota management. The non-published [`examples/size-limit-plugin.ts`](./examples/size-limit-plugin.ts) example shows a best-effort guard without automatic data eviction.

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
  // Add localspace.MEMORY explicitly for runtime-only fallback.

  // IndexedDB performance
  durability: 'relaxed', // 'relaxed' (fast) or 'strict'
  prewarmTransactions: true, // Pre-warm connection

  // Batching
  maxBatchSize: 200, // Split large batches

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

- **Batch APIs reduce per-operation overhead:** prefer `setItems()`, `getItems()`, and `removeItems()` when work belongs together
- **Transaction helpers:** `runTransaction()` is atomic on IndexedDB and rolls back on the memory driver
- **IndexedDB durability:** Chrome 121+ uses relaxed durability by default
- **Non-transactional drivers:** localStorage and React Native AsyncStorage reject `runTransaction()`
- **Benchmarks are environment-specific:** run `pnpm test:benchmark` locally; no fixed speedup is used as a correctness gate

---

## Troubleshooting

| Issue                      | Solution                                               |
| -------------------------- | ------------------------------------------------------ |
| Driver not ready           | Call `await localspace.ready()` before first operation |
| Browser storage is full    | Check `error.code === 'QUOTA_EXCEEDED'`                |
| Persistent storage blocked | Add `localspace.MEMORY` as an explicit fallback        |
| Plugin errors swallowed    | Set `pluginErrorPolicy: 'strict'`                      |
| Instance is closed         | Create a new instance; `close()` is terminal           |

**Errors** are `LocalSpaceError` with `code`, `details`, and `cause` properties.

---

## Compatibility

- **Browsers:** Modern Chromium/Edge, Firefox, Safari
- **Drivers:** IndexedDB (primary), localStorage, memory (opt-in fallback)
- **React Native:** AsyncStorage driver available via `localspace/react-native` opt-in entry
- **WebSQL:** Not supported (migrate to IndexedDB)
- **Node/SSR:** Custom driver required

---

## Documentation

| Document                                     | Description                            |
| -------------------------------------------- | -------------------------------------- |
| [API Reference](./docs/api-reference.md)     | Complete method documentation          |
| [Plugin System](./docs/plugins.md)           | Built-in plugins & custom development  |
| [Real-World Examples](./docs/examples.md)    | Production-ready code patterns         |
| [Migration Guide](./docs/migration-guide.md) | Upgrading 2.x and migrating older apps |

---

## Roadmap

### Complete ✅

- [x] IndexedDB and localStorage drivers
- [x] Opt-in memory fallback driver
- [x] React Native AsyncStorage driver
- [x] Familiar Promise-based key-value API
- [x] TypeScript-first implementation
- [x] Explicit batch operations
- [x] Plugin system (TTL, Encryption, Compression)

### Coming Soon

- [ ] OPFS driver (Origin Private File System)
- [ ] Node.js (File system, SQLite)
- [ ] React Native SQLite driver
- [ ] Deno (Native KV store)

---

## License

[MIT](./LICENSE)
