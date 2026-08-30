# API Reference

This reference describes the LocalSpace 3.0 public contract. Import runtime
APIs from `localspace`; import the explicit React Native helpers from
`localspace/react-native`.

```ts
import localspace, {
  LocalSpace,
  LocalSpaceError,
  type LocalSpaceInstance,
  type StorageValue,
} from 'localspace';
```

## Package exports

| Specifier                 | Contents                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `localspace`              | default instance, `LocalSpace`, web/memory drivers, types, plugins, errors, serializer, and driver registration |
| `localspace/react-native` | explicit AsyncStorage driver installation and instance helpers                                                  |
| `localspace/package.json` | package metadata                                                                                                |

Other deep imports are unsupported. The published tarball does not include
`src/`; runtime source maps embed `sourcesContent` for mapped stack traces.

## Storage values

```ts
type StoragePrimitive = null | boolean | number | string;

type StorageBinary =
  | ArrayBuffer
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

type StorageValue =
  | StoragePrimitive
  | StorageBinary
  | StorageValue[]
  | { [key: string]: StorageValue };
```

Every application value and every plugin-produced write value is validated.
The runtime accepts only:

- `null`, booleans, finite numbers, and strings;
- non-detached `ArrayBuffer` values and the typed arrays listed above;
- dense arrays containing supported values and no custom/symbol properties;
- ordinary or null-prototype objects with enumerable own data properties whose
  values are supported.

The runtime rejects `undefined`, `bigint`, symbols, functions, non-finite
numbers, sparse arrays, accessors, non-enumerable properties, symbol keys,
cycles, `SharedArrayBuffer`, shared-memory views, `DataView`, `Blob`, `Date`,
`Map`, `Set`, `RegExp`, and class instances with `SERIALIZATION_FAILED`.
Accepted values are copied and normalized before persistence; for example,
negative zero is read back as zero.

LocalSpace encodes every accepted 3.0 logical write in a versioned
StoredRecord. It still reads unwrapped 2.x values. A 3.0-written user object
with a `__localspace__` property—even one exactly shaped like a valid record—is
wrapped as payload and therefore cannot collide with the outer marker. Unknown
LocalSpace record versions fail with `DESERIALIZATION_FAILED` instead of being
guessed.

A raw value written before 3.0 that is already _exactly_ identical to the full
reserved StoredRecord grammar is inherently ambiguous because 2.x did not
escape that future marker. Marker-like objects with another namespace/shape
remain ordinary values. Audit this exceptional exact-shape case before deploying
the bridge forward reader; no reader can infer the original intent from the
persisted bytes alone.

## Creating instances

### Default instance

```ts
import localspace from 'localspace';

await localspace.setItem('key', 'value');
```

The default instance uses IndexedDB followed by localStorage. It uses the
permanently frozen historical namespace `localforage/keyvaluepairs`.

### `new LocalSpace(options?)`

```ts
import { LocalSpace } from 'localspace';

const store = new LocalSpace({
  name: 'my-app',
  storeName: 'settings',
});
```

### `createInstance(options?)`

```ts
const store = localspace.createInstance({
  name: 'my-app',
  storeName: 'cache',
});
```

Each instance owns its configuration, plugin manager, and driver sessions.
Construction-scoped custom driver definitions do not leak to another instance.

## Core storage methods

All public operation methods are stable facade functions: their identity does
not change after readiness, driver fallback/switching, or plugin setup.

### `getItem<T extends StorageValue>(key): Promise<T | null>`

Returns the decoded logical value, or `null` when the key does not exist or a
plugin intentionally hides it.

```ts
const profile = await store.getItem<{
  name: string;
  active: boolean;
}>('profile');
```

### `setItem<T extends StorageValue>(key, value): Promise<T>`

Validates, copies, transforms, and stores one value. Validation happens before
plugin or driver side effects. The returned value is the logical write result,
not an internal StoredRecord or plugin envelope.

```ts
const saved = await store.setItem('profile', {
  name: 'Ada',
  active: true,
});
```

Keys are normalized to strings for driver compatibility. Avoid non-string keys
even when calling from plain JavaScript.

### `removeItem(key): Promise<void>`

Removes one item. Removing a missing item resolves normally.

### `clear(): Promise<void>`

Removes all values in the current `name`/`storeName` namespace. It runs the
plugin `beforeClear` and `afterClear` observers.

### `length(): Promise<number>`

Returns the number of logical visible items. Built-in TTL expiration is applied
before counting, so `getItem`, `iterate`, `keys`, `key`, and `length` agree.

### `keys(): Promise<string[]>`

Returns logical visible keys in driver iteration order.

### `key(index): Promise<string | null>`

Returns the logical visible key at a zero-based index, or `null` when the index
is outside the current key list.

