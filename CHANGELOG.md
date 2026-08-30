# Changelog

## [Unreleased]

## [3.0.0] - 2026-08-31

### Added

- Added the recursive `StorageValue` contract for values that round-trip across
  IndexedDB, localStorage, memory, and React Native AsyncStorage. Every item,
  batch, plugin-output, and transaction-scope write is validated before storage
  side effects.
- Added collision-safe StoredRecord v1 encoding for every new logical value,
  while retaining readers for unwrapped 2.x values and legacy built-in-plugin
  payloads. Unknown versions and non-canonical envelope/payload shapes fail
  explicitly without invoking persisted accessors.
- Added immutable construction-scoped driver definitions, private per-selection
  driver sessions, and the explicit realm-wide `registerDriver()` API.
- Added frozen post-readiness driver capabilities for transactions, atomic
  batches, namespace deletion, persistence, and Storage Buckets.
- Added query/destructive plugin observers for `iterate`, `keys`, `key`,
  `length`, `clear`, and `dropInstance`, with a consistent decoded logical view.
- Added plugin-aware IndexedDB and memory transaction scopes covering logical
  get/set/remove, keys, async iteration, and clear.
- Added a serializable, realm-and-namespace-scoped scheduler for memory
  read-write transactions.
- Added an explicit React Native driver capability contract and official
  AsyncStorage Jest/React Native 0.83.x Detox fixtures. The manual iOS gate
  resolves, integrity-checks, installs, and records an exact published RC
  tarball instead of consuming the workspace package.
- Added Node 22/24 and Chromium/Firefox/WebKit release matrices.
- Added integrity-pinned 2.1.0 performance/package baselines, same-run relative
  comparison evidence, and exact package allowlist/size budgets.

### Changed

- Replaced runtime driver-method injection and wrapper refreshes with stable
  facade dispatch. Captured/destructured method references and spies continue
  using the active driver and plugin set across readiness and driver switches.
- Made configuration construction-time state. `config()` now returns a
  detached, deeply frozen snapshot and plugin registration locks at the first
  readiness/storage operation.
- Changed batch plugin execution to one hook form per plugin and phase: invoke
  the batch hook once when present, otherwise map the matching single hook.
  Priority ordering is preserved globally across both forms.
- Changed `iterate()` to await async callbacks sequentially, expose only logical
  decoded values, and return `U | undefined`.
- Changed TTL visibility so item, batch, iteration, key, and length views agree
  about expired entries; added aggregate clear/drop observers.
- Changed compression codecs to a bytes-to-bytes contract and persist a
  compression envelope only when its complete serialized representation is
  smaller than the raw representation.
- Restricted normal encryption to AES-GCM. AES-CBC/AES-CTR remain available only
  through a read-only legacy migration plugin. The AES-GCM writer owns its
  per-write IV; the public algorithm type exposes only the remaining parameters.
- Made Storage Bucket configuration an explicit placement requirement. Bucket
  unavailability/open failure no longer falls back to default IndexedDB or the
  next driver. Invalid bucket shapes reject before selection, and IndexedDB
  namespace deletion cannot cross the instance's selected bucket boundary.
- Made React Native AsyncStorage injection mandatory; runtime globals,
  `require`, and dynamic import are no longer probed.
- Kept the historical default namespace permanently fixed at
  `localforage/keyvaluepairs` so existing supported 2.x data remains addressable.

### Transactions

- Transaction runners must use only their supplied scope. Same-instance facade
  calls reject with `TRANSACTION_SCOPE_REQUIRED`, readonly mutations reject
  with `TRANSACTION_READONLY`, and inactive IndexedDB work fails explicitly.
- IndexedDB maintains one native object-store transaction across awaited scope
  and plugin work, including Web Crypto, compression, TTL, and async iteration.
- Memory transactions now serialize competing writers and atomically commit or
  roll back. The coordination boundary is the current JavaScript realm and
  namespace; LocalSpace adds no cross-tab/process locking layer.
- localStorage and React Native AsyncStorage keep a stable facade method but
  report `transactions: false` and reject before invoking the runner.

### Removed

- Removed `config(options)`, `instance.defineDriver()`, and `destroy()`.
- Removed the 2.1-only `strictValues` and `strictTransactions` migration options
  because 3.0 validation and transaction-scope enforcement are mandatory.
