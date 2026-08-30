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
once for every initialized plugin during `close()`. Initialization follows
normal priority order; teardown runs in reverse order.

`context.instance` is always the public instance and keeps stable identity.
Lifecycle callbacks also receive `context.lifecycleInstance`, a callback-
scoped receiver that rejects same-instance storage/lifecycle reentry while the
callback is pending. This guard extends across `await` and prevents self-
deadlocks. Operation hooks do not receive `lifecycleInstance`.

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
  lifecycleInstance?: LocalSpaceInstance;
  transactionScope?: TransactionScope;
  driver: string | null;
  dbInfo: DbInfo | null;
  config: LocalSpaceConfigSnapshot;
  metadata: Record<string, unknown>;
  operation: PluginOperation | null;
  operationState: Record<string, unknown>;
}
```

- `config` is a detached, frozen snapshot.
- `metadata` is shared across contexts for the lifetime of the plugin manager;
  namespace keys to avoid collisions.
- `operationState` is per operation/context and is suitable for carrying a
  before-hook result into its after hook.
- mapped single hooks in a batch receive `operationState.isBatch === true` and
  `batchSize`, but these fields are informational. Do not use an `isBatch`
  guard to compensate for duplicate execution: 3.0 never invokes both matching
  forms for the same plugin phase.
- `transactionScope` is present for operations invoked through
  `runTransaction()`. A plugin must use it instead of re-entering
  `context.instance`.

## Item hooks

```ts
interface LocalSpacePlugin {
  beforeSet?<T>(key: string, value: T, context: PluginContext): Promise<T> | T;
  afterSet?<T>(
    key: string,
    value: T,
    context: PluginContext
  ): Promise<void> | void;

  beforeGet?(key: string, context: PluginContext): Promise<string> | string;
  afterGet?<T>(
    key: string,
    value: T | null,
    context: PluginContext
  ): Promise<T | null> | T | null;

  beforeRemove?(key: string, context: PluginContext): Promise<string> | string;
  afterRemove?(key: string, context: PluginContext): Promise<void> | void;
}
```

`beforeSet` and `afterGet` may transform logical values. Every value emitted by
a write hook must still satisfy `StorageValue`; LocalSpace validates plugin
output and reports the plugin name in `SERIALIZATION_FAILED` details.

`beforeGet` and `beforeRemove` may rewrite a key. `afterSet` and `afterRemove`
are observers.

## Batch hooks: one form per plugin and phase

```ts
interface LocalSpacePlugin {
  beforeSetItems?<T>(
    entries: BatchItems<T>,
    context: PluginContext
  ): Promise<BatchItems<T>> | BatchItems<T>;
  afterSetItems?<T>(
    entries: BatchResponse<T>,
    context: PluginContext
  ): Promise<BatchResponse<T>> | BatchResponse<T>;

  beforeGetItems?(
    keys: string[],
    context: PluginContext
  ): Promise<string[]> | string[];
  afterGetItems?<T>(
    entries: BatchResponse<T>,
    context: PluginContext
  ): Promise<BatchResponse<T>> | BatchResponse<T>;

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

const normalizeStrings: LocalSpacePlugin = {
  name: 'normalize-strings',
  beforeSet: <T>(_key: string, value: T): T =>
    (typeof value === 'string' ? value.trim() : value) as T,
};
```

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
}
```

These hooks are observers: return values are ignored. Arrays and summaries are
frozen copies. Before observers use descending priority and after observers use
reverse order.

`iterate`, `keys`, `key`, and `length` operate on the decoded logical view, not
raw driver records. Built-in TTL expiration is resolved during that scan, so an
expired entry is absent consistently from every view. A stored logical `null`
is still an item and remains visible in keys/length.

`clear` and `dropInstance` do not synthesize per-item remove hooks; use their
dedicated observers for aggregate deletion.

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

- `strict` propagates every runtime hook error;
- `lenient` reports an unexpected custom-plugin error through `onError` (or
  the console) and uses the pre-hook value/result.

`LocalSpaceError` and `PluginAbortError` always propagate under either policy.
Built-in storage transforms convert malformed payload, crypto, compression,
and expiration failures into structured LocalSpace errors, so they fail closed.
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

LocalSpace 3.0 writes a core StoredRecord v1 for every logical value:

```ts
{
  __localspace__: {
    namespace: 'localspace.record',
    version: 1,
  },
  payload: {
    codec: 'localspace.storage-value',
    data: encodedStorageValue,
  },
}
```

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

With built-in transforms, the StoredRecord is nested inside the transform
pipeline; it is not replaced. Readers also accept each built-in plugin's 2.x
marker-based legacy payload. A matching namespace/kind with an unknown version
throws `DESERIALIZATION_FAILED`. Writers never guess or silently downgrade an
unknown format.

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
  cleanupBatchSize: 100,
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
| `cleanupBatchSize` | background scan chunk size, default 100                                            |
| `onExpire`         | notification after an expired key is successfully removed                          |

Foreground reads await `onExpire` and follow `pluginErrorPolicy`. Background
sweep notifications are detached from the close barrier so user callbacks can
safely call/await `close()`; their failures cannot resurrect data. `close()`
stops the timer and waits for the storage sweep itself.

Expired values are hidden even when no periodic sweep is configured. Item,
batch, iteration, key, and length operations agree on the logical view.

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
parameters and does not accept a caller-owned `iv`. Custom `subtle`,
`ivGenerator`, and `randomSource` implementations are available for controlled
runtimes.

PBKDF2 derivation:

```ts
const plugin = encryptionPlugin({
  keyDerivation: {
    passphrase: userPassword,
    salt: applicationSalt,
    iterations: 200_000,
    hash: 'SHA-256',
    length: 256,
  },
});
```

Only one of `key` and `keyDerivation` may be supplied. Web Crypto and a secure
random source are required. Invalid configuration, serialization, encryption,
decryption, malformed envelopes, and algorithm mismatches all fail closed.

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
