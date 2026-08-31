# localspace

![Node CI](https://github.com/unadlib/localspace/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/localspace.svg)](https://www.npmjs.com/package/localspace)
![license](https://img.shields.io/npm/l/localspace)

LocalSpace is a Promise-first storage toolkit for IndexedDB, localStorage,
in-memory storage, and React Native AsyncStorage. It provides one stable
key-value facade, explicit driver capabilities, scoped transactions, and a
plugin pipeline for TTL, compression, encryption, and application extensions.

LocalSpace keeps a familiar localForage-style API, but it is not a callback-
compatible drop-in replacement. All operations return promises, and LocalSpace
3.0 intentionally narrows stored values to a cross-driver-safe contract.

## Install

```bash
pnpm add localspace
# or: npm install localspace
```

The package publishes ESM, CommonJS, and UMD builds plus TypeScript declarations.
The supported public entry points are `localspace`, `localspace/react-native`,
and `localspace/package.json`; source files and other deep imports are not part
of the package contract.

## Quick start

```ts
import localspace from 'localspace';

await localspace.setItem('user', { name: 'Ada', role: 'admin' });

const user = await localspace.getItem<{
  name: string;
  role: string;
}>('user');

await localspace.removeItem('user');
```

Create an isolated namespace when an application owns the data:

```ts
const cache = localspace.createInstance({
  name: 'my-app',
  storeName: 'cache',
});

await cache.setItem('token', 'abc123');
```

The historical defaults are permanently frozen as `name: 'localforage'` and
`storeName: 'keyvaluepairs'`. They preserve access to compatible existing
IndexedDB and localStorage data. Set both explicitly for every new application;
changing either default would silently orphan existing data.

## StorageValue contract

Every 3.0 write is validated before storage or plugin side effects. A value may
contain:

- `null`, booleans, finite numbers, and strings;
- `ArrayBuffer` and the standard integer/float typed arrays;
- dense arrays of supported values;
- plain objects, including null-prototype objects, whose enumerable data
  properties contain supported values.

This contract round-trips consistently across IndexedDB, localStorage, memory,
and React Native AsyncStorage. Values such as `undefined`, `Date`, `Map`, `Set`,
`RegExp`, `bigint`, `Blob`, `DataView`, `SharedArrayBuffer`, class instances,
accessors, sparse arrays, symbol properties, cycles, and non-finite numbers are
rejected with `SERIALIZATION_FAILED`.

Convert richer application values at the boundary:

```ts
await cache.setItem('created-at', new Date().toISOString());
await cache.setItem('labels', [...new Set(['urgent', 'review'])]);
await cache.setItem('counters', Object.fromEntries(new Map([['open', 3]])));
```

LocalSpace stores accepted values inside a collision-safe, versioned core
record. Objects that happen to contain a `__localspace__` property remain
ordinary application data.

## Stable facade and configuration

Public method references stay stable across `ready()`, driver fallback,
`setDriver()`, and plugin registration. Destructuring is safe:

```ts
const { getItem, setItem } = cache;
await setItem('theme', 'dark');
await getItem('theme');
```

Configuration is construction-time state. `config()` returns a detached,
deeply frozen snapshot; `config(key)` reads one field. The old
`config(options)` setter has been removed.

```ts
const store = localspace.createInstance({
  name: 'my-app',
  storeName: 'data',
  driver: [localspace.INDEXEDDB, localspace.LOCALSTORAGE],
  durability: 'relaxed',
  maxBatchSize: 200,
  pluginInitPolicy: 'fail',
  pluginErrorPolicy: 'strict',
});

const snapshot = store.config();
console.log(snapshot.name); // my-app
```

Plugins may be passed in the constructor or added with `use()` only before the
first `ready()` or storage call. Later registration rejects with
`CONFIG_LOCKED`.

## Drivers and capabilities

The default web fallback order is IndexedDB, then localStorage. The memory
driver is deliberately not an automatic fallback: persistent-storage failure
remains visible unless the application explicitly accepts volatile data.

```ts
await store.setDriver([store.INDEXEDDB, store.LOCALSTORAGE, store.MEMORY]);
await store.ready();

console.log(store.driver());
console.log(store.capabilities());
```

`capabilities()` is available after initialization and returns the same frozen
snapshot for the selected driver session:

| Capability       | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `transactions`   | `runTransaction()` is supported                         |
| `atomicBatch`    | an unchunked batch is one driver-level atomic unit      |
| `dropInstance`   | the selected driver can remove its namespace            |
| `persistent`     | the driver survives the current runtime session         |
| `storageBuckets` | the selected IndexedDB backend supports Storage Buckets |

Optional facade methods remain present for stable typing. If the selected
driver does not support one, the call rejects early with
`UNSUPPORTED_OPERATION`, before plugin or driver side effects.

### Driver matrix

| Driver                    | Persistence              | Transactions | Atomic batch                     | Storage Buckets                        |
| ------------------------- | ------------------------ | ------------ | -------------------------------- | -------------------------------------- |
| IndexedDB                 | yes                      | yes          | yes when `maxBatchSize` is unset | when the requested backend supports it |
| localStorage              | yes                      | no           | no                               | no                                     |
| memory                    | current JavaScript realm | yes          | no                               | no                                     |
| React Native AsyncStorage | yes                      | no           | no                               | no                                     |

The memory driver serializes read-write transactions per JavaScript realm,
`name`, and `storeName`. IndexedDB uses native transactions. LocalSpace does
not add a distributed lock or replication protocol across tabs/processes;
IndexedDB retains its native cross-context scheduling, while memory isolation
does not extend beyond its realm. The broadcast example is notification-only,
not transaction coordination.

### Explicit memory fallback

```ts
const volatileAllowed = localspace.createInstance({
  name: 'my-app',
  driver: [localspace.INDEXEDDB, localspace.LOCALSTORAGE, localspace.MEMORY],
});
```

### Custom drivers

Prefer construction-scoped definitions:

```ts
import { LocalSpace } from 'localspace';

const customStore = new LocalSpace({
  driver: customDriver._driver,
  drivers: [customDriver],
});
```

LocalSpace snapshots the definition without mutating the caller's object. Each
selection creates a private driver session, so driver state is never injected
onto the public facade. For deliberate realm-wide registration, use the
exported `registerDriver()`:

```ts
import { registerDriver } from 'localspace';

await registerDriver(customDriver);
```

`instance.defineDriver()` was removed in 3.0. Custom drivers declare optional
guarantees through `_capabilities`; LocalSpace validates that each declaration
matches the implemented methods.

### Storage Buckets

Storage Buckets are explicit IndexedDB configuration:

```ts
const bucketStore = localspace.createInstance({
  name: 'my-app',
  bucket: {
    name: 'durable-data',
    durability: 'strict',
    persisted: true,
  },
});
```

When `bucket` is provided, LocalSpace never silently opens the default
IndexedDB database or falls back to another driver. An unavailable API, failed
bucket open, or bucket without IndexedDB rejects readiness with structured
error details.

## Batch operations

```ts
await store.setItems([
  { key: 'user:1', value: { name: 'Ada' } },
  { key: 'user:2', value: { name: 'Grace' } },
]);

const users = await store.getItems(['user:1', 'user:2']);
// [{ key: 'user:1', value: ... }, { key: 'user:2', value: ... }]

await store.removeItems(['user:1', 'user:2']);
```

IndexedDB runs an unchunked batch in one transaction. Setting `maxBatchSize`
splits a large call into multiple chunks, so `atomicBatch` becomes `false`.
Other drivers preserve the public result shape without promising atomicity.

## Transactions

IndexedDB and memory expose scoped transactions:

```ts
await store.runTransaction('readwrite', async (tx) => {
  const current = (await tx.get<number>('counter')) ?? 0;
  await tx.set('counter', current + 1);
  await tx.set('updated-at', Date.now());
});
```

The scope contains `get`, `set`, `remove`, `keys`, `iterate`, and `clear`.
During the runner, every operation on that same instance must go through the
provided scope; ordinary facade calls reject with `TRANSACTION_SCOPE_REQUIRED`.
The scope becomes invalid as soon as the runner settles, and readonly scopes
reject mutations with `TRANSACTION_READONLY`.

Only await Promises returned by those scope methods inside the runner. Timers,
network requests, prompts, and other arbitrary waits are outside the contract.
With IndexedDB, the browser may commit when no native request remains; a later
scope call then rejects with `TRANSACTION_INACTIVE`. Writes in that already
completed native transaction remain committed, so this rejection must not be
interpreted as rollback. Move external work before or after `runTransaction()`.

Plugins run inside the same transaction and receive the active scope as
`context.transactionScope`. Async `iterate()` callbacks are awaited
sequentially; the first non-`undefined` result stops iteration and becomes the
return value.

localStorage and React Native AsyncStorage report `transactions: false` and
reject `runTransaction()` with `UNSUPPORTED_OPERATION`.

## Plugins

```ts
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  ttlPlugin,
} from 'localspace';

const secureStore = localspace.createInstance({
  name: 'secure-store',
  plugins: [
    ttlPlugin({ defaultTTL: 60_000 }),
    compressionPlugin({ threshold: 1024 }),
    encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
  ],
  pluginErrorPolicy: 'strict',
});
```

| Plugin      | Contract                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------- |
| TTL         | expired values disappear consistently from item, batch, iteration, key, and length views            |
| Compression | bytes-to-bytes codec; stores an envelope only when the complete persisted representation is smaller |
| Encryption  | AES-GCM writes through Web Crypto; malformed data and crypto failures fail closed                   |

Legacy AES-CBC/AES-CTR data can be read only through
`legacyEncryptionMigrationPlugin()`. That plugin rejects every write; migrate
values into a separate AES-GCM instance.

For each plugin and phase, a batch call invokes the batch hook once when it is
defined, otherwise it maps the matching single hook over entries. It never runs
both forms for the same plugin phase. Query/destructive observers cover
`iterate`, `keys`, `key`, `length`, `clear`, `dropInstance`, and the outer
`runTransaction` lifecycle.

See [Plugin System](./docs/plugins.md) for ordering, envelopes, policies, and
custom hook examples. Application-level notification examples live in
[`examples/`](./examples/).

## React Native

Runtime auto-detection was removed. The AsyncStorage adapter is required and a
missing or malformed adapter fails instead of falling through to another
driver. It must implement `getItem`, `setItem`, `removeItem`, and `getAllKeys`
so every public query and namespace operation is available after readiness;
`clear` and the `multi*` methods remain optional optimizations.

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import localspace from 'localspace';
import { createReactNativeInstance } from 'localspace/react-native';

const mobileStore = await createReactNativeInstance(localspace, {
  name: 'my-app',
  storeName: 'data',
  reactNativeAsyncStorage: AsyncStorage,
});
```

For deliberate realm-wide driver installation:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import localspace from 'localspace';
import { installReactNativeAsyncStorageDriver } from 'localspace/react-native';

await installReactNativeAsyncStorageDriver();
const mobileStore = localspace.createInstance({
  driver: localspace.REACTNATIVEASYNCSTORAGE,
  reactNativeAsyncStorage: AsyncStorage,
});
await mobileStore.ready();
```

The repository provides an official AsyncStorage Jest integration and a React
Native 0.83.x Detox fixture:

```bash
pnpm test:rn:integration
```

See [`integration/react-native-detox/README.md`](./integration/react-native-detox/README.md)
for simulator/emulator commands and the manual gate that installs an exact,
integrity-checked published RC tarball.

## Lifecycle

`close()` is idempotent and non-destructive. It stops initialized plugins and
releases the active driver session; later operations reject with
`INSTANCE_CLOSED`. Use `clear()` or `dropInstance()` only when data should be
deleted.

```ts
await cache.close();
```

`destroy()` was removed in 3.0. If custom-driver cleanup rejects, the closed
instance retains that cleanup and a later `close()` retries it. Calls that
would re-enter a pending plugin or driver lifecycle callback are rejected
instead of deadlocking.

## Errors

Operational failures are `LocalSpaceError` objects with a stable `code`,
structured `details`, and an optional original `cause`.

```ts
import { LocalSpaceError } from 'localspace';

try {
  await store.runTransaction('readwrite', async () => {});
} catch (error) {
  if (error instanceof LocalSpaceError) {
    console.error(error.code, error.details, error.cause);
  }
}
```

Common codes include `DRIVER_UNAVAILABLE`, `DRIVER_NOT_INITIALIZED`,
`UNSUPPORTED_OPERATION`, `TRANSACTION_SCOPE_REQUIRED`,
`TRANSACTION_INACTIVE`, `TRANSACTION_READONLY`, `SERIALIZATION_FAILED`,
`DESERIALIZATION_FAILED`, `QUOTA_EXCEEDED`, and `INSTANCE_CLOSED`.

## Supported platforms

| Platform     | 3.0 support policy                                                                                         | Release evidence                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Chromium     | exact engine build resolved by the frozen Playwright lockfile, using unprefixed IndexedDB                  | Chromium project plus logged Playwright and engine versions                |
| Firefox      | exact engine build resolved by the frozen Playwright lockfile                                              | Firefox project plus logged Playwright and engine versions                 |
| WebKit       | exact engine build resolved by the frozen Playwright lockfile                                              | WebKit project plus logged Playwright and engine versions                  |
| Safari       | exact stable Safari build recorded for the release candidate                                               | real Safari smoke before GA; Playwright WebKit is a separate preflight     |
| Node.js      | LTS 22 and 24 for package import, JavaScript tests, and custom drivers; no built-in persistent Node driver | Node CI matrix; browser-facing TypeScript declarations require the DOM lib |
| React Native | 0.83.x with AsyncStorage 2.2.x release fixture                                                             | official Jest mock plus iOS Detox against the exact registry RC tarball    |

This matrix is deliberately evidence-shaped: one Playwright project does not
certify two browser majors, Firefox ESR, Microsoft Edge, or real Safari. Those
targets require their own release jobs before LocalSpace can claim them as
tested support.

Legacy prefixed IndexedDB APIs and WebSQL are not supported. WebSQL data must be
migrated before adopting LocalSpace.

## Performance and package boundaries

- Prefer batch APIs when operations belong together.
- Use `capabilities()` instead of assuming an atomicity guarantee.
- Run `pnpm test:benchmark` for environment-specific results.
- Run `pnpm benchmark:compare:2.1` for the integrity-pinned published 2.1.0
  comparison described in [`benchmarks/README.md`](./benchmarks/README.md).
- Published source maps embed `sourcesContent`, so stack traces map back to
  TypeScript even though `src/` and declaration maps are not shipped.

## Documentation

| Document                                     | Description                                                    |
| -------------------------------------------- | -------------------------------------------------------------- |
| [API Reference](./docs/api-reference.md)     | methods, types, capabilities, drivers, and configuration       |
| [Plugin System](./docs/plugins.md)           | hook pipeline, built-in plugins, envelopes, and custom plugins |
| [Migration Guide](./docs/migration-guide.md) | 2.1.x to 3.0 changes and data migration                        |
| [Real-World Examples](./docs/examples.md)    | application patterns                                           |
| [Changelog](./CHANGELOG.md)                  | release history                                                |

## License

[MIT](./LICENSE)
