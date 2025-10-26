# localspace

![Node CI](https://github.com/unadlib/localspace/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/localspace.svg)](https://www.npmjs.com/package/localspace)
![license](https://img.shields.io/npm/l/localspace)

LocalSpace - Modern storage toolkit that keeps localForage compatibility while using async/await, TypeScript, and zero legacy baggage.

## Table of Contents
- [localspace delivers modern storage compatibility](#localspace-delivers-modern-storage-compatibility)
- [Install and import localspace](#install-and-import-localspace)
- [Store data with async flows or callbacks](#store-data-with-async-flows-or-callbacks)
- [Configure isolated stores for clear data boundaries](#configure-isolated-stores-for-clear-data-boundaries)
- [Choose drivers with predictable fallbacks](#choose-drivers-with-predictable-fallbacks)
- [Handle binary data across browsers](#handle-binary-data-across-browsers)
- [Note differences from localForage before upgrading](#note-differences-from-localforage-before-upgrading)
- [Enable compatibility mode for legacy callbacks](#enable-compatibility-mode-for-legacy-callbacks)
- [Troubleshoot with these tips](#troubleshoot-with-these-tips)

## localspace delivers modern storage compatibility
localspace targets developers who need localForage’s API surface without its historical baggage. **You get the same method names, configuration options, and driver constants, all implemented with modern JavaScript and TypeScript types.**

- Promise-first API with optional callbacks
- IndexedDB and localStorage drivers included out of the box
- ES module, CommonJS, and UMD bundles plus `.d.ts` files
- Drop-in TypeScript generics for value typing

## Install and import localspace
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

## Store data with async flows or callbacks
Use async/await for the clearest flow. **Callbacks remain supported for parity with existing localForage codebases.**

```ts
await localspace.setItem('user', { name: 'Ada', role: 'admin' });
const user = await localspace.getItem<{ name: string; role: string }>('user');

localspace.getItem('user', (error, value) => {
  if (error) return console.error(error);
  console.log(value?.name);
});
```

## Configure isolated stores for clear data boundaries
Create independent instances when you want to separate cache layers or product features. Each instance can override defaults like `name`, `storeName`, and driver order.

```ts
const sessionCache = localspace.createInstance({
  name: 'session',
  storeName: 'volatile-items',
});

await sessionCache.setItem('token', 'abc123');
```

## Choose drivers with predictable fallbacks
By default, localspace prefers IndexedDB (`INDEXEDDB`) and falls back to localStorage (`LOCALSTORAGE`). Configure alternative sequences as needed.

```ts
await localspace.setDriver([localspace.INDEXEDDB, localspace.LOCALSTORAGE]);

if (!localspace.supports(localspace.INDEXEDDB)) {
  console.warn('IndexedDB unavailable, using localStorage wrapper.');
}
```

**Tip:** Use `defineDriver()` and `getDriver()` to register custom drivers that match the localForage interface.

## Handle binary data across browsers
localspace serializes complex values transparently. It stores `Blob`, `ArrayBuffer`, and typed arrays in IndexedDB natively and in localStorage via Base64 encoding when necessary. You write the same code regardless of the driver.

```ts
const file = new Blob(['hello'], { type: 'text/plain' });
await localspace.setItem('file', file);
const restored = await localspace.getItem<Blob>('file');
```

## Note differences from localForage before upgrading
- `dropInstance()` throws a real `Error` when arguments are invalid. Examine `error.message` instead of comparing string literals.
- Blob capability checks run on each request instead of being cached. Cache the result in your application if repeated blob writes dominate your workload.
- **WebSQL is intentionally unsupported.** Migrate any WebSQL-only code to IndexedDB or localStorage before switching.

## Enable compatibility mode for legacy callbacks
If you maintain older code that expects *success* and *error* callbacks, enable `compatibilityMode` when creating an instance. **Use this mode only for migrations; prefer native Promises going forward.**

```ts
const legacy = localspace.createInstance({
  name: 'legacy-store',
  storeName: 'pairs',
  compatibilityMode: true,
});

legacy.setDriver(
  [legacy.LOCALSTORAGE],
  () => {
    // Success callback receives the value only.
  },
  (error) => {
    // Error callback receives the Error object only.
  },
);
```

When `compatibilityMode` is off, Node-style `(error, value)` callbacks remain supported but Promises are recommended.

## Troubleshoot with these tips
- **Wait for readiness:** Call `await localspace.ready()` before the first operation when you need to confirm driver selection.
- **Inspect drivers:** Use `localspace.driver()` to confirm which driver is active in different environments.
- **Handle quota errors:** Catch `DOMException` errors from `setItem` to inform users about storage limits.
- **Run unit tests:** The project ships with Vitest and Playwright suites covering API behavior; run `yarn test` to verify changes.

## License
localspace is released under the [MIT License](LICENSE).
