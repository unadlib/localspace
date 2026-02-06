# Changelog

## [1.0.2] - 2026-02-06

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
