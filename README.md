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