- Removed `prewarmTransactions`, `connectionIdleMs`, and
  `maxConcurrentTransactions` after pinned same-run measurements showed no
  stable benefit; supplying them now rejects instead of being ignored.
- Removed prefixed IndexedDB and legacy BlobBuilder branches.
- Removed callback-era and deep-source package compatibility assumptions.

### Packaging

- Restricted public exports to `localspace`, `localspace/react-native`, and
  `localspace/package.json`.
- Removed `src/`, TypeScript intermediate JavaScript, declaration maps, and the
  stale `source` package field from the tarball. Runtime maps retain embedded
  TypeScript `sourcesContent`.
- Added isolated ESM, CommonJS, React Native, declaration, forbidden-deep-import,
  bundled-compression, and mapped-stack consumer checks.
- Reduced the certified artifact from 138 to 63 files, from 756,538 to 432,120
  packed bytes, and from 3,387,413 to 1,929,372 unpacked bytes. Final budgets
  are enforced mechanically.

### Migration

- The final 2.1.x bridge is required for a data rollback after 3.0 writes.
  Published `localspace@2.1.0` can read plugin envelope v1 but cannot read the
  final core StoredRecord v1; do not use it as the rollback target.
- Convert rich values such as `Date`, `Map`, `Set`, `RegExp`, scalar `bigint`,
  accessors, cycles, sparse arrays, and class instances into explicit plain
  data before writing.
- See `docs/migration-guide.md` for transaction-scope, plugin hook, React
  Native, Storage Bucket, custom-driver, encryption, package, and rollback
  migrations.

## [2.1.0] - 2026-07-14

### Added

- Added idempotent `close()` for non-destructive instance disposal. It cleans
  initialized plugins, releases the active driver/context, preserves stored
  data, and makes later operations reject with `INSTANCE_CLOSED`.
- Added development-only, once-per-category 3.0 migration warnings and the
  exported `setDeprecationWarnings()` switch.
- Added readers and static compatibility fixtures for the versioned 3.0
  encryption, compression, and TTL envelopes while keeping the 2.x writer
  format unchanged.

### Fixed

- Made encryption fail closed for invalid algorithms, serialization failures,
  Web Crypto failures, and malformed or unknown-version encrypted payloads.
- Kept AES-CBC/AES-CTR legacy payloads available through read-only migration
  configurations while rejecting every new write with those algorithms.
- Restored read-only AES-GCM `CryptoKey` compatibility by requiring `decrypt`
  for reads and independently requiring `encrypt` for every new write.
- Prevented built-in transformation plugins from being silently bypassed by
  `runTransaction()` or from exposing raw envelopes through `iterate()`.
- Removed expired TTL values before reporting `onExpire` failures, and skipped
  notifications when deletion fails, so callback side effects only describe
  data that has actually been removed.
- Detached background TTL `onExpire` notifications from the lifecycle barrier
  so callbacks can await same-instance `close()` or `destroy()` without making
  the active sweep wait on itself.
- Avoided unnecessary blob capability detection for readonly IndexedDB
  transactions while preserving the permissive 2.x runner contract.
- Unified constructor and setter configuration validation while preserving the
  legacy setter's `storeName` namespace mapping.
- Rejected operations on closed instances before lazy plugin initialization,
  operation hooks, or transformation bypass checks can run.
- Rejected closing or switching drivers while storage operations are active so
  lifecycle calls cannot deadlock themselves or release driver resources early.
- Preserved zero-valued operational limits as the 2.x disabled/unbounded
  settings while continuing to reject negative or non-integer values.
- Identified built-in transformation plugins by an internal capability marker
  so same-named custom plugins no longer trigger guards or built-in warnings.
- Kept TTL, compression, and encryption envelopes internal when `setItems()`
  returns, while preserving custom hook additions, reordering, replacements,
  and logical-value customization in `afterSetItems`.
- Serialized overlapping `destroy()` and `close()` plugin teardown so each
  initialized plugin receives exactly one `onDestroy` call, and made `close()`
  wait for the complete plugin initialization pass started by `destroy()`.
- Isolated lifecycle reentrancy state per asynchronous plugin callback and per
  selected custom driver, releasing guarded receivers after settlement so
  retained contexts can serve later background work without false rejections.
- Kept `PluginContext.instance` identical to the public instance across every
  hook, exposed a separate guarded `lifecycleInstance` for async lifecycle
  calls, and preserved stable custom-driver receivers for identity-keyed state.
