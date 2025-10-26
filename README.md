# localspace
A library that unifies the APIs of IndexedDB, localStorage and other storage types into a consistent API

## Callback Compatibility Mode

localspace uses Promise / async‑await as first-class citizens by default, and all management APIs (such as `setDriver`, `defineDriver`, `ready`, etc.) can be directly `await`ed.  
If you need to maintain compatibility with localForage's traditional "success callback + error callback" calling convention, you can enable `compatibilityMode` in the instance configuration:

```ts
import localspace from 'localspace';

const legacy = localspace.createInstance({
  name: 'legacy-store',
  storeName: 'pairs',
  compatibilityMode: true,
});

legacy.setDriver(
  [legacy.LOCALSTORAGE],
  () => {
    // Success: only receives result parameter (consistent with localForage)
  },
  (error) => {
    // Error: only receives Error parameter
  }
);
```

> When compatibility mode is not enabled, you can still pass Node-style `(err, value)` callbacks, but it's recommended to use Promise / async‑await directly.

## Compatibility Notes

- `dropInstance()` rejects with a standard `Error` when arguments are invalid. localForage historically resolves with the literal string `'Invalid arguments'`, so code that checks for that exact value should switch to inspecting `error.message` (or the thrown `Error` object) instead.
- Blob support detection in the IndexedDB driver is performed on each request and does not cache the result. localForage memoises this probe, so applications that frequently store blobs may see extra overhead in localspace; consider caching at the application level if this becomes a hotspot.
- WebSQL is intentionally unsupported. The specification has been deprecated for years, major browsers have removed (or are removing) the API, and maintaining a WebSQL driver would add payload without providing forward-looking value. Applications depending on WebSQL in localForage should migrate to IndexedDB or localStorage before switching to localspace.
