# localspace

![Node CI](https://github.com/unadlib/localspace/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/localspace.svg)](https://www.npmjs.com/package/localspace)
![license](https://img.shields.io/npm/l/localspace)

localspace — modern storage toolkit that keeps localForage compatibility while using async/await, TypeScript, and zero legacy baggage.

## Motivation

The industry still leans on localForage’s familiar API, yet modern apps crave stronger typing, async ergonomics, and multi-platform reliability without a painful rewrite. localspace exists to bridge that gap: it honors the old contract while delivering the capabilities teams have been asking for since 2021.

### What needed to change

localForage’s storage layer stopped evolving while real-world needs kept growing. Long-standing requests—first-class TypeScript types, native async/await, reliable IndexedDB cleanup, consistency across Node and React Native, batch operations, TTL, and encryption—remain unresolved. Teams want those upgrades without abandoning the API that already powers their products.

### How localspace responds

We stay 100% compatible with localForage on the surface, but rebuild the internals with modern JavaScript, a TypeScript-first type system, native Promises, and a clean driver architecture. That drop-in approach delivers predictable behavior (including a complete IndexedDB `dropInstance`), clearer diagnostics, and room to grow with new drivers (Cache API, SQLite, OPFS) and optional plugins (TTL, encryption, compression) across browsers, Node, React Native, and Electron. Our goal is a storage toolkit that preserves your investment in the localForage mental model while finally addressing the community’s accumulated pain points.

### Why rebuild instead of fork?

Starting fresh let us eliminate technical debt while maintaining API compatibility. The codebase is written in modern TypeScript, uses contemporary patterns, and has a clear structure that makes it straightforward to add new capabilities. Teams can migrate from localForage without changing application code, then unlock better developer experience and future extensibility.

## Table of Contents

- [Motivation](#motivation)
  - [What needed to change](#what-needed-to-change)
  - [How localspace responds](#how-localspace-responds)
  - [Why rebuild instead of fork?](#why-rebuild-instead-of-fork)
- [Roadmap](#roadmap)
- [Installation and Usage](#installation-and-usage)
  - [localspace delivers modern storage compatibility](#localspace-delivers-modern-storage-compatibility)
  - [Install and import localspace](#install-and-import-localspace)
  - [Store data with async flows or callbacks](#store-data-with-async-flows-or-callbacks)
  - [Configure isolated stores for clear data boundaries](#configure-isolated-stores-for-clear-data-boundaries)
  - [Choose drivers with predictable fallbacks](#choose-drivers-with-predictable-fallbacks)
  - [Handle binary data across browsers](#handle-binary-data-across-browsers)
  - [Advanced: Coalesced Writes (IndexedDB only)](#advanced-coalesced-writes-indexeddb-only)
- [Migration Guide](#migration-guide)
  - [Note differences from localForage before upgrading](#note-differences-from-localforage-before-upgrading)
  - [Enable compatibility mode for legacy callbacks](#enable-compatibility-mode-for-legacy-callbacks)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Roadmap

localspace is built on a foundation designed for growth. Here's what's planned:

### Core Compatibility (Complete)

- [x] IndexedDB and localStorage drivers
- [x] Full localForage API parity
- [x] TypeScript-first implementation
- [x] Comprehensive test coverage
- [x] Modern build pipeline (ES modules, CommonJS, UMD)
- [x] Batch operations (`setItems()`, `getItems()`, `removeItems()`) for higher throughput
- [x] Automatic write coalescing (3-10x faster rapid writes, opt-in for IndexedDB)
- [x] Connection pooling, transaction batching, and warmup
- [x] **Improved error handling** - Structured error types with detailed context

### TODO

- [x] **Plugin system** - Middleware architecture for cross-cutting concerns
- [ ] **OPFS driver** - Origin Private File System for high-performance file storage
- [ ] **Custom driver templates** - Documentation and examples for third-party drivers
- [ ] **Node.js** - File system and SQLite adapters
- [ ] **React Native** - AsyncStorage and SQLite drivers
- [ ] **Electron** - Main and renderer process coordination
- [ ] **Deno** - Native KV store integration
- [x] **TTL plugin** - Time-to-live expiration with automatic cleanup
- [x] **Encryption plugin** - Transparent encryption/decryption with Web Crypto API
- [x] **Compression plugin** - LZ-string or Brotli compression for large values
- [x] **Sync plugin** - Multi-tab synchronization with BroadcastChannel
- [x] **Quota plugin** - Automatic quota management and cleanup strategies

### 📊 Community Priorities

We prioritize features based on community feedback. If you need a specific capability:

1. **Check existing issues** to see if it's already requested
2. **Open a feature request** with your use case and requirements
3. **Contribute** - We welcome PRs for new drivers, plugins, or improvements

**Want to help?** The most impactful contributions right now:

- Testing in diverse environments (browsers, frameworks, edge cases)
- Documentation improvements and usage examples
- Performance benchmarks and optimization suggestions
- New driver implementations (especially Cache API and OPFS)

## Installation and Usage

### localspace delivers modern storage compatibility

localspace targets developers who need localForage's API surface without its historical baggage. **You get the same method names, configuration options, and driver constants, all implemented with modern JavaScript and TypeScript types.**

- Promise-first API with optional callbacks
- IndexedDB and localStorage drivers included out of the box
- ES module, CommonJS, and UMD bundles plus `.d.ts` files
- Drop-in TypeScript generics for value typing

### Install and import localspace

Install the package with your preferred package manager and import it once at the entry point where you manage storage.

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

### Store data with async flows or callbacks

Use async/await for the clearest flow. **Callbacks remain supported for parity with existing localForage codebases.**

```ts
await localspace.setItem('user', { name: 'Ada', role: 'admin' });
const user = await localspace.getItem<{ name: string; role: string }>('user');

localspace.getItem('user', (error, value) => {
  if (error) return console.error(error);
  console.log(value?.name);
});
```

### 🚀 Opt into automatic performance optimization (coalesced writes)

localspace can merge rapid single writes into batched transactions for IndexedDB, giving you **3-10x performance improvement** under write-heavy bursts. This is opt-in so default behavior stays predictable; enable it when you know you have high write pressure.

```ts
// Your existing code - unchanged
await Promise.all([
  localspace.setItem('setting1', value1),
  localspace.setItem('setting2', value2),
  localspace.setItem('setting3', value3),
]);
// ✅ Automatically batched into one transaction!
// ✅ 3-10x faster than individual commits
// ✅ Zero code changes required
```

**How it works**: When using IndexedDB, rapid writes within an 8ms window are merged into a single transaction commit. This is transparent to your application and has no impact on single writes.

**Turn it on or tune it**

```ts
const instance = localspace.createInstance({
  coalesceWrites: true, // opt-in (default is false)
  coalesceWindowMs: 8, // 8ms window (default)
});
```

For consistency modes, batch limits, and failure semantics, see **Advanced: Coalesced Writes** below.

**When is this useful?**

- Form auto-save that writes multiple fields rapidly
- Bulk state synchronization loops
- Real-time collaborative editing
- Any code with multiple sequential `setItem()` calls

**Performance impact**: Single infrequent writes are unaffected. Rapid sequential writes get 3-10x faster automatically.

**Want to see the actual performance gains?**

```ts
// Get statistics to see how much coalescing helped (IndexedDB only)
const stats = localspace.getPerformanceStats?.();
console.log(stats);
// {
//   totalWrites: 150,           // Total write operations
//   coalescedWrites: 120,       // Operations that were merged
//   transactionsSaved: 100,     // Transactions saved by coalescing
//   avgCoalesceSize: 4.8        // Average batch size
// }
```

### Boost throughput with batch operations

Use the batch APIs to group writes and reads into single transactions for IndexedDB and localStorage. This reduces commit overhead and benefits from Chrome’s relaxed durability defaults (see below).

```ts
const items = [
  { key: 'user:1', value: { name: 'Ada' } },
  { key: 'user:2', value: { name: 'Lin' } },
];

// Single transaction write
await localspace.setItems(items);

// Ordered bulk read
const result = await localspace.getItems(items.map((item) => item.key));
console.log(result); // [{ key: 'user:1', value: {…} }, { key: 'user:2', value: {…} }]

// Single transaction delete
await localspace.removeItems(items.map((item) => item.key));

// For very large batches, set a chunk size to avoid huge transactions
const limited = localspace.createInstance({ maxBatchSize: 200 });
await limited.setDriver([limited.INDEXEDDB]);
await limited.setItems(items); // will split into 200-item chunks

// Optional: coalesce rapid single writes into one transaction (IndexedDB)
const coalesced = localspace.createInstance({
  coalesceWrites: true,
  coalesceWindowMs: 8,
});
await coalesced.setDriver([coalesced.INDEXEDDB]);
await Promise.all([
  coalesced.setItem('fast-1', 'a'),
  coalesced.setItem('fast-2', 'b'),
]); // batched into one tx within the window

// These features work independently and can be combined
const optimized = localspace.createInstance({
  coalesceWrites: true, // optimizes single-item writes (setItem/removeItem)
  coalesceWindowMs: 8,
  maxBatchSize: 200, // limits batch API chunk size (setItems/removeItems)
});
await optimized.setDriver([optimized.INDEXEDDB]);

// Note: localStorage batches attempt best-effort rollback on failure and map
// quota errors to QUOTA_EXCEEDED, but they still serialize per-item and are
// not truly atomic. For strict atomicity or durability, prefer IndexedDB or
// add your own compensating logic. If you need per-item success/failure, call
// setItems in smaller chunks or handle errors explicitly.
```

### Run your own transaction

When you need atomic multi-step work (migrations, dependent writes), wrap operations in a single transaction. On IndexedDB this uses one `IDBTransaction`; on localStorage it executes sequentially.

```ts
await localspace.setDriver([localspace.INDEXEDDB]);
await localspace.runTransaction('readwrite', async (tx) => {
  const current = await tx.get<number>('counter');
  const next = (current ?? 0) + 1;
  await tx.set('counter', next);
  await tx.set('lastUpdated', Date.now());
});
```

### Configure isolated stores for clear data boundaries

Create independent instances when you want to separate cache layers or product features. Each instance can override defaults like `name`, `storeName`, and driver order.

```ts
const sessionCache = localspace.createInstance({
  name: 'session',
  storeName: 'volatile-items',
});

await sessionCache.setItem('token', 'abc123');
```

### Choose drivers with predictable fallbacks

By default, localspace prefers IndexedDB (`INDEXEDDB`) and falls back to localStorage (`LOCALSTORAGE`). Configure alternative sequences as needed.

```ts
await localspace.setDriver([localspace.INDEXEDDB, localspace.LOCALSTORAGE]);

if (!localspace.supports(localspace.INDEXEDDB)) {
  console.warn('IndexedDB unavailable, using localStorage wrapper.');
}

// Hint IndexedDB durability (Chrome defaults to "relaxed" from 121+)
await localspace.setDriver([localspace.INDEXEDDB]);
await localspace.ready();
// Global durability hint for this instance
localspace.config({ durability: 'strict' }); // or omit to stay relaxed for speed

// Use Storage Buckets (Chromium 122+) to isolate data and hints
const bucketed = localspace.createInstance({
  name: 'mail-cache',
  storeName: 'drafts',
  bucket: { name: 'drafts', durability: 'strict', persisted: true },
});
await bucketed.setDriver([bucketed.INDEXEDDB]);
```

**Tip:** Use `defineDriver()` and `getDriver()` to register custom drivers that match the localForage interface.

### Handle binary data across browsers

localspace serializes complex values transparently. It stores `Blob`, `ArrayBuffer`, and typed arrays in IndexedDB natively and in localStorage via Base64 encoding when necessary. You write the same code regardless of the driver.

```ts
const file = new Blob(['hello'], { type: 'text/plain' });
await localspace.setItem('file', file);
const restored = await localspace.getItem<Blob>('file');
```

## Advanced: Coalesced Writes (IndexedDB only)

localspace offers an opt-in, configurable coalesced write path to cut IndexedDB transaction count and improve throughput under heavy write bursts.

> `coalesceWrites` defaults to `false` so behavior stays predictable. Turn it on when you expect high-frequency writes.

### Why coalesce writes?

Each IndexedDB write opens a readwrite transaction. At high frequency, transaction startup overhead becomes a bottleneck. With coalescing enabled, `setItem` and `removeItem` calls that land within a short window (default 8 ms) are merged into fewer transactions:

- Multiple writes can share one transaction.
- `coalesceMaxBatchSize` caps how many ops each flush processes.
- `coalesceReadConsistency` controls when writes resolve and when reads see them.

### Configuration

Relevant `LocalSpaceConfig` fields:

```ts
interface LocalSpaceConfig {
  /**
   * Enable coalesced writes (IndexedDB only).
   * Default: false
   */
  coalesceWrites?: boolean;

  /**
   * Time window (ms) for merging writes into the same batch.
   * Default: 8
   */
  coalesceWindowMs?: number;

  /**
   * Maximum operations per flush batch. Beyond this, flush immediately
   * and split into multiple transactions.
   * Default: undefined (no limit)
   */
  coalesceMaxBatchSize?: number;

  /**
   * When coalesceWrites is on:
   * - 'strong' (default): drain pending writes before reads
   * - 'eventual': reads skip draining; writes only guarantee queueing
   */
  coalesceReadConsistency?: 'strong' | 'eventual';
}
```

### Consistency modes

#### `coalesceReadConsistency: 'strong'` (default)

- Writes (`setItem` / `removeItem`): Promises resolve after the data is persisted; flush errors reject.
- Reads (`getItem`, `iterate`, batch reads): call `drainCoalescedWrites` first so you read what you just wrote.

Use this for user settings, drafts, and any flow where you need read-your-writes.

#### `coalesceReadConsistency: 'eventual'`

- Writes: queued and resolve immediately once enqueued; flush happens in the background. Errors log `console.warn('[localspace] coalesced write failed (eventual mode)', error)` but do not reject the earlier Promise.
- Reads: do not flush pending writes, so you may briefly see stale values.
- Destructive operations still force a flush to avoid dropping queued writes: `removeItems`, `clear`, `dropInstance`.

Use this for logs/analytics or workloads that can tolerate short windows of staleness in exchange for the lightest write path.

### Bounding batch size

```ts
const store = localspace.createInstance({
  name: 'logs',
  storeName: 'events',
  coalesceWrites: true,
  coalesceWindowMs: 8,
  coalesceMaxBatchSize: 64,
  coalesceReadConsistency: 'eventual',
});
```

- When the queue reaches `coalesceMaxBatchSize`, it flushes immediately.
- Flush splits work into batches of up to 64 ops, each in its own transaction.
- `getPerformanceStats()` reports `totalWrites`, `coalescedWrites`, and `transactionsSaved` so you can see the gains.

### Recommended recipes

1. Default: coalescing off

```ts
const store = localspace.createInstance({
  name: 'app',
  storeName: 'keyvaluepairs',
  // coalesceWrites is false by default
});
```

2. High-frequency writes with eventual consistency

```ts
const logStore = localspace.createInstance({
  name: 'analytics',
  storeName: 'events',
  coalesceWrites: true,
  coalesceWindowMs: 8,
  coalesceMaxBatchSize: 64,
  coalesceReadConsistency: 'eventual',
});
```

- `setItem` resolves almost immediately.
- Short windows of stale reads are acceptable.
- `clear` and `dropInstance` force-flush so queued writes are not lost.

3. Strong consistency with bounded batches

```ts
const userStore = localspace.createInstance({
  name: 'user-data',
  storeName: 'kv',
  coalesceWrites: true,
  coalesceWindowMs: 8,
  coalesceMaxBatchSize: 32,
  coalesceReadConsistency: 'strong',
});
```

- Writes resolve after persistence.
- Reads flush pending writes first.
- Batching still reduces transaction count.

### Caveats

- Coalesced writes apply to the IndexedDB driver only; localStorage always writes per operation.
- In `eventual` mode, writes can be lost if the page closes before flush completes, and errors surface only via `console.warn`.
- For critical durability (orders, payments, irreversible state), avoid `eventual` and consider leaving `coalesceWrites` off entirely.

## Plugin System

localspace now ships with a first-class plugin engine. Attach middleware when creating an instance or call `use()` later; plugins can mutate payloads, observe driver context, and run async interceptors around every storage call.

```ts
const store = localspace.createInstance({
  name: 'secure-store',
  storeName: 'primary',
  plugins: [
    ttlPlugin({ defaultTTL: 60_000 }),
    compressionPlugin({ threshold: 1024 }),
    encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
    syncPlugin({ channelName: 'localspace-sync' }),
    quotaPlugin({ maxSize: 5 * 1024 * 1024, evictionPolicy: 'lru' }),
  ],
});
```

### Lifecycle and hooks

- **Registration** – supply `plugins` when calling `createInstance()` or chain `instance.use(plugin)` later. Each plugin can also expose `enabled` (boolean or function) and `priority` to control execution order.
- **Lifecycle events** – `onInit(context)` is invoked after `ready()`, and `onDestroy` lets you tear down timers or channels. Call `await instance.destroy()` when disposing of an instance to run every `onDestroy` hook (executed in reverse priority order). Context exposes the active driver, db info, config, and a shared `metadata` bag for cross-plugin coordination.
- **Interceptors** – hook into `beforeSet/afterSet`, `beforeGet/afterGet`, `beforeRemove/afterRemove`, plus batch-specific methods such as `beforeSetItems` or `beforeGetItems`. Hooks run sequentially: `before*` hooks execute from highest to lowest priority, while `after*` hooks unwind in reverse order so layered transformations (TTL → compression → encryption) remain invertible. Returning a value passes it to the next plugin, while throwing a `LocalSpaceError` aborts the operation.
- **Per-call state** – plugins can stash data on `context.operationState` (e.g., capture the original value in `beforeSet` and reuse it in `afterSet`). For batch operations, `context.operationState.isBatch` is `true` and `context.operationState.batchSize` provides the total count.
- **Error handling & policies** – unexpected exceptions are reported through `plugin.onError`. Throw a `LocalSpaceError` if you need to stop the pipeline (quota violations, failed decryptions, etc.). Init policy: default fail-fast; set `pluginInitPolicy: 'disable-and-continue'` to log and skip the failing plugin. Runtime policy: default `pluginErrorPolicy: 'strict'` propagates all plugin errors; only use `lenient` if you explicitly accept swallowed errors, and avoid lenient for encryption/compression/ttl or any correctness-critical plugin.

### Plugin execution order

Plugins are sorted by `priority` (higher runs first in `before*`, last in `after*`). Default priorities:

| Plugin      | Priority | Notes                                                                |
| ----------- | -------- | -------------------------------------------------------------------- |
| sync        | -100     | Runs last in `afterSet` to broadcast original (untransformed) values |
| quota       | -10      | Runs late so it measures final payload sizes                         |
| encryption  | 0        | Encrypts after compression so decrypt runs first in `after*`         |
| compression | 5        | Runs before encryption so payload is compressible                    |
| ttl         | 10       | Runs outermost so TTL wrapper is transformed by other plugins        |

**Recommended order**: `[ttlPlugin, compressionPlugin, encryptionPlugin, syncPlugin, quotaPlugin]`

### Built-in plugins

#### TTL plugin

Wraps values as `{ data, expiresAt }`, invalidates stale reads, and optionally runs background cleanup. Options:

- `defaultTTL` (ms) and `keyTTL` overrides
- `cleanupInterval` to periodically scan expired entries
- `cleanupBatchSize` (default: 100) for efficient batch cleanup
- `onExpire(key, value)` callback before removal

```ts
// Cache API responses for 5 minutes
const cacheStore = localspace.createInstance({
  name: 'api-cache',
  plugins: [
    ttlPlugin({
      defaultTTL: 5 * 60 * 1000, // 5 minutes
      keyTTL: {
        'user-profile': 30 * 60 * 1000, // 30 minutes for user data
        'session-token': 60 * 60 * 1000, // 1 hour for session
      },
      cleanupInterval: 60 * 1000, // Cleanup every minute
      cleanupBatchSize: 50, // Process 50 keys at a time
      onExpire: (key, value) => {
        console.log(`Cache expired: ${key}`);
      },
    }),
  ],
});

// Single item and batch operations both respect TTL
await cacheStore.setItem('user-profile', userData);
await cacheStore.setItems([
  { key: 'post-1', value: post1 },
  { key: 'post-2', value: post2 },
]);
```

#### Encryption plugin

Encrypts serialized payloads using the Web Crypto API (AES-GCM by default) and decrypts transparently on reads.

- Provide a `key` (CryptoKey/ArrayBuffer/string) or `keyDerivation` block (PBKDF2)
- Customize `algorithm`, `ivLength`, `ivGenerator`, or `randomSource`
- Works in browsers and modern Node runtimes (pass your own `subtle` when needed)

```ts
// Using a direct key
const secureStore = localspace.createInstance({
  name: 'secure-store',
  plugins: [
    encryptionPlugin({
      key: '0123456789abcdef0123456789abcdef', // 32 bytes for AES-256
    }),
  ],
});

// Using PBKDF2 key derivation (recommended for password-based encryption)
const passwordStore = localspace.createInstance({
  name: 'password-store',
  plugins: [
    encryptionPlugin({
      keyDerivation: {
        passphrase: userPassword,
        salt: 'unique-per-user-salt',
        iterations: 150000, // Higher = more secure but slower
        hash: 'SHA-256',
        length: 256,
      },
    }),
  ],
});

// Batch operations are also encrypted
await secureStore.setItems([
  { key: 'card-number', value: '4111-1111-1111-1111' },
  { key: 'cvv', value: '123' },
]);
```

#### Compression plugin

Runs LZ-string compression (or a custom codec) when payloads exceed a `threshold` and restores them on read.

- `threshold` (bytes) controls when compression kicks in
- Supply a custom `{ compress, decompress }` codec if you prefer pako/Brotli

```ts
const compressedStore = localspace.createInstance({
  name: 'compressed-store',
  plugins: [
    compressionPlugin({
      threshold: 1024, // Only compress if > 1KB
      algorithm: 'lz-string', // Label stored in metadata
    }),
  ],
});

// Custom codec example (using pako)
import pako from 'pako';

const pakoStore = localspace.createInstance({
  name: 'pako-store',
  plugins: [
    compressionPlugin({
      threshold: 512,
      algorithm: 'gzip',
      codec: {
        compress: (data) => pako.gzip(data),
        decompress: (data) => pako.ungzip(data, { to: 'string' }),
      },
    }),
  ],
});
```

#### Sync plugin

Keeps multiple tabs/processes in sync via `BroadcastChannel` (with `storage`-event fallback).

- `channelName` separates logical buses
- `syncKeys` lets you scope which keys broadcast
- `conflictStrategy` defaults to `last-write-wins`; provide `onConflict` (return `false` to drop remote writes) for merge logic

```ts
const syncedStore = localspace.createInstance({
  name: 'synced-store',
  plugins: [
    syncPlugin({
      channelName: 'my-app-sync',
      syncKeys: ['cart', 'preferences', 'theme'], // Only sync these keys
      conflictStrategy: 'last-write-wins',
      onConflict: ({ key, localTimestamp, incomingTimestamp, value }) => {
        console.log(`Conflict on ${key}: local=${localTimestamp}, incoming=${incomingTimestamp}`);
        // Return false to reject the incoming change
        return localTimestamp < incomingTimestamp;
      },
    }),
  ],
});

// Changes sync across tabs automatically
await syncedStore.setItem('cart', { items: [...] });
await syncedStore.setItems([
  { key: 'preferences', value: { darkMode: true } },
  { key: 'theme', value: 'blue' },
]);
```

#### Quota plugin

Tracks approximate storage usage after every mutation and enforces limits.

- `maxSize` (bytes) and optional `useNavigatorEstimate` to read the browser's quota
- `evictionPolicy: 'error' | 'lru'` (LRU removes least-recently-used keys automatically)
- `onQuotaExceeded(info)` fires before throwing so you can log/alert users

```ts
const quotaStore = localspace.createInstance({
  name: 'quota-store',
  plugins: [
    quotaPlugin({
      maxSize: 5 * 1024 * 1024, // 5 MB
      evictionPolicy: 'lru', // Automatically evict least-recently-used items
      useNavigatorEstimate: true, // Also respect browser quota
      onQuotaExceeded: ({ key, attemptedSize, maxSize, currentUsage }) => {
        console.warn(`Quota exceeded: tried to write ${attemptedSize} bytes`);
        console.warn(`Current usage: ${currentUsage}/${maxSize} bytes`);
      },
    }),
  ],
});

// Batch operations are also quota-checked
await quotaStore.setItems([
  { key: 'large-1', value: largeData1 },
  { key: 'large-2', value: largeData2 },
]); // Throws QUOTA_EXCEEDED if total exceeds limit
```

> Tip: place quota plugins last so they see the final payload size after other transformations (TTL, encryption, compression, etc.).

### Plugin combination best practices

1. **Recommended plugin order** (from highest to lowest priority):
   ```ts
   plugins: [
     ttlPlugin({ ... }),         // priority: 10
     compressionPlugin({ ... }), // priority: 5
     encryptionPlugin({ ... }),  // priority: 0
     quotaPlugin({ ... }),       // priority: -10
     syncPlugin({ ... }),        // priority: -100
   ]
   ```

2. **Always compress before encrypting**: Encrypted data has high entropy and compresses poorly. The default priorities handle this automatically.

3. **Use strict error policy with security-critical plugins**:
   ```ts
   // DON'T do this - encryption failures will be silently swallowed
   const bad = localspace.createInstance({
     plugins: [encryptionPlugin({ key })],
     pluginErrorPolicy: 'lenient', // Dangerous!
   });

   // DO this - encryption failures will propagate
   const good = localspace.createInstance({
     plugins: [encryptionPlugin({ key })],
     pluginErrorPolicy: 'strict', // Safe (default)
   });
   ```

4. **Batch operations work with all plugins**: All built-in plugins support `setItems`, `getItems`, and `removeItems`.

### Plugin troubleshooting

| Issue | Solution |
|-------|----------|
| TTL items not expiring | Ensure `cleanupInterval` is set, or read items to trigger expiration |
| Encryption fails silently | Check `pluginErrorPolicy` is not 'lenient' |
| Compression not working | Verify payload exceeds `threshold` |
| Sync not updating other tabs | Check `channelName` matches and `syncKeys` includes your key |
| Quota errors on small writes | Other plugins (TTL, encryption) add overhead; account for wrapper size |
| Plugin order seems wrong | Check `priority` values; higher = runs first in `before*` hooks |

## Compatibility & environments

- Browsers: modern Chromium/Edge, Firefox, Safari (desktop & iOS). IndexedDB is required for the primary driver; localStorage is available as a fallback.
- Known differences: Safari private mode / low-quota environments may throw quota; IndexedDB durability hints may be ignored outside Chromium 121+. If you need strict durability, prefer explicit flush/transaction patterns.
- Node/SSR: browser storage APIs are not available by default; supply a custom driver or guard usage in non-browser contexts.

## Testing & CI

- Recommended pipeline: `yarn lint` (if configured) → `yarn vitest run` → `yarn build` → `playwright test`.
- Regression coverage includes: coalesced writes + pending queue + maxConcurrentTransactions + idle close, plugin error policies (strict/lenient) including batch hooks, compression/encryption/ttl ordering, sync version persistence, localStorage quota handling with rollback.

## Security & performance guidance

- Plugin order for correctness/performance: `ttl → compression → encryption → sync → quota`.
- The encryption plugin provides basic crypto; key management/rotation is your responsibility, and you should not swallow encryption/compression errors via a lenient policy.
- Run compression before encryption for effectiveness; place quota last to see final sizes; keep sync last in `after*` to broadcast original values.

## Migration Guide

### Note differences from localForage before upgrading

- `dropInstance()` throws a real `Error` when arguments are invalid. Examine `error.message` instead of comparing string literals.
- Blob capability checks run on each request instead of being cached. Cache the result in your application if repeated blob writes dominate your workload.
- **WebSQL is intentionally unsupported.** Migrate any WebSQL-only code to IndexedDB or localStorage before switching.

### Enable compatibility mode for driver setup methods

If you maintain older code that expects separate _success_ and _error_ callbacks for driver setup methods (`setDriver`, `defineDriver`), enable `compatibilityMode` when creating an instance. **Use this mode only for migrations; prefer native Promises going forward.**

```ts
const legacy = localspace.createInstance({
  name: 'legacy-store',
  storeName: 'pairs',
  compatibilityMode: true,
});

legacy.setDriver(
  [legacy.LOCALSTORAGE],
  () => {
    // Success callback receives no arguments.
  },
  (error) => {
    // Error callback receives the Error object only.
  }
);
```

**Note:** Storage methods like `setItem`, `getItem`, `removeItem`, etc. always use Node-style `(error, value)` callbacks regardless of `compatibilityMode`. This matches localForage's original behavior. For example:

```ts
localspace.setItem('key', 'value', (err, value) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Saved:', value);
  }
});
```

## Performance notes

- **Automatic write coalescing (opt-in):** localspace can merge rapid single writes (`setItem`/`removeItem`) within an 8ms window into one transaction for IndexedDB, delivering 3-10x speedups under bursty writes. Enable with `coalesceWrites: true` and see **Advanced: Coalesced Writes** for consistency modes.
- **Read-your-writes consistency with coalescing:** Pending coalesced writes are flushed before reads (`getItem`, `getItems`, `iterate`, `keys`, `length`, `key`) and destructive ops (`clear`, `dropInstance`), so immediate reads always observe the latest value. If you need eventual reads for speed, you can switch `coalesceReadConsistency` to `'eventual'`.
- **Batch APIs outperform loops:** Playwright benchmark (`test/playwright/benchmark.spec.ts`) on 500 items x 256B showed `setItems()` ~6x faster and `getItems()` ~7.7x faster than per-item loops, with `removeItems()` ~2.8x faster (Chromium, relaxed durability).
- **Transaction helpers:** `runTransaction()` lets you co-locate reads/writes in a single transaction for atomic migrations and to shorten lock time.
- **Batch sizing:** Use `maxBatchSize` to split very large batch operations (`setItems`/`removeItems`/`getItems`) and keep transaction size in check. This works independently from `coalesceWrites`, which optimizes single-item operations.
- **IndexedDB durability defaults:** Chrome 121+ uses relaxed durability by default; keep it for speed or set `durability: 'strict'` in `config` for migration-style writes.
- **Storage Buckets (Chromium 122+):** supply a `bucket` option to isolate critical data and hint durability/persistence per bucket.
- **Connection warmup:** IndexedDB instances pre-warm a transaction after init to reduce first-op latency (`prewarmTransactions` enabled by default; set to `false` to skip).
- **Recommended defaults:** leave `coalesceWrites` off unless you know you need higher write throughput; if you enable it, prefer the default `strong` consistency. Keep `durability` relaxed and `prewarmTransactions` on. Set `connectionIdleMs` only if you want idle connections to auto-close, and `maxBatchSize` only for very large bulk writes. Prefer IndexedDB for atomic/bulk writes since localStorage batches are non-atomic. Use `maxConcurrentTransactions` to throttle heavy parallel workloads when needed.
- **localStorage batch atomicity:** When using localStorage driver, batch operations (`setItems()`, `removeItems()`) are **not atomic**. If an error occurs mid-operation, some items may be written or removed while others are not. In contrast, IndexedDB batch operations use transactions and guarantee atomicity (all-or-nothing). If atomicity is critical for your use case, prefer IndexedDB driver or implement application-level rollback logic.

When `compatibilityMode` is off, driver setup methods also use Node-style callbacks. Promises are recommended for all new code.

## Troubleshooting

- **Wait for readiness:** Call `await localspace.ready()` before the first operation when you need to confirm driver selection.
- **Inspect drivers:** Use `localspace.driver()` to confirm which driver is active in different environments.
- **Read structured errors:** Rejections surface as `LocalSpaceError` with a `code`, contextual `details` (driver, operation, key, attemptedDrivers), and the original `cause`. Branch on `error.code` instead of parsing strings.
- **Handle quota errors:** Check for `error.code === 'QUOTA_EXCEEDED'` (or inspect `error.cause`) from `setItem` to inform users about storage limits.
- **Run unit tests:** The project ships with Vitest and Playwright suites covering API behavior; run `yarn test` to verify changes.
- **Collect Playwright coverage:** Run `yarn test:e2e:coverage` to re-build the bundle, execute the Playwright suite with Chromium V8 coverage enabled, and emit both text + HTML reports via `nyc` (open `coverage/index.html` after the run; raw JSON sits in `.nyc_output`).
- **Collect combined Vitest + Playwright coverage:** Run `yarn coverage:full` to clean previous artifacts, run `vitest --coverage`, stash its Istanbul JSON into `.nyc_output`, then execute the coverage-enabled Playwright suite and emit merged `nyc` reports.

## License

[MIT](./LICENSE)
