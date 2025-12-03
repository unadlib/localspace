import { LocalSpace } from './localspace';
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
  Callback,
  Serializer,
  CompatibilitySuccessCallback,
  CompatibilityErrorCallback,
} from './types';

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
  Callback,
  Serializer,
  CompatibilitySuccessCallback,
  CompatibilityErrorCallback,
};
export type { LocalSpaceErrorCode, LocalSpaceErrorDetails } from './errors';
export { LocalSpaceError } from './errors';

// Export class for creating instances
export { LocalSpace };

// Export drivers
export { default as indexedDBDriver } from './drivers/indexeddb';
export { default as localStorageDriver } from './drivers/localstorage';

// Export serializer
export { default as serializer } from './utils/serializer';

// Export plugins
export { ttlPlugin } from './plugins/ttl';
export { encryptionPlugin } from './plugins/encryption';
export { compressionPlugin } from './plugins/compression';
export { syncPlugin } from './plugins/sync';
export { quotaPlugin } from './plugins/quota';

export { PluginAbortError } from './core/plugin-manager';