### `iterate<T, U>(iterator): Promise<U | undefined>`

```ts
const match = await store.iterate<StorageValue, string>(
  async (value, key, iterationNumber) => {
    await audit(key, value, iterationNumber);
    return key.startsWith('target:') ? key : undefined;
  }
);
```

Iteration exposes decoded logical values. Callbacks are awaited sequentially.
Iteration numbers start at 1. The first non-`undefined` callback result stops
iteration and becomes the result; otherwise the promise resolves to
`undefined`.

## Batch methods

```ts
type KeyValuePair<T> = { key: string; value: T };

type BatchItems<T> =
  | Array<KeyValuePair<T>>
  | Map<string, T>
  | Record<string, T>;

type BatchResponse<T> = Array<{ key: string; value: T | null }>;
```

### `setItems<T extends StorageValue>(entries): Promise<BatchResponse<T>>`

Accepts an entry array, `Map`, or object. Values are validated before plugin or
driver side effects. The response contains logical values in the effective
batch order.

```ts
await store.setItems([
  { key: 'a', value: 1 },
  { key: 'b', value: 2 },
]);
```

On IndexedDB an unchunked call is atomic. When `maxBatchSize` splits the call,
or when another driver is selected, do not assume batch atomicity; inspect
`capabilities().atomicBatch`.

### `getItems<T extends StorageValue>(keys): Promise<BatchResponse<T>>`

Returns one result for each requested key in requested order. Missing or
plugin-hidden values are `null`.

### `removeItems(keys): Promise<void>`

Removes all requested keys. Its atomicity follows the selected driver and batch
configuration.

## Transactions

### `runTransaction<T>(mode, runner): Promise<T>`

```ts
type TransactionMode = 'readonly' | 'readwrite';

interface TransactionScope {
  get<T extends StorageValue>(key: string): Promise<T | null>;
  set<T extends StorageValue>(key: string, value: T): Promise<T>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  iterate<T extends StorageValue, U>(
    iterator: (value: T, key: string, iterationNumber: number) => U | Promise<U>
  ): Promise<U | undefined>;
  clear(): Promise<void>;
}
```

```ts
const result = await store.runTransaction('readwrite', async (tx) => {
  const current = (await tx.get<number>('counter')) ?? 0;
  await tx.set('counter', current + 1);
  return current + 1;
});
```

Contract:

- the runner must use only the supplied scope for same-instance storage work;
- every ordinary facade operation on that instance rejects with
  `TRANSACTION_SCOPE_REQUIRED` while the runner is active;
- a retained scope rejects after the runner settles;
- `readonly` scopes reject `set`, `remove`, and `clear` with
  `TRANSACTION_READONLY`;
- a rejected/failed runner rolls back writes;
- the runner result becomes the `runTransaction()` result;
- plugin transforms and observers run inside the transaction and receive
  `context.transactionScope`;
- an IndexedDB transaction that becomes natively inactive before settlement
  rejects with `TRANSACTION_INACTIVE`.

IndexedDB uses one native object-store transaction and keeps it active across
awaited scope work. Memory serializes read-write runners per JavaScript realm,
`name`, and `storeName`, using a private snapshot and atomic commit. LocalSpace
adds no cross-tab/process lock or replication layer. Native IndexedDB scheduling
still applies across contexts that open the same backend; memory isolation is
realm-local.

localStorage and React Native AsyncStorage report `transactions: false` and
reject before invoking the runner.

## Configuration

### `config(): LocalSpaceConfigSnapshot`

Returns a detached, deeply frozen snapshot. Mutating the original constructor
inputs or the returned snapshot cannot change the active instance.

### `config(key): LocalSpaceConfigSnapshot[key] | undefined`

Returns one field from a fresh immutable snapshot.

```ts
const name = store.config('name');
const config = store.config();
```

`config(options)` was removed. Pass configuration when constructing an
instance. JavaScript calls that attempt the old setter throw `INVALID_ARGUMENT`.

### Options

```ts
interface LocalSpaceConfig {
  description?: string;
  durability?: IDBTransactionOptions['durability'];
  bucket?: {
    name: string;
    durability?: 'relaxed' | 'strict';
    persisted?: boolean;
  };
  maxBatchSize?: number;
  driver?: string | string[];
  reactNativeAsyncStorage?: ReactNativeAsyncStorage;
  name?: string;
  storeName?: string;
  version?: number;
  pluginInitPolicy?: 'fail' | 'disable-and-continue';
  pluginErrorPolicy?: 'strict' | 'lenient';
}

interface LocalSpaceOptions extends LocalSpaceConfig {
  plugins?: LocalSpacePlugin[];
  drivers?: readonly Driver[];
}
```

