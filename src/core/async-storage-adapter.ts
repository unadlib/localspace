import type { ReactNativeAsyncStorage } from '../types.js';

const asyncStorageAdapterSources = new WeakMap<
  ReactNativeAsyncStorage,
  ReactNativeAsyncStorage
>();

/**
 * Records the caller-supplied adapter behind an instance's frozen snapshot.
 */
export const setAsyncStorageAdapterSource = (
  snapshot: ReactNativeAsyncStorage,
  adapter: ReactNativeAsyncStorage
): void => {
  asyncStorageAdapterSources.set(
    snapshot,
    getAsyncStorageAdapterSource(adapter)
  );
};

/**
 * Returns the caller-supplied adapter behind an instance's frozen snapshot, so
 * instances configured with the same AsyncStorage can share driver state.
 */
export const getAsyncStorageAdapterSource = (
  adapter: ReactNativeAsyncStorage
): ReactNativeAsyncStorage =>
  asyncStorageAdapterSources.get(adapter) ?? adapter;
