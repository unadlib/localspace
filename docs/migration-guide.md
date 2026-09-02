# Migration Guide

## Upgrade from 2.1.x to 3.0

LocalSpace 3.0 makes driver behavior, stored values, plugins, and transactions
explicit. It reads supported 2.x data, but it is a source-breaking upgrade and
every application should stage the migration through the final 2.1.x bridge.

```bash
pnpm add localspace@^3.0.0
```

Do not use an unpinned `latest` tag for a rollback plan. Record the exact 2.1.x
bridge and 3.0 versions (including tarball integrity) used by the application.

### Before upgrading

1. Upgrade to the final 2.1.x bridge release named by the 3.0 release notes.
2. Run development builds and clear every emitted migration warning.
3. Enable `strictValues: true` on the bridge and exercise every write path.
4. Enable `strictTransactions: true` and refactor transaction runners to use
   only their supplied scope.
5. Convert custom plugins to the 3.0 single-or-batch hook model.
6. Back up representative production data and rehearse the exact package/data
   upgrade and rollback sequence.

`strictValues` and `strictTransactions` are 2.1 bridge-only migration aids.
LocalSpace 3.0 enforces both contracts unconditionally and rejects the options
themselves.

### Breaking-change summary

| 2.1.x API or behavior                                                  | 3.0 migration                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `config(options)` setter                                               | pass all options to `new LocalSpace()` or `createInstance()`                            |
| mutable objects returned from `config()`                               | treat the detached, deeply frozen snapshot as readonly                                  |
| `instance.defineDriver()`                                              | use construction-scoped `drivers` or exported realm-wide `registerDriver()`             |
| treating `getDriver()` output or custom-driver inputs as mutable state | treat definitions as readonly; keep mutable state on the selected driver session        |
| underscored `LocalSpaceInstance` implementation fields                 | stop accessing them; use the supported facade, config, capability, and driver APIs      |
| `PluginContext.dbInfo`                                                 | branch on `context.driver` and read `context.config`; driver internals are not exposed  |
| `destroy()`                                                            | use `close()` for disposal, `clear()`/`dropInstance()` for deletion                     |
| `size` configuration                                                   | remove it; built-in drivers never used it as quota enforcement                          |
| broad arbitrary value generics                                         | store only `StorageValue`; convert rich values explicitly                               |
| optional `strictValues`                                                | remove it; validation is always enabled                                                 |
| optional `strictTransactions`                                          | remove it; transaction-scope enforcement is always enabled                              |
| ordinary facade calls inside a transaction runner                      | use only `tx.get/set/remove/keys/iterate/clear`                                         |
| memory snapshot rollback without isolation                             | rely on the new serialized realm/namespace contract, or remove transaction assumptions  |
| localStorage/RN transaction stubs                                      | check `capabilities().transactions`; unsupported calls reject early                     |
| `prewarmTransactions`, `connectionIdleMs`, `maxConcurrentTransactions` | remove them; supplying them is `INVALID_CONFIG`                                         |
| matching single and batch hooks both executing                         | remove `isBatch` dedup guards; 3.0 chooses the batch hook or maps the single hook       |
| plugins not covering query/iteration/clear/drop/transaction            | adopt dedicated observers and logical views                                             |
| text/string custom compression codecs                                  | rewrite both codec methods as `Uint8Array`-to-`Uint8Array` functions                    |
| both encryption `key` and `keyDerivation`                              | choose exactly one key source                                                           |
| caller-owned `algorithm.iv`                                            | remove it; use `ivLength`/`ivGenerator` only when overriding writer-owned IV generation |
| synchronous-only/always-`U` iterate assumptions                        | callbacks may be async; result is either `U` or `undefined`                             |
| RN adapter auto-detection                                              | import `localspace/react-native` and inject AsyncStorage explicitly                     |
| explicit RN adapter without `getAllKeys`                               | add `getAllKeys`; selection validates the complete query/namespace capability           |
| `installReactNativeAsyncStorageDriver(instance)`                       | prefer `createReactNativeInstance`; the realm-global installer now takes no argument    |
| Storage Bucket fallback to default backend                             | handle readiness failure; a requested bucket never falls back                           |
| AES-CBC/AES-CTR normal encryption config                               | use the read-only legacy migration plugin, then write AES-GCM data elsewhere            |
| synthetic `PluginStage: 'error'` or exhaustive 2.1 operation switches  | use the actual hook stage and handle all new operation kinds                            |
| exhaustive `LocalSpaceErrorCode` switches                              | handle `TRANSACTION_SCOPE_REQUIRED` and `TRANSACTION_INACTIVE` explicitly               |
| package source/deep imports                                            | import only `localspace`, `localspace/react-native`, or `localspace/package.json`       |
| prefixed IndexedDB/WebSQL assumptions                                  | require modern unprefixed IndexedDB; migrate WebSQL data first                          |

