# Migration Guide

How to migrate Promise-based and callback-based localForage code to localspace.

## Table of Contents

- [Overview](#overview)
- [Differences from localForage](#differences-from-localforage)
- [Convert Callback Code](#convert-callback-code)
- [Recommended Migration Steps](#recommended-migration-steps)

---

## Overview

localspace retains the familiar key-value API, but it is Promise-only. Existing
localForage code that already awaits operations can usually start with an import
change:

```diff
-import localforage from 'localforage';
+import localspace from 'localspace';

await localspace.setItem('key', value);
const data = await localspace.getItem('key');
```

Code that passes completion callbacks must be converted before migration.

---

## Differences from localForage

Before upgrading, note these differences:

### 1. Error Handling

`dropInstance()` throws a real `Error` when arguments are invalid. Examine `error.message` instead of comparing string literals.

```ts
try {
  await localspace.dropInstance({ name: 'invalid' });
} catch (error) {
  // error is an Error instance with proper message
  console.error(error.message);
}
```

### 2. Blob Capability Checks

Blob capability checks run on each request instead of being cached. Cache the result in your application if repeated blob writes dominate your workload:

```ts
// Cache the blob support check if needed
const supportsBlobs = await localspace.supports(localspace.INDEXEDDB);
```

### 3. WebSQL Not Supported

**WebSQL is intentionally unsupported.** Migrate any WebSQL-only code to IndexedDB or localStorage before switching.

### 4. Memory Fallback Is Opt-In

localspace includes a built-in memory driver for cases where browser persistent
storage is blocked. Add it explicitly as the last fallback:

```ts
await localspace.setDriver([
  localspace.INDEXEDDB,
  localspace.LOCALSTORAGE,
  localspace.MEMORY,
]);
```

Memory data is runtime-only and is lost on page reload, so it is not enabled by
default.

---

## Convert Callback Code

Replace completion callbacks with `await` and `try`/`catch`:

```diff
-localforage.getItem('key', (error, value) => {
-  if (error) {
-    report(error);
-    return;
-  }
-  render(value);
-});
+try {
+  const value = await localspace.getItem('key');
+  render(value);
+} catch (error) {
+  report(error);
+}
```

Driver setup is Promise-only as well:

```diff
-localforage.setDriver([localforage.INDEXEDDB], onSuccess, onError);
+await localspace.setDriver([localspace.INDEXEDDB]);
```

There is no `compatibilityMode`; unsupported callback arguments are not part of
the TypeScript or runtime contract.

---

## Recommended Migration Steps

1. **Convert callbacks**: Replace completion callbacks with Promises.
2. **Remove WebSQL**: Move WebSQL-only data and driver selection to IndexedDB.
3. **Update imports**: Change `localforage` to `localspace`.
4. **Update error handling**: Handle `LocalSpaceError` codes where relevant.
5. **Run migration tests**: Verify driver selection, persistence, and data shape.
6. **Adopt extensions explicitly**: Add batch APIs or plugins only where needed.
