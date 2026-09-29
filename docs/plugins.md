# Plugin System

LocalSpace 3.0 plugins transform logical item operations and observe the full
query/destructive surface without exposing driver-specific payloads. Plugins
are instance-scoped, ordered, initialized lazily, and run inside transaction
scopes when the operation is transactional.

```ts
import localspace, {
  compressionPlugin,
  encryptionPlugin,
  ttlPlugin,
} from 'localspace';

const store = localspace.createInstance({
  name: 'my-app',
  plugins: [
    ttlPlugin({ defaultTTL: 60_000 }),
    compressionPlugin({ threshold: 1024 }),
    encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
  ],
  pluginErrorPolicy: 'strict',
});
```

## Registration and lifecycle

Plugins can be supplied in `LocalSpaceOptions.plugins` or registered with
`use()` before the instance starts:

```ts
const store = localspace.createInstance({ name: 'my-app' });
store.use([metricsPlugin, validationPlugin]);
await store.ready();
```

The first `ready()` or storage call synchronously locks plugin registration.
Later `use()` calls reject with `CONFIG_LOCKED`. Names must be non-empty and
unique within the instance; a duplicate batch is rejected atomically.

Registration snapshots visible data-property descriptors and never mutates the
caller-owned object. Later changes to its hooks, name, priority, or prototype
do not affect the instance. Accessor properties are rejected without invoking
their getters. The stored definition is frozen; keep mutable plugin state in
`context.metadata`, not on `this`.

Lifecycle hooks:

```ts
interface LocalSpacePlugin {
  name: string;
  version?: string;
  priority?: number;
  enabled?: boolean | (() => boolean);

  onInit?(context: PluginContext): Promise<void> | void;
  onDestroy?(context: PluginContext): Promise<void> | void;
  onError?(error: unknown, info: PluginErrorInfo): Promise<void> | void;
}
```

`onInit` runs lazily before the first plugin-aware operation. `onDestroy` runs
for every initialized plugin during `close()` and, once successful or swallowed
by the lenient policy, is not run again. Initialization follows normal priority
order; teardown runs in reverse order.

Teardown follows `pluginErrorPolicy`. A strict error, `LocalSpaceError`, or
`PluginAbortError` makes `close()` reject after the remaining plugins and driver
have still had a cleanup attempt. A later `close()` retries only failed plugin
and driver cleanup. Under `lenient`, an ordinary custom-plugin teardown error is
reported and treated as complete.

`context.instance` is always safe to call for the current hook. Operation hooks
receive the public instance. Lifecycle callbacks receive a callback-scoped
receiver that rejects same-instance storage/lifecycle reentry while the
callback is pending, including across `await`. `context.instanceToken` is the
stable identity shared by every context for one store; use it as a WeakMap key
when plugin state must span lifecycle and operation hooks.

## Ordering

Plugins are sorted by descending `priority`. Equal priorities keep registration
order.

- before hooks run from highest to lowest priority;
- after hooks run in reverse, from lowest to highest priority;
- initialization follows before order;
- destruction follows reverse order.

This creates a nested transform pipeline. The built-in priorities are:

| Plugin      | Priority | Write order | Read order |
| ----------- | -------: | ----------- | ---------- |
| TTL         |       10 | first       | last       |
| Compression |        5 | after TTL   | before TTL |
| Encryption  |        0 | last        | first      |

The default order encrypts the final stored representation and compresses
before encryption. If custom priorities make encryption run before compression,
LocalSpace emits a warning because encrypted bytes rarely compress usefully.

## PluginContext

```ts
interface PluginContext {
  instance: LocalSpaceInstance;
  instanceToken: object;
  transactionScope?: TransactionScope;
  driver: string | null;
  config: LocalSpaceConfigSnapshot;
  metadata: Record<string, unknown>;
  operation: PluginOperation | null;
  operationState: Record<string, unknown>;
}
```