| Option                    | Default                 | Notes                                                                                                        |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `name`                    | `'localforage'`         | permanently frozen compatibility default; set explicitly for new apps                                        |
| `storeName`               | `'keyvaluepairs'`       | permanently frozen compatibility default                                                                     |
| `version`                 | `1`                     | positive safe integer IndexedDB version                                                                      |
| `driver`                  | IndexedDB, localStorage | ordered selection; memory is opt-in                                                                          |
| `description`             | `''`                    | descriptive metadata                                                                                         |
| `durability`              | browser default         | IndexedDB read-write durability hint                                                                         |
| `bucket`                  | none                    | explicit Storage Bucket; failure never silently falls back                                                   |
| `maxBatchSize`            | unset                   | non-negative safe integer; `0`/unset means no split                                                          |
| `reactNativeAsyncStorage` | none                    | required when selecting the RN driver                                                                        |
| `pluginInitPolicy`        | `'fail'`                | optionally disable a plugin whose initialization fails                                                       |
| `pluginErrorPolicy`       | `'lenient'`             | unexpected custom-plugin errors may be reported and swallowed; structured/fail-closed errors still propagate |
| `plugins`                 | `[]`                    | construction-time plugins                                                                                    |
| `drivers`                 | `[]`                    | construction-scoped immutable driver definitions                                                             |

The removed `size`, `strictValues`, `strictTransactions`,
`prewarmTransactions`, `connectionIdleMs`, and `maxConcurrentTransactions`
options reject with `INVALID_CONFIG` instead of being ignored. In 3.0 value
validation and transaction-scope enforcement are always enabled.

### Plugin registration lock

`use(pluginOrPlugins)` registers plugins only before the first `ready()` or
storage operation. It returns the same instance. Duplicate names or late
registration reject atomically.

```ts
store.use(myPlugin);
await store.ready();
```

## Driver methods

### `ready(): Promise<void>`

Selects and initializes a driver. Storage operations call it lazily, so an
explicit call is optional but useful for surfacing initialization errors.

### `driver(): string | null`

Returns the selected driver name, or `null` before selection.

### `setDriver(driverOrOrder): Promise<void>`

Selects a supported driver from the requested order and initializes a fresh
private session. It does not replace public method functions. Driver switching
waits for earlier initialization, drains active work, releases the previous
session, and retains failed cleanup for retry.

Call it only while the instance is idle. Lifecycle reentry or an active
transaction/operation rejects rather than deadlocking.

### `supports(driverName): boolean`

Reports whether a registered driver definition has resolved as supported in
the current realm.

### `capabilities(): LocalSpaceCapabilities`

```ts
interface LocalSpaceCapabilities {
  readonly transactions: boolean;
  readonly atomicBatch: boolean;
  readonly dropInstance: boolean;
  readonly persistent: boolean;
  readonly storageBuckets: boolean;
}
```

Returns a frozen snapshot for the selected initialized session. Before
initialization it throws `DRIVER_NOT_INITIALIZED`; after close it throws
`INSTANCE_CLOSED`.

| Driver          | `transactions` | `atomicBatch`   | `dropInstance`           | `persistent` | `storageBuckets`               |
| --------------- | -------------- | --------------- | ------------------------ | ------------ | ------------------------------ |
| IndexedDB       | `true`         | `!maxBatchSize` | `true`                   | `true`       | detected from selected backend |
| localStorage    | `false`        | `false`         | `true`                   | `true`       | `false`                        |
| memory          | `true`         | `false`         | `true`                   | `false`      | `false`                        |
| RN AsyncStorage | `false`        | `false`         | adapter has `getAllKeys` | `true`       | `false`                        |

### `getDriver(name): Promise<Driver>`

Returns the immutable registered definition, not the active private session.
Unknown names reject with `DRIVER_NOT_FOUND`.

### `getSerializer(): Promise<Serializer>`

Returns LocalSpace's compatibility serializer. Application code normally uses
the higher-level StorageValue API.

### `dropInstance(options?): Promise<void>`

Deletes a namespace when supported. Without options it targets the current
`name`/`storeName`; supplied options may select another namespace supported by
the driver. It runs plugin drop observers and rejects early when
`capabilities().dropInstance` is false.

### Custom driver registration

Construction-scoped registration is preferred:

```ts
const store = new LocalSpace({
  driver: customDriver._driver,
  drivers: [customDriver],
});
```

For deliberate realm-wide registration:

```ts
import { registerDriver } from 'localspace';

await registerDriver(customDriver);
await registerDriver(replacement, { overwrite: true });
```

`instance.defineDriver()` no longer exists. LocalSpace snapshots and freezes a
driver definition without modifying the caller's object. Each selected
instance receives a distinct session receiver shared by `_initStorage`,
operations, and `_closeStorage`.

