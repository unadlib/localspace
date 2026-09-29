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
  type StorageValueInput,
  type TTLPluginOptions,
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

Public writes use the recursive `StorageValueInput<T>` check, so normal named
interfaces work without adding a string index signature. It rejects common
unsupported leaf types while retaining the caller's precise DTO type:

```ts
interface StoredProfile {
  name: string;
  roles: string[];
  preferences: { compact: boolean };
}

const profile: StoredProfile = await store.setItem('profile', input);
```

TypeScript is structurally typed and cannot distinguish every data-only class
from an interface. Runtime validation remains authoritative for prototypes,
descriptors, cycles, finite numbers, detached buffers, and reserved envelopes.

Every application value and every plugin-produced write value is validated.
The runtime accepts only:

- `null`, booleans, finite numbers, and strings;
- non-detached `ArrayBuffer` values and the typed arrays listed above;
- dense arrays containing supported values and no custom/symbol properties;
- ordinary plain objects with enumerable own data properties whose values are
  supported.

The runtime rejects `undefined`, `bigint`, symbols, functions, non-finite
numbers, sparse arrays, accessors, non-enumerable properties, symbol keys,
cycles, `SharedArrayBuffer`, shared-memory views, `DataView`, `Blob`, `Date`,
`Map`, `Set`, `RegExp`, null-prototype objects, and class instances with
`SERIALIZATION_FAILED`. The exact top-level `localspace.plugin` envelope
namespace is reserved for built-in storage transforms and is rejected when
supplied by application or logical-plugin output. Accepted values are copied
and normalized before persistence; for example, negative zero is read back as
zero.

Ordinary JSON-compatible values and top-level native binary values are stored
without a universal core wrapper. String-backed drivers and byte transforms
use the versioned `__lsv__:1:` representation only when binary is nested inside
an array or object; ordinary JSON serialization is unchanged. The historical
top-level localForage binary marker remains the representation for top-level
binary values on string-backed drivers.

The abandoned `localspace.record` namespace has no special meaning and values
using it are returned as application data. Objects that merely contain a
`__localspace__` property or another namespace are also ordinary values.

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
not change after readiness, driver fallback/switching, or plugin setup. The
validation/plugin dispatch graph is compiled once for each selected driver
session.

### `getItem<T = StorageValue>(key): Promise<T | null>`

Returns the decoded logical value, or `null` when the key does not exist or a
plugin intentionally hides it.

The read generic describes the DTO the caller expects; it is not a decoder or
runtime assertion. Reading as a class type does not construct that class.

```ts
const profile = await store.getItem<{
  name: string;
  active: boolean;
}>('profile');
```

### `setItem<T>(key, value: T & StorageValueInput<T>): Promise<T>`

Validates, copies, transforms, and stores one value. Validation happens before
plugin or driver side effects. The returned value is the logical write result,
not a plugin envelope or serialized representation.

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

The localStorage and React Native drivers store the default store under the
`name/` key prefix and named stores under `name/storeName/`. A named store
records itself under `localspace:stores:<name>` on its first write, and
default-store scans (`clear`, `keys`, `iterate`, `length`, `key`, and
`dropInstance`) skip keys under a registered store prefix. Named stores written
only by 2.x releases are not registered until a 3.x instance writes to them, and
default-store keys that start with a registered `storeName/` prefix are treated
as belonging to that named store.

### `length(): Promise<number>`

Returns the number of logical visible items. Built-in TTL expiration is applied
before counting, and custom plugins can define `isValueVisible`, so `getItem`,
`iterate`, `keys`, `key`, and `length` agree. Read transforms that cannot affect
visibility do not force a value scan.

### `keys(): Promise<string[]>`

Returns logical visible keys in driver iteration order.

### `key(index): Promise<string | null>`

Returns the logical visible key at a zero-based index, or `null` when the index
is outside the current key list. Indexes that are not safe integers (`NaN`,
`Infinity`, fractions) reject with `INVALID_ARGUMENT`.

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
`undefined`. LocalSpace does not materialize the complete value set first:
drivers stop immediately or after a bounded internal page. Outside an explicit
transaction, writes interleaved between pages may be observed by later pages.

## Batch methods

```ts
type KeyValuePair<T> = { key: string; value: T };

type BatchItems<T> =
  | Array<KeyValuePair<T>>
  | Map<string, T>
  | Record<string, T>;

type BatchResponse<T> = Array<{ key: string; value: T | null }>;
```

### `setItems<T>(entries: BatchItems<T & StorageValueInput<T>>): Promise<BatchResponse<T>>`

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

