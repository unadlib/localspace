import type {
  LocalSpaceInstance,
  LocalSpaceOptions,
  ReactNativeAsyncStorage,
} from './types.js';
import reactNativeAsyncStorageDriver from './drivers/react-native-async-storage.js';
import { registerDriver } from './core/driver-registry.js';

/**
 * Register the React Native AsyncStorage driver in the current JavaScript
 * realm. Prefer `createReactNativeInstance()` or construction-scoped `drivers`
 * when realm-wide registration is unnecessary.
 */
export async function installReactNativeAsyncStorageDriver(): Promise<void> {
  await registerDriver(reactNativeAsyncStorageDriver, { overwrite: true });
}

export interface ReactNativeInstanceOptions extends LocalSpaceOptions {
  reactNativeAsyncStorage: ReactNativeAsyncStorage;
}

function normalizeDriverOrder(driver?: string | string[]): string[] {
  const requested = Array.isArray(driver)
    ? driver.slice()
    : driver
      ? [driver]
      : [];

  return [
    reactNativeAsyncStorageDriver._driver,
    ...requested.filter(
      (item) => item !== reactNativeAsyncStorageDriver._driver
    ),
  ];
}

/**
 * Create a LocalSpace instance configured for React Native in one step.
 * This adds the RN driver only to the new instance, selects it as primary, and
 * awaits readiness. It does not mutate the realm-wide driver registry.
 */
export async function createReactNativeInstance(
  baseInstance: LocalSpaceInstance,
  options: ReactNativeInstanceOptions
): Promise<LocalSpaceInstance> {
  const { drivers = [], driver, ...config } = options;
  const instance = baseInstance.createInstance({
    ...config,
    driver: normalizeDriverOrder(driver),
    drivers: [
      ...drivers.filter(
        (definition) =>
          definition._driver !== reactNativeAsyncStorageDriver._driver
      ),
      reactNativeAsyncStorageDriver,
    ],
  });
  await instance.ready();
  return instance;
}

export { reactNativeAsyncStorageDriver };
export type { ReactNativeAsyncStorage } from './types.js';