- Typed custom driver `_initStorage()` and `_closeStorage()` receivers as the
  selecting `LocalSpaceInstance`, matching the existing runtime contract.
- Attempted cleanup when custom `_initStorage()` throws synchronously and kept
  that initialization failure even if `_closeStorage()` also throws.
- Retained cleanup that rejects after failed custom-driver initialization and
  retried it during later `setDriver()` or `close()` attempts without repeating
  cleanup that already succeeded, while preserving the failed driver's
  callback-scoped receiver context across asynchronous retries.
- Stabilized `LocalSpaceError` classification and retained original driver,
  quota, plugin, and browser errors through `cause` and structured details.
- Keyed shared IndexedDB contexts by the resolved backend, deduplicated
  registrations, and released the final connection without deleting data.
- Retained unfinished custom-driver cleanup after a rejected `close()` or
  `setDriver()` so a later lifecycle call can retry without rerunning cleanup
  that already succeeded.

### Deprecated

- Deprecated AES-CBC/AES-CTR configuration, the ignored `size` option,
  `destroy()`, mutable `config()` references, matching batch/single hooks in one
  custom plugin, React Native adapter auto-detection, and unsupported package
  deep imports. Existing 2.x behavior is retained where it is safe to do so.

### Tooling

- Migrated to an executable ESLint 9 flat config, aligned Vitest and its
  coverage provider, and moved generated TypeDoc output to
  `generated-docs/api` so handwritten documentation is never replaced.
- Added pull-request CI without a duplicate build and separated deterministic
  browser correctness tests from opt-in performance benchmarks.
- Continued package-consumer coverage for ESM, CommonJS, React Native subpath,
  public types, production warning silence, and blocked deep imports.
- Made published bundle source maps resolve directly to TypeScript sources and
  made browser coverage fail when LocalSpace coverage cannot be mapped to them.

### Migration

- Existing core and legacy plugin data remain readable; 2.1 continues writing
  the legacy plugin format. Review `docs/migration-guide.md` before 3.0,
  especially for plugin-backed iteration/transactions and lifecycle cleanup.

---

## [2.0.1] - 2026-07-11

### Fixed

- Runtime plugin error policy now falls back to `lenient` (matching
  `DefaultConfig` and the documented default) instead of silently switching to
  `strict` when `pluginErrorPolicy` is explicitly `undefined`.
- `normalizeKey` warns once per non-string key type instead of on every call,
  preventing console flooding when non-string keys are passed in loops or
  batches. The warning notes that further keys of that type are converted
  silently.

### Deprecated

- The `size` configuration option is now explicitly deprecated. It is a legacy
  WebSQL-era hint retained only for localForage and localspace v2
  compatibility (default `4980736`); every built-in driver ignores it and it
  neither sets nor enforces a storage quota.

### Documentation

- Documented that a batch call (e.g. `setItems`) invokes both the batch hook
  and the per-entry single hook (with `context.operationState.isBatch === true`)
  and how to guard the single form to avoid processing each entry twice.
- Clarified that `config()` returns validation and lock failures as an `Error`
  value synchronously (a localForage-compatible contract) rather than throwing
  or rejecting, so `try/catch` will not catch them.
- Explained the localForage-compatible default `name`/`storeName`, when
  localForage data can be reused, and the requirement to migrate WebSQL data
  first.

### Changed

- Enabled `noUnusedLocals`, `noUnusedParameters`, and `noImplicitReturns` in the
  TypeScript configuration and cleaned up the affected source.
- Dropped unused UMD global externals from the Rolldown build configuration.

### Tests

- Added coverage for non-string key warning throttling and type-level coverage
  for the deprecated `size` option in the packaged consumer tests.

---

## [2.0.0] - 2026-07-10

### Fixed

- Added module-specific declaration graphs for CommonJS and ESM consumers,
  including the `localspace/react-native` subpath.

### Removed

- Removed `coalesceFireAndForget`, automatic write coalescing, and the
  `getPerformanceStats()` API. Use explicit `setItems()` and `removeItems()`
  calls for predictable batching.
- Removed `syncPlugin` from the package surface. Cross-context synchronization
  now belongs to application code; a best-effort notification example remains
  in `examples/broadcast-notification-plugin.ts`.
- Removed `quotaPlugin` from the package surface. Application-level size policy
  does not represent browser storage quota and cannot be enforced atomically;
  a deliberately limited example remains in `examples/size-limit-plugin.ts`.