### `getItems<T = StorageValue>(keys): Promise<BatchResponse<T>>`

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
  get<T = StorageValue>(key: string): Promise<T | null>;
  set<T>(key: string, value: T & StorageValueInput<T>): Promise<T>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  iterate<T = StorageValue, U = void>(
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
  `TRANSACTION_SCOPE_REQUIRED` for the complete admitted transaction, including
  plugin initialization and before/after observers — not only while the runner
  callback happens to be executing;
- any overlapping `runTransaction()` on that instance also rejects with
  `TRANSACTION_SCOPE_REQUIRED`; LocalSpace cannot distinguish a nested call
  from unrelated concurrent code, and queueing a nested call could deadlock;
- transaction admission follows invocation order. Capability and argument
  validation run before the transaction window is claimed, so an unsupported
  or invalid transaction attempt does not reject unrelated ordinary work;
- start independent same-instance transactions sequentially with `await`, not
  together with `Promise.all()`;
- a retained scope rejects after the runner settles;
- `readonly` scopes reject `set`, `remove`, and `clear` with
  `TRANSACTION_READONLY`;
- a rejected/failed runner rolls back writes while the native transaction is
  still active;
- the runner result becomes the `runTransaction()` result;
- plugin transforms and observers run inside the transaction and receive
  `context.transactionScope`;
- outer `beforeRunTransaction`/`afterRunTransaction` observers bracket driver
  execution; the after observer runs only following a successful commit and
  neither observer receives the runner result;
- an IndexedDB transaction that becomes natively inactive before settlement
  rejects with `TRANSACTION_INACTIVE`.

Inside the runner, await only Promises returned by the supplied scope. Timers,
network requests, prompts, and arbitrary external Promises can leave IndexedDB
with no pending native request, allowing it to commit. If a later scope call
detects that condition, `TRANSACTION_INACTIVE` reports a contract violation; it
cannot undo a native transaction that has already completed. Such work belongs
before or after `runTransaction()`.

An `afterRunTransaction` observer error is reported through `onError` (or the
console) without replacing the successful transaction result. The commit has
already happened, so the public promise remains a reliable commit signal.

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
| `pluginErrorPolicy`       | `'lenient'`             | controls transform/pre-settlement failures; void after-observer failures are always reported                 |
| `plugins`                 | `[]`                    | construction-time plugins                                                                                    |
| `drivers`                 | `[]`                    | construction-scoped immutable driver definitions                                                             |

The removed `size`, `strictValues`, `strictTransactions`,
`prewarmTransactions`, `connectionIdleMs`, and `maxConcurrentTransactions`
options reject with `INVALID_CONFIG` instead of being ignored. In 3.0 value
validation and transaction-scope enforcement are always enabled.

JavaScript callers receive `INVALID_CONFIG` for malformed driver/plugin lists,
unknown policy/durability values, invalid driver names, and non-callable plugin
hooks. Invalid choices are never silently coerced to a default policy.

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

| Driver          | `transactions` | `atomicBatch`   | `dropInstance` | `persistent` | `storageBuckets`               |
| --------------- | -------------- | --------------- | -------------- | ------------ | ------------------------------ |
| IndexedDB       | `true`         | `!maxBatchSize` | `true`         | `true`       | detected from selected backend |
| localStorage    | `false`        | `false`         | `true`         | `true`       | `false`                        |
| memory          | `true`         | `false`         | `true`         | `false`      | `false`                        |
| RN AsyncStorage | `false`        | `false`         | `true`         | `true`       | `false`                        |

### `getDriver(name): Promise<Readonly<Driver>>`

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

For IndexedDB, deletion remains inside the instance's selected Storage Bucket.
To delete from another bucket, construct an instance with that bucket first;
LocalSpace rejects a cross-bucket `dropInstance()` instead of risking deletion
through the wrong IndexedDB factory.

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
driver definition without modifying the caller's object. Inherited definition
members are copied into that snapshot, so later mutation of the caller's object
or prototype does not reconfigure registered behavior. Each selected instance
receives a distinct session receiver shared by `_initStorage`, operations, and
`_closeStorage`.

A driver requires `_driver`, `_initStorage`, `clear`, `getItem`, `iterate`,
`key`, `keys`, `length`, `removeItem`, and `setItem`. `dropInstance`, batch
methods, `runTransaction`, and `_closeStorage` are optional. `_support` may be a
boolean or a sync/async probe. A custom driver's `iterate` implementation must
await callback results sequentially and stop before reading the next item when
the callback resolves to a non-`undefined` result.

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
`DRIVER_UNAVAILABLE`; an adapter missing `getItem`, `setItem`, `removeItem`, or
`getAllKeys` rejects with `INVALID_CONFIG`. `clear` and the `multi*` methods are
optional optimizations. RN selection never silently falls back.

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

Plugin lifecycle callbacks receive a callback-scoped guarded receiver in
`context.instance`. Same-instance storage or lifecycle reentry during an async
lifecycle callback rejects to prevent deadlocks. Operation hooks receive the
public instance instead. `context.instanceToken` provides stable, non-callable
identity across all hooks, and transaction hooks receive
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

Browser certification is exact rather than aspirational: the frozen lockfile's
Chromium, Firefox, and WebKit engines are logged and tested independently. A
real Safari build is recorded and smoke-tested before GA; Playwright WebKit is
not presented as Safari evidence. Edge, multiple browser majors, and Firefox
ESR are not claimed without separate jobs.

Node.js 22/24 cover package imports, JavaScript tests, and custom drivers, but
the public declarations intentionally expose browser storage and Web Crypto
types. TypeScript-only Node consumers therefore include the `DOM` library (or
use `skipLibCheck`). React Native certification uses the exact 0.83.x / 2.2.x
fixture and registry RC tarball. Prefixed IndexedDB, WebSQL, and a built-in
persistent Node driver are outside the contract.