The removed 2.1 declaration members are `_initReady`, `_ready`, `_dbInfo`,
`_driver`, `_driverSet`, `_initDriver`, `_config`, `_defaultConfig`,
`_initStorage`, `_extend`, `_getSupportedDrivers`, and
`_wrapLibraryMethodsWithReady`. They were implementation state, not a stable
extension API. Custom drivers keep mutable state on their selected session
receiver and declare capabilities instead of patching the public instance.

## Migrate configuration

Move setter calls into construction:

```ts
// 2.1.x
const store = localspace.createInstance();
await store.config({
  name: 'my-app',
  storeName: 'settings',
});

// 3.0
const store = localspace.createInstance({
  name: 'my-app',
  storeName: 'settings',
});
```

`config()` and `config(key)` are reads only:

```ts
const snapshot = store.config();
const name = store.config('name');

// snapshot and nested fields are frozen; create a new instance to change them.
```

Constructor inputs are snapshotted. Later mutations to driver arrays, bucket
objects, adapters, or plugin arrays do not reconfigure an instance. `use()` is
allowed only before the first `ready()` or storage call.

Remove these options entirely:

```ts
// Removed in 3.0; they are not ignored.
{
  size,
  strictValues,
  strictTransactions,
  prewarmTransactions,
  connectionIdleMs,
  maxConcurrentTransactions,
}
```

Keep `maxBatchSize` only when intentional. On IndexedDB, setting it splits a
large batch into multiple transactions, so `capabilities().atomicBatch` is
`false`.

## Migrate values

### Accepted contract

The 3.0 `StorageValue` contract consists of:

- `null`, booleans, finite numbers, and strings;
- `ArrayBuffer` and standard integer/float typed arrays;
- dense arrays of supported values;
- ordinary plain objects with enumerable own data properties containing
  supported values.

Everything else must be encoded by the application. Validation occurs before
plugin and driver side effects for `setItem`, every `setItems` entry, and
transaction `set`.

### Common conversions

```ts
// Date
await store.setItem('created-at', date.toISOString());

// Map with string keys
await store.setItem('counts', Object.fromEntries(countMap));

// Set
await store.setItem('tags', [...tagSet]);

// RegExp
await store.setItem('pattern', {
  source: expression.source,
  flags: expression.flags,
});

// bigint scalar
await store.setItem('large-id', largeId.toString());

// optional fields: omit them or choose null explicitly
await store.setItem('profile', {
  nickname: nickname ?? null,
});

// class instance
await store.setItem('account', {
  id: account.id,
  active: account.active,
});
```

Also remove cycles, accessors, symbol/non-enumerable properties, sparse arrays,
null-prototype objects, `Blob`, `DataView`, `SharedArrayBuffer`, shared-memory
views, `NaN`, and infinities. Detached `ArrayBuffer` values and typed-array
views are invalid. The exact top-level `localspace.plugin` envelope namespace
is reserved for built-in transforms and cannot be written as application data.

TypeScript writes now use `StorageValueInput<T>`, a recursive structural check
that accepts named interfaces without requiring a string index signature while
rejecting common unsupported leaves. Read generics describe the expected DTO;
they do not construct or validate a class:

```ts
interface StoredUser {
  id: string;
  roles: string[];
  lastSeen: string | null;
}

await store.setItem<StoredUser>('user', value);
const user = await store.getItem<StoredUser>('user');
```

Do not type a read as a rich runtime class and expect LocalSpace to construct
it. Decode the stored DTO after reading.

### Existing out-of-contract data

3.0 retains legacy 2.x readers, but the old representation may already differ
by driver (`Date`, `Map`, and similar values could have been stringified or
lost during fallback). Use the 2.1 bridge to enumerate representative data,
convert it to explicit plain DTOs, and write those DTOs before depending on the
3.0 contract. Reading an old value does not automatically rewrite it.

