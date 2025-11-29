# Changelog

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
