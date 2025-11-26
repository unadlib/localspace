# Changelog

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