3.0 does not reserve or interpret the abandoned `localspace.record` namespace;
those objects remain ordinary application data. One older collision boundary
still cannot be automated: raw pre-3.0 application values that exactly match a
complete built-in plugin envelope or a legacy marker payload
(`__ls_ttl`/`__ls_compressed`/`__ls_encrypted` plus that format's full field
set). A 3.0 reader cannot distinguish such an unwrapped historical value from
plugin metadata. Partial lookalikes remain application data; recognized but
malformed or extended metadata fails closed rather than being guessed. Migrate
any exact collision through raw driver access before enabling the matching
built-in plugin. New application and logical-plugin writes that claim the exact
top-level `localspace.plugin` namespace are rejected so they cannot create new
ambiguity.

## Migrate transactions

The 2.1 runner allowed ordinary instance operations while a driver transaction
was active. That could escape the transaction, deadlock, or commit at a
different time. 3.0 permits only the supplied transaction scope.

```ts
// 2.1.x: no longer valid
await store.runTransaction('readwrite', async () => {
  const current = (await store.getItem<number>('counter')) ?? 0;
  await store.setItem('counter', current + 1);
});

// 3.0
await store.runTransaction('readwrite', async (tx) => {
  const current = (await tx.get<number>('counter')) ?? 0;
  await tx.set('counter', current + 1);
});
```

Available scope methods are `get`, `set`, `remove`, `keys`, `iterate`, and
`clear`. All ordinary facade operations on that instance, including a nested
`runTransaction`, reject with `TRANSACTION_SCOPE_REQUIRED` for the complete
admitted transaction, including plugin initialization and before/after
observers. Admission follows invocation order, so this rejects deterministically
rather than depending on how quickly the driver reaches the runner:

```ts
// 2.1.x: sometimes wrote outside the transaction, sometimes rejected
await Promise.all([
  store.runTransaction('readwrite', async (tx) => tx.set('a', 1)),
  store.setItem('b', 2), // 3.0: always TRANSACTION_SCOPE_REQUIRED
]);
```

Any overlapping `runTransaction()` on the same instance is rejected instead of
queued — including one issued by unrelated code, not just a nested call from
within the runner. LocalSpace cannot tell the two apart, and queueing a nested
call could make it wait for its own caller. Start independent transactions
sequentially:

```ts
await Promise.all([txA(), txB()]); // one rejects in 3.0
await txA();
await txB(); // both run
```

Capability and argument validation happen before the transaction window is
claimed. Calling `runTransaction()` on a non-transactional driver, or passing
invalid transaction arguments, does not make a concurrent ordinary operation
fail with `TRANSACTION_SCOPE_REQUIRED`.

Move unrelated writes out of the runner, or issue them after the transaction
resolves.

A retained scope is invalid after the runner settles. Readonly mutations reject
with `TRANSACTION_READONLY`.

Await only scope operations inside the runner. JavaScript cannot reliably
classify the origin of every Promise, so timers, network requests, prompts, and
other arbitrary waits are unsupported rather than kept alive indefinitely. In
IndexedDB, the browser may commit once no native request remains. A later scope
operation rejects with `TRANSACTION_INACTIVE`, but writes in that already
completed native transaction remain committed; the rejection is not a rollback
signal. Move external work before or after `runTransaction()`.

Check capability after readiness:

```ts
await store.ready();

if (store.capabilities().transactions) {
  await store.runTransaction('readwrite', migrateAtomically);
} else {
  await migrateWithoutAtomicity(store);
}
```

IndexedDB and memory support transactions. localStorage and React Native
AsyncStorage do not. The facade method remains present on every instance for
stable typing, but unsupported calls reject before the runner or plugins run.

Memory now serializes read-write transactions across instances in the same
JavaScript realm and `name`/`storeName`. IndexedDB uses native transaction
scheduling. LocalSpace does not add cross-tab/process locks, notifications, or
conflict resolution; memory isolation is realm-local and IndexedDB retains its
own native cross-context semantics.

Transaction-bound plugin hooks receive `context.transactionScope`. Replace
same-instance facade calls inside those hooks with that scope.

## Migrate custom plugins

### Remove dual-hook guards

In 2.x a batch operation could invoke both a batch hook and its matching single
hook. Many plugins added an `isBatch` guard:

