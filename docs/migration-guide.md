# Migration Guide

## Upgrade From 2.0.x To 2.1

```bash
pnpm add localspace@^2.1.0
```

### Validate Configuration Before Driver Selection

The constructor and `config(options)` now share one validation path. Invalid
initial `version`, `maxBatchSize`, `connectionIdleMs`,
`maxConcurrentTransactions`, `name`, or `storeName` values fail with
`INVALID_CONFIG` before driver initialization. The constructor throws this
error synchronously; the legacy `config(options)` setter continues returning
the error value.

`version` must be a positive safe integer. The operational limits
`maxBatchSize`, `connectionIdleMs`, and `maxConcurrentTransactions` are
non-negative safe integers; `0` continues to mean no batch split, no idle
close, and no transaction cap, respectively.

The 2.0 namespace behavior is retained: `config(options)` replaces non-word
`storeName` characters with `_`, while the constructor preserves them. This
ensures unchanged setter-based applications reopen their existing data. When
moving from the setter to constructor options, pass the already-normalized name
explicitly (for example `my_store_name`). Full normalization unification is a
3.0 migration.

Driver and storage failures now use stable `LocalSpaceError` codes. In
particular, all-driver initialization failure is `DRIVER_UNAVAILABLE`, quota
failure is `QUOTA_EXCEEDED`, and other driver operation failure is
`OPERATION_FAILED`. Inspect `error.code`; engine-specific text remains in
`error.cause` and `error.details.causeMessage` for diagnostics.

### Migrate 2.1 Deprecations Before 3.0

LocalSpace 2.1 emits each deprecation category at most once in non-production
runtimes. Warnings do not alter stored values or fallback order. They can be
disabled for the current package copy when an application has its own migration
telemetry:

```ts
import { setDeprecationWarnings } from 'localspace';

setDeprecationWarnings(false);
```

| Deprecated 2.x behavior                              | Conservative migration                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| AES-CBC or AES-CTR configuration                     | Use the matching read-only 2.1 reader to migrate data to AES-GCM; legacy writes reject |
| `size` configuration                                 | Remove it; built-in drivers have always ignored it as a quota control                  |
| `destroy()`                                          | Use idempotent, non-destructive `close()`                                              |
| Mutating the object returned by `config()`           | Treat configuration as readonly and pass options to `createInstance()`                 |
| Matching batch and single hooks in one custom plugin | Define one hook form per phase; retain the 2.x `isBatch` guard until migrated          |
| React Native adapter auto-detection                  | Import `localspace/react-native` and inject `reactNativeAsyncStorage` explicitly       |
| Package deep imports                                 | Import only `localspace` or `localspace/react-native`                                  |

Package deep imports have no executable compatibility entry on which a runtime
warning could be attached: the `exports` map rejects them immediately. The
release tests keep that boundary explicit rather than adding a temporary deep
entry that would expand the supported package surface.

### Close Instances Without Deleting Data

Use `await instance.close()` when an instance is no longer needed. The method
is idempotent, cleans only initialized plugins, releases the active driver
connection, and leaves stored data intact. A closed instance is terminal and
later operations reject with `INSTANCE_CLOSED` before plugin initialization or
hooks; create a new instance to access the same persisted namespace again.

`destroy()` remains available during 2.x with its historical plugin-only
cleanup behavior, but is deprecated. Use `clear()` or `dropInstance()` only
when the intent is to delete data.

### Prepare Plugin Data For 3.0 Rollback

The 2.1 built-in plugin readers understand both legacy 2.x payloads and the
versioned 3.0 envelope documented in the plugin guide. Writers remain on the
legacy format in 2.1. This makes a data-layer rollback possible after a 3.0
writer has been introduced, while unknown envelope versions fail explicitly
instead of being exposed as plaintext or ordinary application objects.

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

LocalSpace 2.1 retains the 2.0 transaction runner contract. IndexedDB provides
a native transaction while the runner is issuing transaction-scope requests.
The memory driver restores a snapshot after a failed readwrite transaction but
does not isolate concurrent callers. Ordinary instance operations awaited by a
runner remain outside the transaction. The transaction-bound runner and
cross-driver isolation contract are deferred to 3.0. localStorage and React
Native AsyncStorage reject `runTransaction()` with `UNSUPPORTED_OPERATION`.

LocalSpace 2.1 also rejects `runTransaction()` and `iterate()` while a built-in
encryption, compression, or TTL plugin is active. Earlier 2.x releases exposed
raw plugin envelopes or allowed transaction writes to bypass transformations.
Use item/batch APIs until plugin-aware transaction scopes are available.

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