- `config` is a detached, frozen snapshot. Together with `driver` it is the
  complete view a plugin gets of the active backend. Driver internals such as
  the live IndexedDB connection are deliberately not exposed: they are
  driver-specific, absent for other drivers, and not part of any stable
  contract. A plugin that needs backend-specific behaviour should branch on
  `driver` and use the public API.
- `metadata` is private to the current plugin and shared across that plugin's
  contexts for the lifetime of the instance. Different plugins can safely use
  the same property names.
- `operationState` is per operation/context and is suitable for carrying a
  plugin's own before-hook state into its after hook. Each plugin gets an
  isolated object, so another plugin cannot observe or overwrite it. It is not
  a public-result override channel.
- mapped single hooks in a batch receive `operationState.isBatch === true` and
  `batchSize`, but these fields are informational. Do not use an `isBatch`
  guard to compensate for duplicate execution: 3.0 never invokes both matching
  forms for the same plugin phase.
- `transactionScope` is present for operations invoked through
  `runTransaction()`. A plugin must use it instead of re-entering
  `context.instance`.

## Item hooks

```ts
interface LocalSpacePlugin<TValue = StorageValue> {
  beforeSet?(
    key: string,
    value: TValue,
    context: PluginContext
  ): Promise<TValue> | TValue;
  afterSet?(
    key: string,
    value: TValue,
    context: PluginContext
  ): Promise<void> | void;

  beforeGet?(key: string, context: PluginContext): Promise<string> | string;
  afterGet?(
    key: string,
    value: TValue | null,
    context: PluginContext
  ): Promise<TValue | null> | TValue | null;
  isValueVisible?(
    key: string,
    value: TValue | null,
    context: PluginContext
  ): Promise<boolean> | boolean;

  beforeRemove?(key: string, context: PluginContext): Promise<string> | string;
  afterRemove?(key: string, context: PluginContext): Promise<void> | void;
}
```

`beforeSet` and `afterGet` may transform logical values. Every value emitted by
a write hook must still satisfy `StorageValue`; LocalSpace validates plugin
output and reports the plugin name in `SERIALIZATION_FAILED` details.

`beforeGet` and `beforeRemove` may rewrite a key. `afterSet` and `afterRemove`
are observers; their return values and `operationState` mutations cannot
rewrite the public operation result.

`isValueVisible` runs after read transforms and explicitly opts a plugin into
logical key/length filtering. Returning `false` makes `getItem`/`getItems`
report `null` and removes the entry from `iterate`/`keys`/`key`/`length`.
Visibility predicates should be deterministic and side-effect free.

## Batch hooks: one form per plugin and phase

```ts
interface LocalSpacePlugin<TValue = StorageValue> {
  beforeSetItems?(
    entries: BatchItems<TValue>,
    context: PluginContext
  ): Promise<BatchItems<TValue>> | BatchItems<TValue>;
  afterSetItems?(
    entries: BatchResponse<TValue>,
    context: PluginContext
  ): Promise<BatchResponse<TValue>> | BatchResponse<TValue>;

  beforeGetItems?(
    keys: string[],
    context: PluginContext
  ): Promise<string[]> | string[];
  afterGetItems?(
    entries: BatchResponse<TValue>,
    context: PluginContext
  ): Promise<BatchResponse<TValue>> | BatchResponse<TValue>;

  beforeRemoveItems?(
    keys: string[],
    context: PluginContext
  ): Promise<string[]> | string[];
  afterRemoveItems?(
    keys: string[],
    context: PluginContext
  ): Promise<void> | void;
}
```

For each plugin and phase:

1. LocalSpace invokes the batch hook once when it exists.
2. Otherwise it maps the matching single hook over each current entry.
3. It never invokes both forms for that plugin phase.
4. The next plugin receives the transformed order/key set from the previous
   plugin.
5. After phases apply the same choice in reverse plugin order.