```ts
// 2.x compatibility pattern: remove this guard in 3.0.
beforeSet(key, value, context) {
  if (context.operationState.isBatch) return value;
  return transform(value);
},
beforeSetItems(entries) {
  return transformBatch(entries);
},
```

In 3.0, for each plugin and phase, LocalSpace invokes the batch hook once when
present; otherwise it maps the single hook. Choose either implementation:

```ts
// Simple form: automatically mapped for setItems().
beforeSet(_key, value) {
  return transform(value);
},

// Or optimized batch form. If both are declared, this wins for batch calls.
beforeSetItems(entries) {
  return transformBatch(entries);
},
```

Mapped single hooks may still observe `operationState.isBatch` and `batchSize`
as context, but must not use them to deduplicate execution.

`metadata` is now persistent per plugin instead of shared across the plugin
manager, and `operationState` is isolated per plugin and operation. Remove
cross-plugin coordination through those objects; use an application-owned
channel when plugins intentionally need to communicate.

Plugin definitions are snapshotted at registration. Later mutation of the
caller object or its prototype has no effect, accessor members reject without
running, and the stored definition is frozen. Move mutable `this` state into
`context.metadata`.

### Add complete operation observers

3.0 adds observer pairs for:

- `iterate` (`afterIterate` receives `{ iterations, stopped }`);
- `keys`, `key`, and `length`;
- `clear` and `dropInstance`;
- the outer `runTransaction` lifecycle (`beforeRunTransaction` and
  `afterRunTransaction`).

Observer return values are ignored and result arrays/summaries are frozen.
`clear`/`dropInstance` do not synthesize one remove hook per key.
The outer transaction hooks do not receive the runner result or an active
scope; operation hooks inside the runner continue to receive
`context.transactionScope`. An error from a void after observer is reported
through `onError` (or the console) but cannot reject the operation. This is also
true for item observers inside a transaction; validation that must veto the
transaction belongs in a before hook.

Query operations now materialize the logical decoded view when transforms can
affect visibility. With TTL, an expired item is absent from `getItem`,
`getItems`, `iterate`, `keys`, `key`, and `length`; decide whether custom
visibility transforms need matching logic.

### Validate plugin output

Every value emitted by a write hook must satisfy `StorageValue`. Invalid output
rejects with `SERIALIZATION_FAILED` and identifies the plugin. A transform may
not use arbitrary classes or private marker objects as its persisted protocol.
Use documented plugin hooks and versioned application DTOs.

### Lifecycle and errors

`destroy()` no longer exists. Plugin `onDestroy` runs during `close()` for
initialized plugins. Inside `onInit`/`onDestroy`, `context.instance` is the
callback-scoped receiver; reentry while the callback is pending rejects instead
of deadlocking. Use `context.instanceToken`, not the receiver itself, as the
stable WeakMap key for state shared with operation hooks.

`LocalSpaceError` and `PluginAbortError` from transforms and before hooks
propagate even under lenient policy. Unexpected custom-plugin transform/before
errors are swallowed only under `pluginErrorPolicy: 'lenient'` after
`onError`/console reporting. Void after observers are always reported without
replacing the result, and a failing post-write `afterSetItems` falls back to its
unmodified result. Read transforms (`afterGet`/`afterGetItems`) still follow the
selected policy. Built-in transformations still fail closed.

`PluginContext.dbInfo` is gone. It handed plugins driver internals — the live
`IDBDatabase`, the IndexedDB factory, and the internal key prefix — through an
interface that is supposed to be driver-agnostic, and it was already `null` on
every driver except IndexedDB. A plugin needing backend-specific behaviour
should branch on `context.driver` and read the frozen `context.config`
snapshot; anything beyond that belongs in a custom driver, which owns its own
`_dbInfo` on its session receiver.

`PluginOperation` now includes query, destructive, transaction, and lifecycle
operations. Do not treat the 2.1 union as exhaustive. `PluginStage` no longer
contains the synthetic `'error'` stage; `PluginErrorInfo.stage` identifies the
actual `init`, `before`, `after`, or `destroy` phase that failed. Underscored
facade fields and extension helpers were never supported driver state and are
no longer present on `LocalSpaceInstance`; custom drivers must use their
session receiver and documented methods.

## Migrate custom compression codecs