- Removed sequential `runTransaction()` implementations from localStorage and
  React Native AsyncStorage. Those drivers now reject the method with
  `UNSUPPORTED_OPERATION` instead of presenting non-atomic work as a
  transaction.
- Removed completion callbacks, callback helper exports, and
  `compatibilityMode`. All public storage and driver-management operations are
  Promise-only.

### Changed

- Write promises now always settle after the driver operation completes.
- `runTransaction()` is available only when the selected driver can provide
  rollback semantics: IndexedDB and memory. localStorage and React Native
  AsyncStorage reject it with `UNSUPPORTED_OPERATION`.
- The built-in plugin surface is focused on TTL, encryption, and compression.
  Cross-context notifications and application size limits remain as explicitly
  non-published, best-effort examples.

### Migration

- Existing core key/value data does not require a storage migration.
- See `docs/migration-guide.md` for callback conversion, explicit batching,
  transaction capability checks, and plugin replacements.

---

## [1.3.0] - 2026-05-30

### Fixed

- Restored CommonJS package exports by emitting real `.cjs` bundles for the
  default and `localspace/react-native` entry points.

### Changed

- Moved the Detox simulator workflow to manual dispatch so the heavyweight
  React Native smoke fixture no longer runs as blocking CI.
- Documented coalesced writes as experimental and clarified the
  `coalesceFireAndForget` persistence risk.

### Deprecated

- Added 2.0 migration warnings for `syncPlugin` as a main package plugin export,
  `quotaPlugin`'s app-level size-limit semantics, and non-atomic
  `runTransaction()` behavior in the localStorage and React Native drivers.

### Tests

- Added package export smoke coverage for CommonJS and ESM entry points.

---

## [1.2.0] - 2026-04-26

### Added

- Built-in opt-in memory driver (`MEMORY` / `'memoryStorageWrapper'`) for
  runtime-only fallback when browser persistent storage is unavailable.

### Fixed

- Prevented failed driver initialization from creating an extra internal
  unhandled rejection after callers already catch the public operation error.

---

## [1.1.0] - 2026-02-07

### Added

- **React Native AsyncStorage driver** with full LocalSpace API support:
  - Single ops: `getItem`, `setItem`, `removeItem`, `clear`
  - Batch ops: `setItems`, `getItems`, `removeItems` (uses `multiSet`/`multiGet`/`multiRemove` when available)
  - Iteration/query ops: `iterate`, `keys`, `key`, `length`, `dropInstance`
  - Transaction helper parity via sequential `runTransaction`
- **New driver constant**: `REACTNATIVEASYNCSTORAGE` (`'reactNativeAsyncStorageWrapper'`)
- **New config option**: `reactNativeAsyncStorage` for explicit adapter injection (recommended in React Native apps)
- **Runtime detection** for `@react-native-async-storage/async-storage` (with legacy `react-native` AsyncStorage fallback)
- **New opt-in subpath export**: `localspace/react-native` for installing/exporting the React Native driver.
- **New one-step helper**: `createReactNativeInstance(baseInstance, options)` to create ready RN instances without manual driver wiring.

### Changed

- React Native AsyncStorage driver is no longer bundled in the default `localspace` entry.
- Web-only consumers now receive smaller bundles unless they explicitly import `localspace/react-native`.
- `installReactNativeAsyncStorageDriver()` is now idempotent and no longer redefines an already-registered RN driver.
- `setDriver()` can now recover after a failed default driver initialization, enabling manual fallback to custom/RN drivers.

### Tests

- Added comprehensive unit tests for the React Native AsyncStorage driver path, including namespacing and batch behavior.
- Added runtime detection tests for global/module-based AsyncStorage discovery and unavailable-runtime fallback behavior.
- Added isolated RN integration smoke harness at `integration/react-native-jest/` using the official AsyncStorage Jest mock.
- Added GitHub Actions Detox workflow template (`.github/workflows/detox-mobile.yml`) with iOS simulator + Android emulator jobs and auto-skip when fixture app is not configured.
- Added a real React Native Detox fixture app at `integration/react-native-detox/` with localspace AsyncStorage smoke e2e.

---

## [1.0.1] - 2026-01-16

### Fixed