This rule is global across single and batch forms. A high-priority single hook
runs before a lower-priority batch hook in the before phase; after order is
reversed. Batch hooks may reorder, add, or remove entries, and LocalSpace
reconciles per-item context by key. Built-in storage transforms are stricter:
they may not change the logical batch key set or order.

A custom plugin usually needs only single hooks:

```ts
import type { LocalSpacePlugin } from 'localspace';

const normalizeStrings: LocalSpacePlugin<string> = {
  name: 'normalize-strings',
  beforeSet: (_key, value) => value.trim(),
};
```

The value parameter is an authoring aid, not a runtime filter. A specialized
plugin must only be attached to a store whose values match that type; use the
default `LocalSpacePlugin` and narrow values inside each hook for heterogeneous
stores. Plugin-produced writes are still checked at runtime.

`setItems()` maps that hook automatically. Add `beforeSetItems` only when a
true batch implementation is useful; do not retain a 2.x
`if (context.operationState.isBatch) return value` deduplication guard.

## Query and destructive observers

```ts
interface LocalSpacePlugin {
  beforeIterate?(context: PluginContext): Promise<void> | void;
  afterIterate?(
    summary: Readonly<{ iterations: number; stopped: boolean }>,
    context: PluginContext
  ): Promise<void> | void;

  beforeKeys?(context: PluginContext): Promise<void> | void;
  afterKeys?(
    keys: readonly string[],
    context: PluginContext
  ): Promise<void> | void;

  beforeKey?(index: number, context: PluginContext): Promise<void> | void;
  afterKey?(
    index: number,
    key: string | null,
    context: PluginContext
  ): Promise<void> | void;

  beforeLength?(context: PluginContext): Promise<void> | void;
  afterLength?(length: number, context: PluginContext): Promise<void> | void;

  beforeClear?(context: PluginContext): Promise<void> | void;
  afterClear?(context: PluginContext): Promise<void> | void;

  beforeDropInstance?(
    options: LocalSpaceConfigSnapshot | undefined,
    context: PluginContext
  ): Promise<void> | void;
  afterDropInstance?(
    options: LocalSpaceConfigSnapshot | undefined,
    context: PluginContext
  ): Promise<void> | void;

  beforeRunTransaction?(
    mode: TransactionMode,
    context: PluginContext
  ): Promise<void> | void;
  afterRunTransaction?(
    mode: TransactionMode,
    context: PluginContext
  ): Promise<void> | void;
}
```

These hooks are observers: return values are ignored. Arrays and summaries are
frozen copies. Before observers use descending priority and after observers use
reverse order. Void after hooks are notification points: their failures are
reported and never veto the operation, including item hooks running inside a
larger transaction. Put validation that must prevent a write in a before hook.

`iterate`, `keys`, `key`, and `length` operate on the logical visible view.
Built-in TTL expiration and explicit `isValueVisible` predicates are resolved
during value scans, so hidden entries are absent consistently. A stored logical
`null` remains visible unless a predicate hides it. Encryption, compression,
and ordinary `afterGet` transforms alone do not force keys/length to read and
decode every value. Iteration still streams each delivered item through
`afterGet`; the batch-only `afterGetItems` optimization is reserved for
batch/query materialization and is not an implicit whole-store iterate hook.

`clear` and `dropInstance` do not synthesize per-item remove hooks; use their
dedicated observers for aggregate deletion.

`beforeRunTransaction` runs after capability checks and initialization but
before the driver creates a transaction. `afterRunTransaction` runs only after
the driver reports a successful commit. Neither hook receives the runner result
or an active scope, so it cannot rewrite the result or perform transaction-bound
work. Scope operations continue to use their normal item/query observers.
An `afterRunTransaction` error is reported through `onError` (or the console)
without replacing the successful transaction result. The commit has already
happened, so rejecting here would falsely imply that rollback was possible.

## Transactions