A driver requires `_driver`, `_initStorage`, `clear`, `getItem`, `iterate`,
`key`, `keys`, `length`, `removeItem`, and `setItem`. `dropInstance`, batch
methods, `runTransaction`, and `_closeStorage` are optional. `_support` may be a
boolean or a sync/async probe.

```ts
interface DriverCapabilities {
  transactions?: boolean;
  atomicBatch?: boolean;
  dropInstance?: boolean;
  persistent?: boolean;
  storageBuckets?: boolean;
}
```

Declare guarantees with `_capabilities` or a synchronous capability resolver.
Omitted values use conservative method-derived defaults. Unknown fields,
non-boolean values, or guarantees without matching methods reject with
`DRIVER_COMPLIANCE`.

## Storage Buckets

```ts
const store = localspace.createInstance({
  name: 'my-app',
  bucket: {
    name: 'critical-data',
    durability: 'strict',
    persisted: true,
  },
});
```

`bucket` is an explicit requirement, not a preference. If the Storage Buckets
API is unavailable, opening fails, or the returned bucket lacks IndexedDB,
`ready()` rejects. LocalSpace does not open the default IndexedDB backend and
does not continue to localStorage. `capabilities().storageBuckets` describes
the initialized backend when no bucket was explicitly required.

## React Native

The main entry does not register the React Native driver. Runtime module/global
detection has been removed; an explicit AsyncStorage-compatible adapter is
required.

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

The helper creates a construction-scoped driver instance, selects the RN
driver first, and awaits readiness. A missing adapter rejects with
`DRIVER_UNAVAILABLE`; a malformed adapter rejects with `INVALID_CONFIG`. RN
selection never silently falls back.

Realm-wide installation is available for advanced integrations:

```ts
import { installReactNativeAsyncStorageDriver } from 'localspace/react-native';

await installReactNativeAsyncStorageDriver();
```

The function takes no arguments. A separately constructed instance must still
provide `reactNativeAsyncStorage`.

## Plugins and lifecycle

### `use(plugin | plugins): LocalSpaceInstance`

Registers one or more plugins before the configuration lock. See
[Plugin System](./plugins.md) for the complete hook contract.

### `close(): Promise<void>`

Closes the instance without deleting data. It pauses background plugin work,
runs `onDestroy` for initialized plugins, and releases the selected driver
session. It is idempotent; later storage/lifecycle operations reject with
`INSTANCE_CLOSED`.

If cleanup rejects, the instance remains closed and a later `close()` retries
only unfinished cleanup. `destroy()` was removed; use `close()` for disposal,
`clear()` for current-store deletion, or `dropInstance()` for namespace
deletion.

Plugin lifecycle callbacks receive the public stable instance in
`context.instance` and a callback-scoped guarded receiver in
`context.lifecycleInstance`. Same-instance storage or lifecycle reentry during
an async lifecycle callback rejects to prevent deadlocks. Operation hooks do
not receive `lifecycleInstance`; transaction hooks receive
`context.transactionScope`.

## Error contract

```ts
type LocalSpaceErrorCode =
  | 'CONFIG_LOCKED'
  | 'INVALID_CONFIG'
  | 'DRIVER_COMPLIANCE'
  | 'DRIVER_NOT_FOUND'
  | 'DRIVER_UNAVAILABLE'
  | 'DRIVER_NOT_INITIALIZED'
  | 'INSTANCE_CLOSED'
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_ARGUMENT'
  | 'TRANSACTION_SCOPE_REQUIRED'
  | 'TRANSACTION_INACTIVE'
  | 'TRANSACTION_READONLY'
  | 'SERIALIZATION_FAILED'
  | 'DESERIALIZATION_FAILED'
  | 'BLOB_UNSUPPORTED'
  | 'OPERATION_FAILED'
  | 'QUOTA_EXCEEDED'
  | 'UNKNOWN';
```

```ts
import { LocalSpaceError } from 'localspace';

try {
  await store.setItem('bad', Number.NaN);
} catch (error) {
  if (error instanceof LocalSpaceError) {
    console.log(error.code);
    console.log(error.details);
    console.log(error.cause);
  }
}
```

LocalSpace preserves an underlying browser, driver, crypto, or plugin error as
`cause` when wrapping it. Use `code` for program logic and `details` for
diagnostics; do not parse message text.

## Platform boundary

The 3.0 release target is current unprefixed IndexedDB on recent Chromium,
Firefox, and Safari engines; Node.js 22/24 for imports, types, tests, and custom
drivers; and React Native 0.83.x with AsyncStorage 2.2.x. Prefixed IndexedDB,
WebSQL, and a built-in persistent Node driver are outside the contract.