- **localStorage `length()` errors**: Fixed `length()` and `key()` methods to correctly count only namespaced keys, preventing incorrect results when other data exists in localStorage.
- **`pluginErrorPolicy` default**: Changed default `pluginErrorPolicy` from `'throw'` to `'warn'` for better fault tolerance in production environments.
- **Config atomicity**: Improved configuration handling to ensure atomic updates and prevent race conditions during concurrent configuration changes.

### Tests

- Added regression tests for localStorage key enumeration edge cases.
- Added tests for `pluginErrorPolicy` default behavior.

---

## [1.0.0] - 2026-01-15

### 🎉 First Stable Release

localspace reaches v1.0.0, marking a stable API ready for production use. This release represents a complete, modern reimplementation of the localForage API with TypeScript-first design, native async/await support, and zero legacy baggage.

### Highlights

- **100% localForage API Compatibility**: Drop-in replacement for existing localForage codebases
- **TypeScript-First**: Full type definitions with generics for value typing
- **Modern JavaScript**: Native Promises, async/await, ES modules
- **High Performance**: Batch operations 6-10x faster than single-item loops
- **Plugin Architecture**: Extensible system with 5 built-in plugins

### Core Features

- **Storage Drivers**: IndexedDB (primary) and localStorage (fallback)
- **Batch Operations**: `setItems()`, `getItems()`, `removeItems()` for bulk operations
- **Transaction API**: `runTransaction()` for atomic multi-operation workflows
- **Coalesced Writes**: Automatic write batching for 3-10x performance improvement (opt-in)
- **Storage Buckets**: Chrome 122+ isolated storage support
- **Connection Pooling**: Transaction concurrency control and idle timeout

### Plugin System

- **TTL Plugin**: Time-to-live expiration with automatic cleanup
- **Encryption Plugin**: AES-GCM encryption via Web Crypto API
- **Compression Plugin**: LZ-string compression for large values
- **Sync Plugin**: Multi-tab synchronization via BroadcastChannel
- **Quota Plugin**: Automatic quota management with LRU eviction

### Error Handling

- **Structured Errors**: `LocalSpaceError` class with 16 distinct error codes
- **Full Context**: Contextual details including driver, operation, and key
- **Error Chain**: Original errors preserved in `cause` property

### Performance

Based on Playwright benchmarks (500 items × 256B):

| Operation        | Improvement vs Loops |
| ---------------- | -------------------- |
| `setItems`       | ~6x faster           |
| `getItems`       | ~7.7x faster         |
| `removeItems`    | ~2.8x faster         |
| Coalesced writes | 3-10x faster         |

### Breaking Changes

None — v1.0.0 maintains full backward compatibility with v0.x releases.

---

## [0.3.1] - 2025-12-07

### Fixed

- **Coalesced Writes Consistency**: Changed default behavior to prioritize strong consistency. Coalescing performance modes are now opt-in.
- **Destructive Operations**: Fixed `dropInstance`, `clear`, and `removeItems` to correctly flush pending coalesced writes before execution.
- **TTL Plugin**: Fixed cleanup logic to be compatible with encryption and compression plugins.
- **Transaction Consistency**: `runTransaction` now forces a flush of pending coalesced writes before starting, ensuring consistency even in `eventual` mode.
- **Compression Plugin**: Fixed error handling to correctly propagate `LocalSpaceError` when compression fails.

## [0.3.0] - 2025-12-04

### Added

- **Plugin System**: Full plugin architecture for extensible functionality
  - Support for custom plugins with lifecycle hooks
  - Plugin manager for registering and managing plugins
  - Encryption plugin support

### Fixed

- **Typed Array Serialization**: Fixed serialization issues with TypedArray (Uint8Array, Int8Array, etc.)
- **Batch Operations**: Fixed `setItems`/`getItems` wrapper issues
- **Batch Size**: Fixed `batchSize` configuration issue
- **Plugin Manager**: Fixed plugin manager initialization and lifecycle issues
- **Plugin Encryption**: Fixed encryption plugin functionality

### Changed

- Updated TypeScript configuration for better type safety

### Documentation

- Updated README with plugin system documentation

## [0.2.2] - 2025-12-03

### Added