Plugins are supported by IndexedDB and memory transaction scopes. Scope
`get`/`set`/`remove` and `keys`/`iterate`/`clear` use the same hooks and logical
views as facade operations, while remaining bound to the driver transaction.

```ts
import { PluginAbortError, type LocalSpacePlugin } from 'localspace';

const relationshipPlugin: LocalSpacePlugin = {
  name: 'relationship-check',
  beforeSet: async (key, value, context) => {
    if (context.transactionScope && key === 'child') {
      const parent = await context.transactionScope.get('parent');
      if (parent === null) throw new PluginAbortError('parent is required');
    }
    return value;
  },
};
```

Calling `context.instance.getItem()` from a transaction hook rejects with
`TRANSACTION_SCOPE_REQUIRED`; use `context.transactionScope`. A transaction
scope is invalid after its runner settles.

## Error policies

```ts
const store = localspace.createInstance({
  pluginInitPolicy: 'fail',
  pluginErrorPolicy: 'lenient',
});
```

`pluginInitPolicy`:

- `fail` (default) aborts the operation when initialization fails;
- `disable-and-continue` reports the error and disables that plugin for the
  instance.

`pluginErrorPolicy`:

- `strict` propagates transform errors and errors from hooks that run before an
  operation settles;
- `lenient` reports an unexpected custom-plugin error through `onError` (or
  the console) and uses the pre-hook value/result.

Void after observers never replace an operation's result under either policy.
Their errors, including `LocalSpaceError` and `PluginAbortError`, are reported;
this is a stable plugin contract rather than a backend-dependent guess about
whether rollback is still technically possible. A failing post-write
`afterSetItems` result hook similarly falls back to the unmodified result.
`afterGet`/`afterGetItems` remain read-result transforms and follow the selected
policy. `LocalSpaceError` and `PluginAbortError` from transforms and before
hooks always propagate, so built-in storage transforms continue to fail closed.
For data transforms, `strict` remains the clearest application policy.

```ts
import { PluginAbortError } from 'localspace';

const rejectReservedKeys: LocalSpacePlugin = {
  name: 'reserved-key-policy',
  beforeSet: (key, value) => {
    if (key.startsWith('__')) {
      throw new PluginAbortError('reserved key');
    }
    return value;
  },
  onError: (error, info) => {
    reportPluginFailure(info.plugin, info.operation, error);
  },
};
```

## Frozen persisted formats

LocalSpace stores ordinary logical values without a universal core wrapper.
Built-in transform plugins use the plugin envelope frozen during 2.1:

```ts
{
  __localspace__: {
    namespace: 'localspace.plugin',
    kind: 'ttl' | 'compression' | 'encryption',
    version: 1,
  },
  payload: pluginPayload,
}
```

Transforms wrap the raw logical value in pipeline order. Readers also accept
each built-in plugin's 2.x marker-based legacy payload. A matching
namespace/kind with an unknown version throws `DESERIALIZATION_FAILED`. Writers
never guess or silently downgrade an unknown format.

The exact top-level `localspace.plugin` namespace is reserved for storage
transform output. Application writes and ordinary logical-plugin output cannot
claim it. Partial marker lookalikes, other namespaces, and the abandoned
`localspace.record` namespace remain ordinary application data.

When a string-backed driver or a byte transform must serialize binary nested in
an array or object, the serializer uses the selective `__lsv__:1:` codec. It is
not emitted for ordinary JSON-compatible values or top-level binary values. The
final 2.1.x bridge includes a forward reader for this representation.

The envelope property, namespace, version, kinds, and outer shape are frozen
for 3.0. Payloads must remain within the validators understood by the 2.1
bridge reader. See the [Migration Guide](./migration-guide.md) before relying
on a source rollback after 3.0 writes.

Recognized envelopes, headers, and built-in payloads use exact enumerable data
properties: extra fields, symbols, non-enumerable fields, or accessors are
malformed and reject with `DESERIALIZATION_FAILED`. Readers inspect property
descriptors and never execute getters while parsing persisted metadata.

