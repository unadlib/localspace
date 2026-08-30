import { createLocalSpaceError } from '../errors.js';
import type {
  Driver,
  DriverCapabilities,
  LocalSpaceCapabilities,
  LocalSpaceConfig,
  LocalSpaceInstance,
} from '../types.js';

const CAPABILITY_NAMES = [
  'transactions',
  'atomicBatch',
  'dropInstance',
  'persistent',
  'storageBuckets',
] as const satisfies ReadonlyArray<keyof LocalSpaceCapabilities>;

const capabilityNameSet = new Set<string>(CAPABILITY_NAMES);

const complianceError = (driver: string, reason: string) =>
  createLocalSpaceError('DRIVER_COMPLIANCE', 'Custom driver not compliant', {
    driver,
    reason,
  });

const validateDeclaration = (
  value: unknown,
  driver: string
): Readonly<DriverCapabilities> => {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw complianceError(driver, '_capabilities must return a plain object');
  }

  const snapshot: Record<string, boolean> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !capabilityNameSet.has(key)) {
      throw complianceError(driver, `unknown capability ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw complianceError(
        driver,
        `capability ${key} must be a data property`
      );
    }
    if (typeof descriptor.value !== 'boolean') {
      throw complianceError(driver, `capability ${key} must be a boolean`);
    }
    snapshot[key] = descriptor.value;
  }

  return Object.freeze(snapshot) as Readonly<DriverCapabilities>;
};

const assertCompatibleMethods = (
  definition: Readonly<Driver>,
  capabilities: Readonly<DriverCapabilities>
): void => {
  if (
    capabilities.transactions === true &&
    typeof definition.runTransaction !== 'function'
  ) {
    throw complianceError(
      definition._driver,
      'transactions requires runTransaction'
    );
  }
  if (
    capabilities.dropInstance === true &&
    typeof definition.dropInstance !== 'function'
  ) {
    throw complianceError(
      definition._driver,
      'dropInstance capability requires dropInstance'
    );
  }
  if (
    capabilities.atomicBatch === true &&
    (typeof definition.setItems !== 'function' ||
      typeof definition.removeItems !== 'function')
  ) {
    throw complianceError(
      definition._driver,
      'atomicBatch requires setItems and removeItems'
    );
  }
};

export const snapshotCapabilityDeclaration = (
  driver: Driver
): Driver['_capabilities'] => {
  const declaration = driver._capabilities;
  if (declaration === undefined) {
    return undefined;
  }
  if (typeof declaration === 'function') {
    return declaration;
  }
  const snapshot = validateDeclaration(declaration, driver._driver);
  assertCompatibleMethods(driver, snapshot);
  return snapshot;
};

export const resolveDriverCapabilities = (
  definition: Readonly<Driver>,
  receiver: LocalSpaceInstance,
  config: Readonly<LocalSpaceConfig>
): Readonly<LocalSpaceCapabilities> => {
  const declared =
    typeof definition._capabilities === 'function'
      ? definition._capabilities.call(receiver, config)
      : definition._capabilities;
  const overrides = validateDeclaration(declared, definition._driver);
  const capabilities: LocalSpaceCapabilities = {
    transactions: typeof definition.runTransaction === 'function',
    atomicBatch: false,
    dropInstance: typeof definition.dropInstance === 'function',
    persistent: false,
    storageBuckets: false,
    ...overrides,
  };

  assertCompatibleMethods(definition, capabilities);

  return Object.freeze(capabilities);
};