- **Structured Error Handling**: New `LocalSpaceError` class with detailed error context
  - Exported `LocalSpaceError`, `LocalSpaceErrorCode`, and `LocalSpaceErrorDetails` types
  - 16 distinct error codes: `CONFIG_LOCKED`, `INVALID_CONFIG`, `DRIVER_COMPLIANCE`, `DRIVER_NOT_FOUND`, `DRIVER_UNAVAILABLE`, `DRIVER_NOT_INITIALIZED`, `UNSUPPORTED_OPERATION`, `INVALID_ARGUMENT`, `TRANSACTION_READONLY`, `SERIALIZATION_FAILED`, `DESERIALIZATION_FAILED`, `BLOB_UNSUPPORTED`, `OPERATION_FAILED`, `QUOTA_EXCEEDED`, `UNKNOWN`
  - All errors include contextual `details` object with driver, operation, key, and other relevant information
  - Original error preserved in `cause` property for full error chain tracing
  - All driver operations (IndexedDB, localStorage) now throw structured errors
  - Helper utilities: `createLocalSpaceError()`, `toLocalSpaceError()`, `normalizeUnknownError()`

### Fixed

- **IndexedDB coalesceWrites activation**: Fixed logic to enable write coalescing regardless of `maxBatchSize` configuration
  - Previously, coalesceWrites would only activate when `maxBatchSize` was explicitly set
  - Now correctly activates when `coalesceWrites: true` (default) independent of batch size settings
  - Ensures optimal performance for rapid writes in all configurations

### Changed

- **Error handling**: All operations now throw `LocalSpaceError` instead of generic `Error`
  - Check `error.code` for programmatic error handling instead of parsing messages
  - Example: `error.code === 'QUOTA_EXCEEDED'` for storage quota errors
  - Backward compatible: `LocalSpaceError` extends `Error`, existing catch blocks still work

### Documentation

- Updated troubleshooting guide with structured error handling examples
- Added error code reference and usage patterns
- Documented error context properties for debugging

## [0.2.1] - 2025-11-29

### Fixed

- **runTransaction Blob race condition**: Fixed `InvalidStateError` when writing Blobs in transactions
  - Precompute blob support before creating transaction to avoid async wait inside active transaction
  - Add transaction activity check before `store.put()` to detect early commits
  - Prevents transaction auto-commit when blob encoding takes too long (large files or slow environments)
- **scheduleIdleClose optimization**: Remove unnecessary reconnection after idle close
  - Defer closing when pending/active transactions exist
  - Remove immediate execution of pending transactions after connection close
  - Reduces latency spikes and resource churn
- **onversionchange stale references**: Synchronize all database references on version change
  - Clear `dbContext.db` and all `forage._dbInfo.db` references when database closes
  - Reset prewarmed state to force fresh connection
  - Eliminates stale handle usage and improves reconnection reliability
- **dropInstance memory leak**: Clean up database context after dropping entire database
  - Delete context entry from `dbContexts` map after successful database deletion
  - Prevents memory accumulation when repeatedly creating/dropping instances
- **Write coalescing logic**: Simplify activation condition for better composability
  - Remove `maxConcurrentTransactions` check from coalesce condition
  - Allow write coalescing and transaction limiting to work independently
  - Fix counter-intuitive behavior when `maxConcurrentTransactions: 0` (no limit)

### Performance

- Reduced reconnection overhead in idle-close scenarios
- More predictable transaction behavior under concurrent load

## [0.2.0] - 2025-11-26

### Added

- **Batch Operations**: `setItems()`, `getItems()`, `removeItems()` for 6-10x performance improvement
- **Transaction API**: `runTransaction()` for atomic multi-operation workflows
- **Auto Write Coalescing**: Automatically merge rapid writes (enabled by default, 3-10x faster)
- **Performance Stats API**: `getPerformanceStats()` to track coalescing efficiency
- **Connection Pool**: Transaction concurrency control and idle timeout
- **Storage Buckets Support**: Chrome 122+ isolated storage

### Fixed

- runTransaction now properly uses createTransaction (connection management)
- Blob operations handle closed connections correctly (auto-reconnect)
- localStorage runTransaction respects readonly mode

### Changed

- **coalesceWrites** now enabled by default (8ms window)
  - Can be disabled: `createInstance({ coalesceWrites: false })`
  - Performance impact: 3-10x faster for rapid writes, no impact on single writes

### Performance

- Playwright benchmarks on 500 items × 256B:
  - setItems: ~6x faster than loops
  - getItems: ~7.7x faster than loops
  - removeItems: ~2.8x faster than loops

### Breaking Changes

None - all changes are backward compatible