## TTL plugin

```ts
import { ttlPlugin } from 'localspace';

const plugin = ttlPlugin({
  defaultTTL: 60_000,
  keyTTL: {
    session: 15 * 60_000,
  },
  cleanupInterval: 30_000,
  onExpire: async (key, value) => {
    await reportExpiration(key, value);
  },
});
```

Options:

| Option             | Meaning                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `defaultTTL`       | default lifetime in milliseconds; missing/non-positive/non-finite means no wrapper |
| `keyTTL`           | per-key lifetime overrides                                                         |
| `cleanupInterval`  | optional background scan interval                                                  |
| `cleanupBatchSize` | deprecated; no effect since 3.0.1 (each sweep is one logical scan)                 |
| `onExpire`         | notification after an expired key is successfully removed                          |

Foreground reads await `onExpire` and follow `pluginErrorPolicy`. Background
sweep notifications are detached from the close barrier so user callbacks can
safely call/await `close()`; their failures cannot resurrect data. `close()`
stops the timer and waits for the storage sweep itself.

Expired values are hidden even when no periodic sweep is configured. Item,
batch, iteration, key, and length operations agree on the logical view.

That agreement has a cost. While TTL (or any plugin defining `isValueVisible`)
is active, `keys()`, `length()`, and `key(index)` read and transform every
stored value, including decryption and decompression, instead of asking the
driver for keys or a count. Each call is O(n) in the store size, so a loop such
as `for (let i = 0; i < (await store.length()); i++) await store.key(i)` is
O(n²); call `keys()` once, or use `iterate()`, instead. A background sweep is
one such scan per `cleanupInterval`.

Outside `runTransaction`, TTL removes an expired key only while it still holds
the stored value that was read, so a fresh value written concurrently (for
example by another tab or by the application while a sweep runs) survives.
Drivers with native transactions perform the check and removal atomically;
localStorage and React Native AsyncStorage re-read the key immediately before
removing it. While a transaction is active on the same instance, removal is
deferred: the expired value stays hidden and a later read or sweep removes it
(and then calls `onExpire`).

## Compression plugin

```ts
import { compressionPlugin } from 'localspace';

const plugin = compressionPlugin({
  threshold: 1024,
  algorithm: 'lz-string',
});
```

The default codec is bundled. `threshold` is the minimum uncompressed UTF-8
serialized byte length at which compression is attempted. LocalSpace stores a
compression envelope only when the serialized complete envelope, including
metadata and base64 expansion, is smaller than the raw representation.

Custom codecs are bytes-to-bytes:

```ts
const plugin = compressionPlugin({
  threshold: 256,
  algorithm: 'my-codec-v1',
  codec: {
    compress(data: Uint8Array): Uint8Array {
      return encode(data);
    },
    decompress(data: Uint8Array): Uint8Array {
      return decode(data);
    },
  },
});
```

Both methods must return a real `Uint8Array`. LocalSpace copies codec output,
checks canonical base64, checks the persisted algorithm for versioned payloads,
and requires decompressed bytes to match `originalSize`.

## Encryption plugin

Normal writes use AES-GCM only:

```ts
import { encryptionPlugin } from 'localspace';

const plugin = encryptionPlugin({
  key: '0123456789abcdef0123456789abcdef',
  algorithm: { name: 'AES-GCM', tagLength: 128 },
});
```

Raw key material must be 16, 24, or 32 bytes. A supplied `CryptoKey` must be a
secret AES-GCM key with the usages needed by the operation. A fresh secure IV
is generated for every write; `algorithm` configures the remaining AES-GCM
parameters and does not accept a caller-owned `iv`. `ivLength` must be at
least 12 bytes and `algorithm.tagLength`, when set, must be 96, 104, 112, 120,
or 128 bits. Custom `subtle`, `ivGenerator`, and `randomSource` implementations
are available for controlled runtimes.

