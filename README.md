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

### TODO
- [ ] **Improved error handling** - Structured error types with detailed context
- [ ] **Performance optimizations** - Connection pooling, transaction batching
- [ ] **Plugin system** - Middleware architecture for cross-cutting concerns
- [ ] **Cache API driver** - Native browser caching with automatic HTTP semantics
- [ ] **OPFS driver** - Origin Private File System for high-performance file storage
- [ ] **Memory driver** - In-memory storage for testing and SSR
- [ ] **Custom driver templates** - Documentation and examples for third-party drivers
- [ ] **Node.js** - File system and SQLite adapters
- [ ] **React Native** - AsyncStorage and SQLite drivers
- [ ] **Electron** - Main and renderer process coordination
- [ ] **Deno** - Native KV store integration
- [ ] **TTL plugin** - Time-to-live expiration with automatic cleanup
- [ ] **Encryption plugin** - Transparent encryption/decryption with Web Crypto API
- [ ] **Compression plugin** - LZ-string or Brotli compression for large values
- [ ] **Sync plugin** - Multi-tab synchronization with BroadcastChannel
- [ ] **Quota plugin** - Automatic quota management and cleanup strategies

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

## Migration Guide

### Note differences from localForage before upgrading
- `dropInstance()` throws a real `Error` when arguments are invalid. Examine `error.message` instead of comparing string literals.
- Blob capability checks run on each request instead of being cached. Cache the result in your application if repeated blob writes dominate your workload.
- **WebSQL is intentionally unsupported.** Migrate any WebSQL-only code to IndexedDB or localStorage before switching.

### Enable compatibility mode for driver setup methods
If you maintain older code that expects separate *success* and *error* callbacks for driver setup methods (`setDriver`, `defineDriver`), enable `compatibilityMode` when creating an instance. **Use this mode only for migrations; prefer native Promises going forward.**

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
  },
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
- **Batch APIs outperform loops:** Playwright benchmark (`test/playwright/benchmark.spec.ts`) on 500 items x 256B showed `setItems()` ~6x faster and `getItems()` ~7.7x faster than per-item loops, with `removeItems()` ~2.8x faster (Chromium, relaxed durability).
- **IndexedDB durability defaults:** Chrome 121+ uses relaxed durability by default; keep it for speed or set `durability: 'strict'` in `config` for migration-style writes.
- **Storage Buckets (Chromium 122+):** supply a `bucket` option to isolate critical data and hint durability/persistence per bucket.
- **localStorage batch atomicity:** When using localStorage driver, batch operations (`setItems()`, `removeItems()`) are **not atomic**. If an error occurs mid-operation, some items may be written or removed while others are not. In contrast, IndexedDB batch operations use transactions and guarantee atomicity (all-or-nothing). If atomicity is critical for your use case, prefer IndexedDB driver or implement application-level rollback logic.

When `compatibilityMode` is off, driver setup methods also use Node-style callbacks. Promises are recommended for all new code.

## Troubleshooting
- **Wait for readiness:** Call `await localspace.ready()` before the first operation when you need to confirm driver selection.
- **Inspect drivers:** Use `localspace.driver()` to confirm which driver is active in different environments.
- **Handle quota errors:** Catch `DOMException` errors from `setItem` to inform users about storage limits.
- **Run unit tests:** The project ships with Vitest and Playwright suites covering API behavior; run `yarn test` to verify changes.

## License
[MIT](./LICENSE)
