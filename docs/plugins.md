# Plugin System

localspace ships with a first-class plugin engine. Attach middleware when creating an instance or call `use()` later; plugins can mutate payloads, observe driver context, and run async interceptors around every storage call.

```ts
const store = localspace.createInstance({
  name: 'secure-store',
  storeName: 'primary',
  plugins: [
    ttlPlugin({ defaultTTL: 60_000 }),
    compressionPlugin({ threshold: 1024 }),
    encryptionPlugin({ key: '0123456789abcdef0123456789abcdef' }),
  ],
});
```

## Table of Contents

- [Lifecycle and Hooks](#lifecycle-and-hooks)
- [Plugin Execution Order](#plugin-execution-order)
- [Built-in Plugins](#built-in-plugins)
  - [TTL Plugin](#ttl-plugin)
  - [Encryption Plugin](#encryption-plugin)
  - [Compression Plugin](#compression-plugin)
- [Plugin Combination Best Practices](#plugin-combination-best-practices)
- [Plugin Troubleshooting](#plugin-troubleshooting)
- [Custom Plugin Development](#custom-plugin-development)

---

## Lifecycle and Hooks

- **Registration** – supply `plugins` when calling `createInstance()` or chain `instance.use(plugin)` later. Each plugin can also expose `enabled` (boolean or function) and `priority` to control execution order.

- **Lifecycle events** – `onInit(context)` is invoked after `ready()`, and `onDestroy` lets you tear down timers or channels. Call `await instance.close()` when disposing of an instance: initialized plugins receive one `onDestroy` call in reverse priority order, then the driver connection is released without deleting data. Context exposes the active driver, db info, config, and a shared `metadata` bag for cross-plugin coordination. Lifecycle callbacks must use the guarded `context.instance` instead of a captured original instance for same-instance calls across async boundaries. The guard rejects reentry while the callback is pending and automatically releases afterward, so retained contexts can support later timer or event-handler work. The same `context.instance` object is reused for lifecycle and operation hooks, preserving identity-keyed plugin state.

- **Interceptors** – hook into `beforeSet/afterSet`, `beforeGet/afterGet`, `beforeRemove/afterRemove`, plus batch-specific methods such as `beforeSetItems` or `beforeGetItems`. Hooks run sequentially: `before*` hooks execute from highest to lowest priority, while `after*` hooks unwind in reverse order so layered transformations (TTL → compression → encryption) remain invertible. Returning a value passes it to the next plugin, while throwing a `LocalSpaceError` aborts the operation.

- **Per-call state** – plugins can stash data on `context.operationState` (e.g., capture the original value in `beforeSet` and reuse it in `afterSet`). For batch operations, `context.operationState.isBatch` is `true` and `context.operationState.batchSize` provides the total count.

- **Batch vs single hooks (deprecated combination)** – a 2.x batch call such as `setItems()` invokes **both** the batch hook (`beforeSetItems`) **and** the per-entry single hook (`beforeSet`, once per entry). On the per-entry single hook, `context.operationState.isBatch` is `true`. Defining both matching forms in a custom plugin is deprecated in 2.1; new plugins should define one form per phase. Existing plugins must keep the `if (context.operationState.isBatch) return value;` guard until migrated. The built-in TTL, encryption, and compression plugins retain this internal compatibility pattern through 2.x.

- **Batch write return values** – `setItems()` and `afterSetItems` use caller-facing logical values when a built-in TTL, compression, or encryption transform is active. Their storage envelopes remain internal to the driver path. Entry lineage is tracked by key and occurrence across `beforeSetItems`, so custom hooks may add, reorder, or replace entries without borrowing another key's logical value; an `afterSetItems` hook may still explicitly customize the returned entries.

- **Error handling & policies** – unexpected exceptions are reported through `plugin.onError`. Throw a `LocalSpaceError` if you need to stop the pipeline (validation failures, failed decryptions, etc.). Init policy: default fail-fast; set `pluginInitPolicy: 'disable-and-continue'` to log and skip the failing plugin. Runtime policy: default `pluginErrorPolicy: 'lenient'` reports and continues. The built-in encryption plugin always fails closed, including with the lenient policy; use `strict` for compression, TTL, or any correctness-critical custom plugin.

---

## Plugin Execution Order

Plugins are sorted by `priority` (higher runs first in `before*`, last in `after*`). Default priorities:

| Plugin      | Priority | Notes                                                         |
| ----------- | -------- | ------------------------------------------------------------- |
| encryption  | 0        | Encrypts after compression so decrypt runs first in `after*`  |
| compression | 5        | Runs before encryption so payload is compressible             |
| ttl         | 10       | Runs outermost so TTL wrapper is transformed by other plugins |

**Recommended order**: `[ttlPlugin, compressionPlugin, encryptionPlugin]`

---

## Built-in Plugins

### Payload envelope compatibility

LocalSpace 2.1 continues writing the legacy 2.x plugin payloads so an upgrade
does not rewrite stored data. Its readers also accept the frozen 3.0 envelope:

```ts
{
  __localspace__: {
    namespace: 'localspace.plugin',
    kind: 'encryption' | 'compression' | 'ttl',
    version: 1,
  },
  payload: { /* kind-specific fields */ },
}
```

Encryption payload fields are `algorithm`, `iv`, and `data`; compression uses
`algorithm`, `data`, and `originalSize`; TTL uses `data` and `expiresAt`. The
`__localspace__` namespace is reserved for internal envelopes. Readers reject
an unknown version or malformed matching payload with
`DESERIALIZATION_FAILED`; objects that merely resemble a legacy marker are
left as user values.

### TTL Plugin

Wraps values as `{ data, expiresAt }`, invalidates stale reads, and optionally runs background cleanup.

**Options:**

- `defaultTTL` (ms) and exact-key `keyTTL` overrides
- `cleanupInterval` to periodically scan expired entries
- `cleanupBatchSize` (default: 100) for efficient batch cleanup
- `onExpire(key, value)` callback after the expired entry is removed. Under the
  lenient policy callback failures are reported and the read still returns
  `null`; under the strict policy the callback error is propagated after the
  removal.

```ts
// Cache API responses for 5 minutes
const cacheStore = localspace.createInstance({
  name: 'api-cache',
  plugins: [
    ttlPlugin({
      defaultTTL: 5 * 60 * 1000, // 5 minutes
      keyTTL: {
        'user-profile': 30 * 60 * 1000, // 30 minutes for user data
        'session-token': 60 * 60 * 1000, // 1 hour for session
      },
      cleanupInterval: 60 * 1000, // Cleanup every minute
      cleanupBatchSize: 50, // Process 50 keys at a time
      onExpire: (key, value) => {
        console.log(`Cache expired: ${key}`);
      },
    }),
  ],
});

// Single item and batch operations both respect TTL
await cacheStore.setItem('user-profile', userData);
await cacheStore.setItems([
  { key: 'post-1', value: post1 },
  { key: 'post-2', value: post2 },
]);
```

---

### Encryption Plugin

Encrypts serialized payloads using the Web Crypto API (AES-GCM by default) and decrypts transparently on reads.

In LocalSpace 2.1, built-in storage transformations cover single and batch item
operations. `iterate()` and `runTransaction()` reject before invoking the
driver when encryption, compression, or TTL is active; use `keys()` with
`getItems()` for processed iteration. Plugin-aware transaction scopes are
planned for 3.0. This protection follows an internal capability attached by
the built-in factories; custom plugins may use the names `encryption`,
`compression`, or `ttl` without being treated as built-ins.

**Options:**

- Provide a `key` (CryptoKey/ArrayBuffer/string) or `keyDerivation` block (PBKDF2)
- A supplied `CryptoKey` is checked per operation: encrypted reads require its
  `decrypt` usage, while new AES-GCM writes require `encrypt`. This allows a
  decrypt-only key to serve a read-only migration path without weakening writes.
- Customize AES-GCM parameters, `ivLength`, `ivGenerator`, or `randomSource`.
  AES-CBC and AES-CTR are deprecated read-only migration modes in 2.1: they
  decrypt matching 2.0 payloads but reject every new write. AES-CTR readers
  must receive the original `counter` and `length` parameters.
- Works in browsers and modern Node runtimes (pass your own `subtle` when needed)

```ts
// Using a direct key
const secureStore = localspace.createInstance({
  name: 'secure-store',
  plugins: [
    encryptionPlugin({
      key: '0123456789abcdef0123456789abcdef', // 32 bytes for AES-256
    }),
  ],
});

// Using PBKDF2 key derivation (recommended for password-based encryption)
const passwordStore = localspace.createInstance({
  name: 'password-store',
  plugins: [
    encryptionPlugin({
      keyDerivation: {
        passphrase: userPassword,
        salt: 'unique-per-user-salt',
        iterations: 150000, // Higher = more secure but slower
        hash: 'SHA-256',
        length: 256,
      },
    }),
  ],
});

// Batch operations are also encrypted
await secureStore.setItems([
  { key: 'card-number', value: '4111-1111-1111-1111' },
  { key: 'cvv', value: '123' },
]);
```

---

### Compression Plugin

Runs LZ-string compression (or a custom codec) when payloads exceed a `threshold` and restores them on read.

**Options:**

- `threshold` (bytes) controls when compression kicks in
- Supply a custom `{ compress, decompress }` codec if you prefer pako/Brotli

```ts
const compressedStore = localspace.createInstance({
  name: 'compressed-store',
  plugins: [
    compressionPlugin({
      threshold: 1024, // Only compress if > 1KB
      algorithm: 'lz-string', // Label stored in metadata
    }),
  ],
});

// Custom codec example (using pako)
import pako from 'pako';

const pakoStore = localspace.createInstance({
  name: 'pako-store',
  plugins: [
    compressionPlugin({
      threshold: 512,
      algorithm: 'gzip',
      codec: {
        compress: (data) => pako.gzip(data),
        decompress: (data) => pako.ungzip(data, { to: 'string' }),
      },
    }),
  ],
});
```

---

## Plugin Combination Best Practices

1. **Recommended plugin order** (from highest to lowest priority):

   ```ts
   plugins: [
     ttlPlugin({ ... }),         // priority: 10
     compressionPlugin({ ... }), // priority: 5
     encryptionPlugin({ ... }),  // priority: 0
   ]
   ```

2. **Always compress before encrypting**: Encrypted data has high entropy and compresses poorly. The default priorities handle this automatically.

3. **Encryption always fails closed**. Key initialization, serialization, IV generation, encryption, and decryption failures propagate even when the global policy is lenient. Use strict policy when encryption is combined with other correctness-critical plugins:

   ```ts
   const secure = localspace.createInstance({
     plugins: [ttlPlugin({ defaultTTL: 60_000 }), encryptionPlugin({ key })],
     pluginErrorPolicy: 'strict', // Also propagates TTL and custom plugin errors
   });
   ```

4. **Batch operations run through plugin hooks**: Built-in plugins support `setItems`, `getItems`, and `removeItems`, but plugin-specific side effects can differ.

Cross-context synchronization is application policy, not a built-in plugin.
See `examples/broadcast-notification-plugin.ts` for a deliberately limited
best-effort notification example. Its default channel is isolated by active
driver and storage namespace; notifications also include the driver so custom
shared channels can filter messages from different physical backends.

Application-level serialized-size limits are likewise not browser quota
management and cannot be enforced atomically by a plugin. See
`examples/size-limit-plugin.ts` for a deliberately limited guard that rejects
writes without automatically deleting data.

---

## Plugin Troubleshooting

| Issue                      | Solution                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------- |
| TTL items not expiring     | Ensure `cleanupInterval` is set, or read items to trigger expiration               |
| Encryption operation fails | Inspect the propagated `LocalSpaceError`; encryption never falls back to plaintext |
| Compression not working    | Verify payload exceeds `threshold`                                                 |
| Plugin order seems wrong   | Check `priority` values; higher = runs first in `before*` hooks                    |

---

## Custom Plugin Development

Creating a plugin that times successful single-item and batch entry operations:

```ts
import localspace, { LocalSpacePlugin, PluginContext } from 'localspace';

interface TimingEntry {
  operation: 'set' | 'get' | 'remove';
  key: string;
  duration: number;
}

function timingPlugin(report: (entry: TimingEntry) => void): LocalSpacePlugin {
  const startedAtKey = 'timing-plugin-started-at';

  const start = (context: PluginContext) => {
    context.operationState[startedAtKey] = performance.now();
  };

  const finish = (
    operation: TimingEntry['operation'],
    key: string,
    context: PluginContext
  ) => {
    const startedAt = context.operationState[startedAtKey];
    if (typeof startedAt === 'number') {
      report({ operation, key, duration: performance.now() - startedAt });
    }
  };

  return {
    name: 'timing',
    beforeSet(_key, value, context) {
      start(context);
      return value;
    },
    afterSet(key, _value, context) {
      finish('set', key, context);
    },
    beforeGet(key, context) {
      start(context);
      return key;
    },
    afterGet(key, value, context) {
      finish('get', key, context);
      return value;
    },
    beforeRemove(key, context) {
      start(context);
      return key;
    },
    afterRemove(key, context) {
      finish('remove', key, context);
    },
  };
}

const timedStore = localspace.createInstance({
  name: 'timed-store',
  plugins: [
    timingPlugin((entry) => {
      console.log(`${entry.operation} ${entry.key}: ${entry.duration}ms`);
    }),
  ],
});

await timedStore.setItem('key', 'value');
```