> **Security:** AES-GCM fails catastrophically if an IV is reused with the same
> key. Two writes sharing an IV leak relationships between their plaintexts and
> can break integrity beyond those values. LocalSpace validates that a custom
> `ivGenerator` or `randomSource` returns the expected byte length, but it cannot
> verify uniqueness. The hook must prevent reuse across restarts and concurrent
> writers. A deterministic construction is safe only with durable,
> collision-free coordination; a fixed or repeatable seeded value is not. When
> in doubt, omit both and use the default 96-bit IV from
> `crypto.getRandomValues()`.

PBKDF2 derivation:

```ts
const plugin = encryptionPlugin({
  keyDerivation: {
    passphrase: userPassword,
    salt: applicationSalt,
    iterations: 600_000,
    hash: 'SHA-256',
    length: 256,
  },
});
```

The default of 150,000 iterations is kept so existing derived keys stay stable;
new deployments should set at least 600,000 iterations for PBKDF2-SHA-256
(OWASP guidance) and use a random, per-installation salt of at least 16 bytes.
Changing `iterations`, `hash`, `salt`, or `length` derives a different key, so
existing data must be migrated through an instance that uses the old settings.

Only one of `key` and `keyDerivation` may be supplied. Web Crypto and a secure
random source are required. Invalid configuration, serialization, encryption,
decryption, malformed envelopes, and algorithm mismatches all fail closed.

Reads also fail closed on stored values that are not encrypted payloads: they
reject with `DESERIALIZATION_FAILED` (`details.reason: 'unencrypted-value'`),
because an unencrypted value is not authenticated and may have been written by
anyone with storage access. When adding encryption to a store that already
holds plaintext, set `allowPlaintext: true` on a migration instance, read each
value, and rewrite it through an instance without that option. Missing keys
still read as `null`.

By default a ciphertext is not tied to where it is stored, so a payload copied
to another key or store still decrypts. Set `bindStorageKey: true` to
authenticate each value against its database name, store name, and key as
AES-GCM additional data; a moved payload then fails to decrypt. Values written
before the option was enabled stay readable (and unbound) until rewritten.
Bound values cannot be read by LocalSpace 3.0.0 or the 2.1.x rollback bridge,
and the option cannot be combined with `algorithm.additionalData`.

### Legacy AES-CBC/AES-CTR migration

`encryptionPlugin()` rejects AES-CBC and AES-CTR. Use the separate read-only
migration plugin for existing 2.x payloads:

```ts
import { encryptionPlugin, legacyEncryptionMigrationPlugin } from 'localspace';

const legacy = localspace.createInstance({
  name: 'legacy-vault',
  storeName: 'data',
  plugins: [
    legacyEncryptionMigrationPlugin({
      key: legacyKey,
      algorithm: { name: 'AES-CBC' },
    }),
  ],
  pluginErrorPolicy: 'strict',
});

const modern = localspace.createInstance({
  name: 'modern-vault',
  storeName: 'data',
  plugins: [encryptionPlugin({ key: modernAesGcmKey })],
  pluginErrorPolicy: 'strict',
});

for (const key of await legacy.keys()) {
  const value = await legacy.getItem(key);
  if (value !== null) await modern.setItem(key, value);
}
```

The legacy migration plugin allows decrypt reads only and rejects every write
with `UNSUPPORTED_OPERATION`. It intentionally uses the same plugin name as
normal encryption so the two cannot be combined accidentally on one instance.

## Application-level synchronization

Plugins do not turn storage into a cross-tab transaction or replication
system. [`examples/broadcast-notification-plugin.ts`](../examples/broadcast-notification-plugin.ts)
shows best-effort per-driver notifications. Applications that need conflict
resolution, distributed locks, acknowledgements, or durable replication must
define that protocol above LocalSpace.
