import { Localspace } from './localspace';
import type {
  LocalspaceInstance,
  LocalspaceConfig,
  Driver,
  Callback,
  Serializer,
} from './types';

// Create default instance
const localspace = new Localspace() as LocalspaceInstance;

// Export default instance
export default localspace;

// Export types
export type {
  LocalspaceInstance,
  LocalspaceConfig,
  Driver,
  Callback,
  Serializer,
};

// Export class for creating instances
export { Localspace };

// Export drivers
export { default as indexedDBDriver } from './drivers/indexeddb';
export { default as localStorageDriver } from './drivers/localstorage';

// Export serializer
export { default as serializer } from './utils/serializer';
