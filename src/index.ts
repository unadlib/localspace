import { LocalSpace } from './localspace.js';
import type {
  LocalSpaceInstance,
  LocalSpaceConfig,
  LocalSpaceOptions,
  LocalSpacePlugin,
  PluginContext,
  PluginErrorInfo,
  PluginOperation,
  PluginStage,
  PluginEnabledPredicate,
  Driver,
  Serializer,
  ReactNativeAsyncStorage,
  StorageBucketConfig,
  KeyValuePair,
  BatchItems,
  BatchResponse,
  TransactionMode,
  TransactionScope,
  StoragePrimitive,
  StorageBinary,
  StorageValue,
  DriverRegistrationOptions,
  DriverCapabilities,
  LocalSpaceCapabilities,
} from './types.js';

// Create default instance
const localspace = new LocalSpace() as LocalSpaceInstance;

// Export default instance
export default localspace;

// Export types
export type {
  LocalSpaceInstance,
  LocalSpaceConfig,
  LocalSpaceOptions,
  LocalSpacePlugin,
  PluginContext,
  PluginErrorInfo,
  PluginOperation,
  PluginStage,
  PluginEnabledPredicate,
  Driver,
  Serializer,
  ReactNativeAsyncStorage,
  StorageBucketConfig,
  KeyValuePair,
  BatchItems,
  BatchResponse,
  TransactionMode,
  TransactionScope,
  StoragePrimitive,
  StorageBinary,
  StorageValue,
  DriverRegistrationOptions,
  DriverCapabilities,
  LocalSpaceCapabilities,
};
export type { LocalSpaceErrorCode, LocalSpaceErrorDetails } from './errors.js';
export { LocalSpaceError } from './errors.js';
export { setDeprecationWarnings } from './utils/deprecations.js';
export { registerDriver } from './core/driver-registry.js';

// Export class for creating instances
export { LocalSpace };

// Export drivers
export { default as indexedDBDriver } from './drivers/indexeddb.js';
export { default as localStorageDriver } from './drivers/localstorage.js';
export { default as memoryDriver } from './drivers/memory.js';

// Export serializer
export { default as serializer } from './utils/serializer.js';

// Export plugins
export { ttlPlugin } from './plugins/ttl.js';
export { encryptionPlugin } from './plugins/encryption.js';
export { compressionPlugin } from './plugins/compression.js';

export { PluginAbortError } from './core/plugin-manager.js';
