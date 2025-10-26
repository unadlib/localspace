import { LocalSpace } from './localspace';
import type {
  LocalSpaceInstance,
  LocalSpaceConfig,
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
  Driver,
  Callback,
  Serializer,
  CompatibilitySuccessCallback,
  CompatibilityErrorCallback,
};

// Export class for creating instances
export { LocalSpace };

// Export drivers
export { default as indexedDBDriver } from './drivers/indexeddb';
export { default as localStorageDriver } from './drivers/localstorage';

// Export serializer
export { default as serializer } from './utils/serializer';
