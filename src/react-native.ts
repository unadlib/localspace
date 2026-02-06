import type {
  LocalSpaceInstance,
  LocalSpaceOptions,
  ReactNativeAsyncStorage,
} from './types';
import reactNativeAsyncStorageDriver from './drivers/react-native-async-storage';

/**
 * Install the React Native AsyncStorage driver on a localspace instance.
 * Call this before selecting `instance.REACTNATIVEASYNCSTORAGE`.
 */
export async function installReactNativeAsyncStorageDriver(
  instance: LocalSpaceInstance
): Promise<void> {
  try {
    await instance.getDriver(instance.REACTNATIVEASYNCSTORAGE);
    return;
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null;

    if (code && code !== 'DRIVER_NOT_FOUND') {
      throw error;
    }
  }

  await instance.defineDriver(reactNativeAsyncStorageDriver);
}

export interface ReactNativeInstanceOptions extends LocalSpaceOptions {
  reactNativeAsyncStorage: ReactNativeAsyncStorage;
}

function normalizeDriverOrder(
  instance: LocalSpaceInstance,
  driver?: string | string[]
): string[] {
  const requested = Array.isArray(driver)
    ? driver.slice()
    : driver
      ? [driver]
      : [];

  return [
    instance.REACTNATIVEASYNCSTORAGE,
    ...requested.filter((item) => item !== instance.REACTNATIVEASYNCSTORAGE),
  ];
}

/**
 * Create a LocalSpace instance configured for React Native in one step.
 * This installs the RN driver, selects it as primary, and awaits readiness.
 */
export async function createReactNativeInstance(
  baseInstance: LocalSpaceInstance,
  options: ReactNativeInstanceOptions
): Promise<LocalSpaceInstance> {
  const instance = baseInstance.createInstance(options);
  await installReactNativeAsyncStorageDriver(instance);
  await instance.setDriver(normalizeDriverOrder(instance, options.driver));
  await instance.ready();
  return instance;
}

export { reactNativeAsyncStorageDriver };
export type { ReactNativeAsyncStorage } from './types';
