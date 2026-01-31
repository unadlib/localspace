# Migration Guide

How to migrate from localForage to localspace.

## Table of Contents

- [Overview](#overview)
- [Differences from localForage](#differences-from-localforage)
- [Enable Compatibility Mode](#enable-compatibility-mode)
- [Callback Style Differences](#callback-style-differences)

---

## Overview

localspace is designed as a drop-in replacement for localForage. In most cases, you can simply change your import statement:

```diff
-import localforage from 'localforage';
+import localspace from 'localspace';

// Your existing code works unchanged
await localspace.setItem('key', value);
const data = await localspace.getItem('key');
```

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

---

## Enable Compatibility Mode

If you maintain older code that expects separate _success_ and _error_ callbacks for driver setup methods (`setDriver`, `defineDriver`), enable `compatibilityMode` when creating an instance.

> [!WARNING]
> Use compatibility mode only for migrations. Prefer native Promises going forward.

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

---

## Callback Style Differences

### Storage Methods

Storage methods like `setItem`, `getItem`, `removeItem`, etc. **always** use Node-style `(error, value)` callbacks regardless of `compatibilityMode`. This matches localForage's original behavior.

```ts
localspace.setItem('key', 'value', (err, value) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Saved:', value);
  }
});

localspace.getItem('key', (err, value) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Retrieved:', value);
  }
});
```

### Driver Methods (Compatibility Mode Off)

When `compatibilityMode` is off (default), driver setup methods also use Node-style callbacks:

```ts
localspace.setDriver([localspace.INDEXEDDB], (err) => {
  if (err) {
    console.error('Driver setup failed:', err);
  } else {
    console.log('Driver ready');
  }
});
```

### Driver Methods (Compatibility Mode On)

When `compatibilityMode` is on, driver setup methods use separate success/error callbacks (localForage style):

```ts
const legacy = localspace.createInstance({
  compatibilityMode: true,
});

legacy.setDriver(
  [legacy.INDEXEDDB],
  () => console.log('Success!'),
  (err) => console.error('Error:', err)
);
```

---

## Recommended Migration Steps

1. **Update imports**: Change `localforage` to `localspace`
2. **Run tests**: Your existing test suite should pass without changes
3. **Update error handling**: Check for `Error` instances instead of string comparisons
4. **Remove WebSQL**: If you were using WebSQL driver, migrate to IndexedDB
5. **Adopt new features**: Gradually adopt plugins, batch operations, and other new features
