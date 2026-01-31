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
    syncPlugin({ channelName: 'localspace-sync' }),
    quotaPlugin({ maxSize: 5 * 1024 * 1024, evictionPolicy: 'lru' }),
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
  - [Sync Plugin](#sync-plugin)
  - [Quota Plugin](#quota-plugin)
- [Plugin Combination Best Practices](#plugin-combination-best-practices)
- [Plugin Troubleshooting](#plugin-troubleshooting)
- [Custom Plugin Development](#custom-plugin-development)

---

## Lifecycle and Hooks

- **Registration** – supply `plugins` when calling `createInstance()` or chain `instance.use(plugin)` later. Each plugin can also expose `enabled` (boolean or function) and `priority` to control execution order.

- **Lifecycle events** – `onInit(context)` is invoked after `ready()`, and `onDestroy` lets you tear down timers or channels. Call `await instance.destroy()` when disposing of an instance to run every `onDestroy` hook (executed in reverse priority order). Context exposes the active driver, db info, config, and a shared `metadata` bag for cross-plugin coordination.

- **Interceptors** – hook into `beforeSet/afterSet`, `beforeGet/afterGet`, `beforeRemove/afterRemove`, plus batch-specific methods such as `beforeSetItems` or `beforeGetItems`. Hooks run sequentially: `before*` hooks execute from highest to lowest priority, while `after*` hooks unwind in reverse order so layered transformations (TTL → compression → encryption) remain invertible. Returning a value passes it to the next plugin, while throwing a `LocalSpaceError` aborts the operation.

- **Per-call state** – plugins can stash data on `context.operationState` (e.g., capture the original value in `beforeSet` and reuse it in `afterSet`). For batch operations, `context.operationState.isBatch` is `true` and `context.operationState.batchSize` provides the total count.

- **Error handling & policies** – unexpected exceptions are reported through `plugin.onError`. Throw a `LocalSpaceError` if you need to stop the pipeline (quota violations, failed decryptions, etc.). Init policy: default fail-fast; set `pluginInitPolicy: 'disable-and-continue'` to log and skip the failing plugin. Runtime policy: default `pluginErrorPolicy: 'lenient'` reports and continues; use `strict` for encryption/compression/ttl or any correctness-critical plugin.

---

## Plugin Execution Order

Plugins are sorted by `priority` (higher runs first in `before*`, last in `after*`). Default priorities:

| Plugin      | Priority | Notes                                                                |
| ----------- | -------- | -------------------------------------------------------------------- |
| sync        | -100     | Runs last in `afterSet` to broadcast original (untransformed) values |
| quota       | -10      | Runs late so it measures final payload sizes                         |
| encryption  | 0        | Encrypts after compression so decrypt runs first in `after*`         |
| compression | 5        | Runs before encryption so payload is compressible                    |
| ttl         | 10       | Runs outermost so TTL wrapper is transformed by other plugins        |

**Recommended order**: `[ttlPlugin, compressionPlugin, encryptionPlugin, syncPlugin, quotaPlugin]`

---

## Built-in Plugins

### TTL Plugin

Wraps values as `{ data, expiresAt }`, invalidates stale reads, and optionally runs background cleanup.

**Options:**

- `defaultTTL` (ms) and `keyTTL` overrides
- `cleanupInterval` to periodically scan expired entries
- `cleanupBatchSize` (default: 100) for efficient batch cleanup
- `onExpire(key, value)` callback before removal

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

**Options:**

- Provide a `key` (CryptoKey/ArrayBuffer/string) or `keyDerivation` block (PBKDF2)
- Customize `algorithm`, `ivLength`, `ivGenerator`, or `randomSource`
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

### Sync Plugin

Keeps multiple tabs/processes in sync via `BroadcastChannel` (with `storage`-event fallback).

**Options:**

- `channelName` separates logical buses
- `syncKeys` lets you scope which keys broadcast
- `conflictStrategy` defaults to `last-write-wins`; provide `onConflict` (return `false` to drop remote writes) for merge logic

```ts
const syncedStore = localspace.createInstance({
  name: 'synced-store',
  plugins: [
    syncPlugin({
      channelName: 'my-app-sync',
      syncKeys: ['cart', 'preferences', 'theme'], // Only sync these keys
      conflictStrategy: 'last-write-wins',
      onConflict: ({ key, localTimestamp, incomingTimestamp, value }) => {
        console.log(
          `Conflict on ${key}: local=${localTimestamp}, incoming=${incomingTimestamp}`
        );
        // Return false to reject the incoming change
        return localTimestamp < incomingTimestamp;
      },
    }),
  ],
});

// Changes sync across tabs automatically
await syncedStore.setItem('cart', {
  items: [
    /* cart items */
  ],
});
await syncedStore.setItems([
  { key: 'preferences', value: { darkMode: true } },
  { key: 'theme', value: 'blue' },
]);
```

---

### Quota Plugin

Tracks approximate storage usage after every mutation and enforces limits.

**Options:**

- `maxSize` (bytes) and optional `useNavigatorEstimate` to read the browser's quota
- `evictionPolicy: 'error' | 'lru'` (LRU removes least-recently-used keys automatically)
- `onQuotaExceeded(info)` fires before throwing so you can log/alert users

```ts
const quotaStore = localspace.createInstance({
  name: 'quota-store',
  plugins: [
    quotaPlugin({
      maxSize: 5 * 1024 * 1024, // 5 MB
      evictionPolicy: 'lru', // Automatically evict least-recently-used items
      useNavigatorEstimate: true, // Also respect browser quota
      onQuotaExceeded: ({ key, attemptedSize, maxSize, currentUsage }) => {
        console.warn(`Quota exceeded: tried to write ${attemptedSize} bytes`);
        console.warn(`Current usage: ${currentUsage}/${maxSize} bytes`);
      },
    }),
  ],
});

// Batch operations are also quota-checked
await quotaStore.setItems([
  { key: 'large-1', value: largeData1 },
  { key: 'large-2', value: largeData2 },
]); // Throws QUOTA_EXCEEDED if total exceeds limit
```

> **Tip**: Place quota plugins last so they see the final payload size after other transformations (TTL, encryption, compression, etc.).

---

## Plugin Combination Best Practices

1. **Recommended plugin order** (from highest to lowest priority):

   ```ts
   plugins: [
     ttlPlugin({ ... }),         // priority: 10
     compressionPlugin({ ... }), // priority: 5
     encryptionPlugin({ ... }),  // priority: 0
     quotaPlugin({ ... }),       // priority: -10
     syncPlugin({ ... }),        // priority: -100
   ]
   ```

2. **Always compress before encrypting**: Encrypted data has high entropy and compresses poorly. The default priorities handle this automatically.

3. **Use strict error policy with security-critical plugins** (default is lenient):

   ```ts
   // DON'T do this - encryption failures will be silently swallowed
   const bad = localspace.createInstance({
     plugins: [encryptionPlugin({ key })],
     pluginErrorPolicy: 'lenient', // Dangerous!
   });

   // DO this - encryption failures will propagate
   const good = localspace.createInstance({
     plugins: [encryptionPlugin({ key })],
     pluginErrorPolicy: 'strict', // Safe (recommended)
   });
   ```

4. **Batch operations work with all plugins**: All built-in plugins support `setItems`, `getItems`, and `removeItems`.

---

## Plugin Troubleshooting

| Issue                        | Solution                                                               |
| ---------------------------- | ---------------------------------------------------------------------- |
| TTL items not expiring       | Ensure `cleanupInterval` is set, or read items to trigger expiration   |
| Encryption fails silently    | Set `pluginErrorPolicy: 'strict'` for encryption/compression/ttl       |
| Compression not working      | Verify payload exceeds `threshold`                                     |
| Sync not updating other tabs | Check `channelName` matches and `syncKeys` includes your key           |
| Quota errors on small writes | Other plugins (TTL, encryption) add overhead; account for wrapper size |
| Plugin order seems wrong     | Check `priority` values; higher = runs first in `before*` hooks        |

---

## Custom Plugin Development

Creating your own plugin with full lifecycle support:

```ts
import localspace, { LocalSpacePlugin, PluginContext } from 'localspace';

interface AuditLogEntry {
  timestamp: number;
  operation: 'set' | 'get' | 'remove' | 'clear';
  key?: string;
  success: boolean;
  duration: number;
  error?: string;
}

interface AuditPluginOptions {
  logToConsole?: boolean;
  maxLogSize?: number;
  onAuditEntry?: (entry: AuditLogEntry) => void;
  excludeKeys?: string[];
}

function auditPlugin(options: AuditPluginOptions = {}): LocalSpacePlugin {
  const {
    logToConsole = false,
    maxLogSize = 1000,
    onAuditEntry,
    excludeKeys = [],
  } = options;

  const auditLog: AuditLogEntry[] = [];

  function addEntry(entry: AuditLogEntry) {
    auditLog.push(entry);
    if (auditLog.length > maxLogSize) {
      auditLog.shift(); // Remove oldest entry
    }

    if (logToConsole) {
      console.log(`[Audit] ${entry.operation} ${entry.key ?? ''}`, entry);
    }

    onAuditEntry?.(entry);
  }

  function shouldAudit(key?: string): boolean {
    return (
      !key ||
      !excludeKeys.some((pattern) =>
        pattern.endsWith('*')
          ? key.startsWith(pattern.slice(0, -1))
          : key === pattern
      )
    );
  }

  return {
    name: 'audit',
    priority: 100, // Run first (before other plugins)

    async onInit(context: PluginContext) {
      console.log('[Audit] Plugin initialized for', context.config.name);
    },

    async onDestroy() {
      console.log(
        '[Audit] Plugin destroyed, logged',
        auditLog.length,
        'entries'
      );
    },

    async beforeSet(context) {
      if (shouldAudit(context.key)) {
        context.operationState.auditStartTime = performance.now();
      }
      return context.value;
    },

    async afterSet(context) {
      if (shouldAudit(context.key) && context.operationState.auditStartTime) {
        addEntry({
          timestamp: Date.now(),
          operation: 'set',
          key: context.key,
          success: true,
          duration: performance.now() - context.operationState.auditStartTime,
        });
      }
      return context.value;
    },

    async beforeGet(context) {
      if (shouldAudit(context.key)) {
        context.operationState.auditStartTime = performance.now();
      }
      return context.value;
    },

    async afterGet(context) {
      if (shouldAudit(context.key) && context.operationState.auditStartTime) {
        addEntry({
          timestamp: Date.now(),
          operation: 'get',
          key: context.key,
          success: context.value !== null,
          duration: performance.now() - context.operationState.auditStartTime,
        });
      }
      return context.value;
    },

    async beforeRemove(context) {
      if (shouldAudit(context.key)) {
        context.operationState.auditStartTime = performance.now();
      }
    },

    async afterRemove(context) {
      if (shouldAudit(context.key) && context.operationState.auditStartTime) {
        addEntry({
          timestamp: Date.now(),
          operation: 'remove',
          key: context.key,
          success: true,
          duration: performance.now() - context.operationState.auditStartTime,
        });
      }
    },

    async beforeClear(context) {
      context.operationState.auditStartTime = performance.now();
    },

    async afterClear(context) {
      if (context.operationState.auditStartTime) {
        addEntry({
          timestamp: Date.now(),
          operation: 'clear',
          success: true,
          duration: performance.now() - context.operationState.auditStartTime,
        });
      }
    },

    onError(error, context) {
      addEntry({
        timestamp: Date.now(),
        operation: context.operation as 'set' | 'get' | 'remove' | 'clear',
        key: context.key,
        success: false,
        duration: 0,
        error: error.message,
      });
    },

    // Expose audit log for external access
    getAuditLog: () => [...auditLog],
    clearAuditLog: () => {
      auditLog.length = 0;
    },
  };
}

// Usage
const auditedStore = localspace.createInstance({
  name: 'audited-store',
  plugins: [
    auditPlugin({
      logToConsole: true,
      maxLogSize: 500,
      excludeKeys: ['internal:*', 'temp:*'],
      onAuditEntry: (entry) => {
        // Send to analytics or monitoring service
        if (!entry.success) {
          reportError(entry);
        }
      },
    }),
  ],
});

function reportError(entry: AuditLogEntry) {
  // Send to error tracking service
  console.error('Storage operation failed:', entry);
}
```