The 2.1 custom codec accepted text and could return text or bytes. The 3.0
contract is bytes-to-bytes only:

```ts
const codec = {
  compress(input: Uint8Array): Uint8Array {
    return compressBytes(input);
  },
  decompress(input: Uint8Array): Uint8Array {
    return decompressBytes(input);
  },
};

compressionPlugin({ codec, algorithm: 'application-codec-v1' });
```

Both methods must return a real `Uint8Array`; LocalSpace validates and copies
the result. Use a stable, non-empty algorithm label that the same codec can
recognize during reads. The threshold is measured against canonical
uncompressed bytes, and 3.0 writes a compression envelope only when the
complete stored representation is smaller.

## Migrate encryption

Normal encryption is AES-GCM only:

```ts
const store = localspace.createInstance({
  plugins: [
    encryptionPlugin({
      key: aesGcmKey,
    }),
  ],
  pluginErrorPolicy: 'strict',
});
```

Supply exactly one of `key` and `keyDerivation`. Remove any caller-owned
`algorithm.iv`: the 3.0 writer creates a fresh IV for every write. The
`algorithm` object configures only the remaining AES-GCM parameters;
`ivLength`, `ivGenerator`, and `randomSource` are the explicit controlled-
runtime extension points. Both hooks must guarantee that an IV never repeats
under one key across restarts and concurrent writers. LocalSpace can check only
the returned byte length, not uniqueness; omit the hooks to use its default
CSPRNG unless the runtime can enforce that stronger coordination contract. See
[the encryption plugin guide](plugins.md#encryption-plugin) for details.

For AES-CBC or AES-CTR data, open the old namespace with
`legacyEncryptionMigrationPlugin`, read each value, and write it into a
separate AES-GCM instance. The migration reader rejects every write and cannot
be combined with normal encryption on one instance.

Do not perform an in-place clear before the destination has been read back and
verified. Invalid keys, malformed payloads, unknown versions, and crypto errors
reject without overwriting the old value.

## Migrate React Native

3.0 does not inspect globals, call `require`, or create dynamic imports to find
AsyncStorage. Inject it explicitly:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import localspace from 'localspace';
import { createReactNativeInstance } from 'localspace/react-native';

const store = await createReactNativeInstance(localspace, {
  name: 'my-app',
  storeName: 'data',
  reactNativeAsyncStorage: AsyncStorage,
});
```

The adapter must implement `getItem`, `setItem`, `removeItem`, and `getAllKeys`.
Requiring enumeration at selection time ensures `keys`, `key`, `length`,
`clear`, and `dropInstance` cannot fail halfway through the public API because
the adapter is incomplete. `clear` and the multi methods remain optional
optimizations. A missing adapter produces `DRIVER_UNAVAILABLE`; malformed or
missing required methods produce `INVALID_CONFIG`. Selecting the RN driver
never falls through to a web/memory driver after adapter failure.

The 2.1 call `installReactNativeAsyncStorageDriver(instance)` becomes the
no-argument `installReactNativeAsyncStorageDriver()` only for deliberate
realm-wide registration. Prefer `createReactNativeInstance()` for
instance-scoped setup. Every selected instance must still supply the adapter.

## Migrate Storage Buckets

2.1 could warn and silently use default IndexedDB when a requested bucket was
unavailable. In 3.0 the request is a hard data-placement requirement:

```ts
try {
  const store = localspace.createInstance({
    name: 'my-app',
    bucket: { name: 'critical-data', persisted: true },
  });
  await store.ready();
} catch (error) {
  // Decide explicitly whether to stop, prompt, or create a separate
  // non-bucket instance. Reusing the same instance does not fall back.
}
```

Do not silently construct a default-backend fallback unless the application is
prepared for two physically distinct datasets.

Bucket configuration is validated before driver selection. To delete data from
a bucket, use an instance constructed for that same bucket; passing a different
`bucket.name` to `dropInstance()` rejects with `INVALID_ARGUMENT`.

## Migrate iteration

The callback may be async and is awaited sequentially. The return type is
`Promise<U | undefined>`:

```ts
const found = await store.iterate<number, string>(async (value, key) => {
  await inspect(value);
  return value > 10 ? key : undefined;
});

if (found !== undefined) {
  console.log('matched', found);
}
```

Iteration exposes logical decoded values and participates in plugin observers.
It stops without materializing the complete store, although a driver may read a
bounded page. Do not rely on driver/plugin envelopes or leave async callback
promises unawaited. Custom drivers must await each callback result and stop
before reading another item when that result is non-`undefined`.

## Driver registration and capabilities

Replace instance mutation:

```ts
// Removed
await store.defineDriver(customDriver);

// Preferred: instance-scoped
const store = new LocalSpace({
  driver: customDriver._driver,
  drivers: [customDriver],
});

// Deliberate realm-wide registration
await registerDriver(customDriver);
```

LocalSpace snapshots definitions, including inherited members, without
injecting missing methods or state. Mutating either the original object or its
prototype after registration does not reconfigure the registered driver.
Every selection creates an instance-owned session receiver.

Custom drivers should declare `_capabilities`. Optional operations remain
optional on the definition, while the public facade keeps a stable full method
set. Missing/disabled operations reject with `UNSUPPORTED_OPERATION` before
plugin initialization or driver side effects.

## Data compatibility and rollback

Source rollback and data rollback are different:

- **Source rollback** means redeploying older JavaScript.
- **Data rollback** means that older JavaScript can parse every record already
  written by 3.0.

  3.0 reads legacy core values and legacy 2.x TTL, compression, and encryption
  payloads. 3.0 writes:

- ordinary JSON-compatible and native binary values without a universal core
  wrapper;
- selective `__lsv__:1:` values only when nested binary crosses a string/byte
  serialization boundary;
- frozen built-in plugin envelope v1 (`localspace.plugin`, version 1), using
  only payload shapes accepted by the bridge validators.

The published `localspace@2.1.0` understands plugin envelope v1 and ordinary raw
values but does **not** contain the selective nested-binary forward reader. It
is therefore not a safe general data rollback target after 3.0 writes. Use only
the exact final 2.1.x bridge version identified and package-isolated in the 3.0
release evidence. If that bridge has not been published and verified, treat
downgrade after 3.0 writes as unsupported.

Plugin rollback also requires the same application-owned inputs on both sides:
encryption key/derivation and any non-default AES-GCM parameters, plus the same
custom compression codec for its persisted algorithm label. The envelope
identifies a transform; it cannot embed secrets or arbitrary codec
implementations.

A release rehearsal must use actual packages and a shared persistent fixture:

1. write legacy fixtures with the pinned 2.1.x bridge;
2. open/read them with the exact 3.0 candidate;
3. write core and built-in-plugin values with 3.0;
4. reinstall the same pinned 2.1.x bridge in isolation;
5. read every 3.0 fixture without importing code from the workspace;
6. verify malformed and unknown-version values fail without mutation.

Static hand-authored fixtures are useful regression tests but do not prove this
package-level rollback path.

## Namespace compatibility

The defaults `name: 'localforage'` and `storeName: 'keyvaluepairs'` are
permanently frozen through 3.x. Dropping API-level localForage compatibility
does not permit changing these values. Set an explicit application-owned
namespace for new data, but keep the original names when reopening existing
data.

WebSQL is unsupported. Migrate WebSQL records to IndexedDB/localStorage before
the LocalSpace upgrade; no automatic driver fallback can recover a WebSQL-only
dataset.

## Package boundary

Replace imports from source or build internals:

```ts
// Unsupported
import serializer from 'localspace/src/utils/serializer';
import driver from 'localspace/dist/drivers/indexeddb';

// Supported
import localspace, { serializer } from 'localspace';
import { createReactNativeInstance } from 'localspace/react-native';
```

The 3.0 tarball omits source files, TSC intermediate JavaScript, and declaration
maps. Runtime source maps include their TypeScript source content.

## Upgrade from 1.x or migrate from localForage

Applications still on 1.x should first adopt the 2.1.x bridge and its Promise-
only API, then follow every 3.0 step above. In particular:

- replace completion callbacks with `await`/`.then()`;
- replace automatic write coalescing with explicit batch calls;
- move sync/quota policy into application plugins or services;
- remove localStorage/RN transaction assumptions;
- use `close()` for disposal.

Promise-based localForage data in the default IndexedDB/localStorage namespace
can be opened because the default database/store/key layout remains stable and
3.0 reads legacy unwrapped values. Callback APIs are not supported. Existing
rich values must still be converted to `StorageValue`, and WebSQL data requires
an explicit migration first.
