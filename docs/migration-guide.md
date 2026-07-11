# Migration Guide

## Upgrade From 1.x To 2.0

Install the new major version:

```bash
pnpm add localspace@^2
```

The core serializer, database names, store names, and key layout are unchanged,
so existing core key/value data does not need to be rewritten. The breaking
changes are in API behavior and package surface.

### Breaking Changes

| 1.x API or behavior                              | 2.0 migration                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Completion callbacks and exported callback types | Use `await`, `.then()`, and `try`/`catch`                                                      |
| `compatibilityMode`                              | Remove the option; all public operations are Promise-only                                      |
| `coalesceWrites` and related options             | Remove them and call `setItems()` or `removeItems()` explicitly                                |
| `coalesceFireAndForget`                          | Await the returned write promise; early success before persistence is no longer supported      |
| `getPerformanceStats()`                          | Measure explicit operations in application telemetry                                           |
| `syncPlugin`                                     | Implement application synchronization; start with the limited notification example if useful   |
| `quotaPlugin`                                    | Enforce application policy outside the package; adapt the limited size guard example if useful |
| localStorage or React Native `runTransaction()`  | Use explicit operations or select IndexedDB/memory when rollback is required                   |

### Convert Completion Callbacks

Replace completion callbacks with Promise control flow:

```diff
-store.getItem('user', (error, user) => {
-  if (error) {
-    report(error);
-    return;
-  }
-  render(user);
-});
+try {
+  const user = await store.getItem('user');
+  render(user);
+} catch (error) {
+  report(error);
+}
```

Driver management is Promise-only too:

```diff
-store.setDriver([store.INDEXEDDB], onSuccess, onError);
+await store.setDriver([store.INDEXEDDB]);
```

Remove `Callback`, `CompatibilitySuccessCallback`, and
`CompatibilityErrorCallback` imports.

### Replace Automatic Write Coalescing

Use explicit batches when writes belong together:

```diff
-const store = localspace.createInstance({
-  coalesceWrites: true,
-  coalesceWindowMs: 8,
-});
-await Promise.all([
-  store.setItem('a', 1),
-  store.setItem('b', 2),
-]);
+const store = localspace.createInstance();
+await store.setItems([
+  { key: 'a', value: 1 },
+  { key: 'b', value: 2 },
+]);
```

On IndexedDB, each batch chunk is transactional. `maxBatchSize` can split one
call into multiple transactions, so omit it when the whole batch must be
atomic.

### Use Transactions Only On Capable Drivers

IndexedDB provides native transactions. The memory driver restores a snapshot
after a failed readwrite transaction, but it is runtime-only and does not
isolate concurrent callers. localStorage and React Native AsyncStorage reject
`runTransaction()` with `UNSUPPORTED_OPERATION`.

```ts
if (store.driver() === store.INDEXEDDB || store.driver() === store.MEMORY) {
  await store.runTransaction('readwrite', async (tx) => {
    const count = (await tx.get<number>('count')) ?? 0;
    await tx.set('count', count + 1);
  });
}
```

Do not replace a rejected transaction with a loop when partial writes would be
incorrect.

### Move Application Policy Out Of The Package

`syncPlugin` and `quotaPlugin` are no longer exported. Their names overstated
what could be guaranteed across tabs, processes, concurrent writers, and
browser quota enforcement.

- `examples/broadcast-notification-plugin.ts` demonstrates best-effort
  single-item notifications. It does not replicate values or guarantee
  delivery, ordering, or batch coverage. Its default channel isolates different
  storage drivers because identically named IndexedDB and localStorage stores
  do not share data.
- `examples/size-limit-plugin.ts` demonstrates a serialized-value guard. It is
  not browser quota management, does not evict data, and cannot enforce a limit
  atomically across concurrent writers.

The 1.x `syncPlugin` persisted conflict-version maps in localStorage under keys
prefixed with `__localspace_sync_versions__:`. Version 2.0 ignores those keys.
After every 1.x tab or process has been retired, applications may remove them as
obsolete plugin metadata.

Copy and adapt those examples only when their limitations match the
application's policy.

## Migrate From localForage

localspace keeps a familiar key/value API, but it is not a callback-compatible
drop-in replacement. Promise-based localForage usage can usually begin with an
import change:

```diff
-import localforage from 'localforage';
+import localspace from 'localspace';

await localspace.setItem('key', value);
const value = await localspace.getItem('key');
```

Before switching:

1. Convert completion callbacks to Promises.
2. Move WebSQL-only data and driver selection to IndexedDB.
3. Remove assumptions that every driver supports transactions.
4. Test database names, store names, persisted values, and fallback order.
5. Adopt batch APIs and plugins explicitly rather than as compatibility shims.
