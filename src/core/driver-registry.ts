import { createLocalSpaceError } from '../errors.js';
import type { Driver, DriverRegistrationOptions } from '../types.js';
import {
  OPTIONAL_DRIVER_OPERATIONS,
  REQUIRED_DRIVER_OPERATIONS,
} from './driver-contract.js';
import { snapshotCapabilityDeclaration } from './driver-capabilities.js';

const REQUIRED_DRIVER_METHODS = [
  '_initStorage',
  ...REQUIRED_DRIVER_OPERATIONS,
] as const;
const OPTIONAL_DRIVER_METHODS = [
  '_closeStorage',
  ...OPTIONAL_DRIVER_OPERATIONS,
] as const;

type DriverEntry = {
  definition: Readonly<Driver>;
  supported: boolean | undefined;
  supportPromise: Promise<boolean>;
};

const complianceError = (driver: unknown, reason: string) =>
  createLocalSpaceError('DRIVER_COMPLIANCE', 'Custom driver not compliant', {
    driver: typeof driver === 'string' ? driver : undefined,
    reason,
  });

const cloneDriverDefinition = (driver: Driver): Readonly<Driver> => {
  if (!driver || typeof driver !== 'object') {
    throw complianceError(undefined, 'definition must be an object');
  }

  const prototypeChain: object[] = [];
  for (
    let current: object | null = driver;
    current && current !== Object.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    prototypeChain.unshift(current);
  }

  // Flatten the visible definition surface so later writes to a class or
  // object-literal prototype cannot change an already registered driver.
  // Build the final descriptor map before defining properties so a derived
  // non-configurable member can still shadow a base member in the snapshot.
  const descriptors = Object.create(null) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  for (const current of prototypeChain) {
    const currentDescriptors = Object.getOwnPropertyDescriptors(current);
    for (const property of Reflect.ownKeys(currentDescriptors)) {
      Object.defineProperty(descriptors, property, {
        configurable: true,
        enumerable: true,
        value: currentDescriptors[property as keyof typeof currentDescriptors],
        writable: true,
      });
    }
  }

  const nameDescriptor = descriptors._driver;
  if (
    !nameDescriptor ||
    !('value' in nameDescriptor) ||
    typeof nameDescriptor.value !== 'string' ||
    nameDescriptor.value.length === 0 ||
    !Object.prototype.hasOwnProperty.call(driver, '_driver')
  ) {
    throw complianceError(
      undefined,
      '_driver must be an own string data property'
    );
  }
  const name = nameDescriptor.value;

  for (const property of Reflect.ownKeys(descriptors)) {
    if (!('value' in descriptors[property])) {
      throw complianceError(
        name,
        `member ${String(property)} must be a data property`
      );
    }
  }
  for (const method of REQUIRED_DRIVER_METHODS) {
    if (typeof descriptors[method]?.value !== 'function') {
      throw complianceError(name, `missing required method ${method}`);
    }
  }
  for (const method of OPTIONAL_DRIVER_METHODS) {
    const implementation = descriptors[method]?.value;
    if (implementation !== undefined && typeof implementation !== 'function') {
      throw complianceError(
        name,
        `optional member ${method} must be a function`
      );
    }
  }
  const support = descriptors._support?.value;
  if (
    support !== undefined &&
    typeof support !== 'boolean' &&
    typeof support !== 'function'
  ) {
    throw complianceError(name, '_support must be a boolean or function');
  }

  let snapshot = Object.create(null, descriptors) as Driver;
  const capabilityDeclaration = snapshotCapabilityDeclaration(snapshot);
  if (capabilityDeclaration !== undefined) {
    descriptors._capabilities = {
      configurable: true,
      enumerable: descriptors._capabilities?.enumerable ?? true,
      value: capabilityDeclaration,
      writable: true,
    };
    snapshot = Object.create(null, descriptors) as Driver;
  }
  return Object.freeze(snapshot);
};

export class DriverRegistry {
  private readonly entries = new Map<string, DriverEntry>();

  constructor(private readonly parent?: DriverRegistry) {}

  register(
    driver: Driver,
    options: DriverRegistrationOptions = {}
  ): Promise<void> {
    const definition = cloneDriverDefinition(driver);
    const name = definition._driver;
    const previousEntry = this.entries.get(name);
    if (previousEntry && options.overwrite !== true) {
      throw createLocalSpaceError(
        'DRIVER_COMPLIANCE',
        `Driver "${name}" is already registered in this scope.`,
        { driver: name, reason: 'duplicate-driver' }
      );
    }

    const entry: DriverEntry = {
      definition,
      supported: undefined,
      supportPromise: Promise.resolve(false),
    };
    this.entries.set(name, entry);
    const restorePreviousEntry = () => {
      if (this.entries.get(name) !== entry) return;
      if (previousEntry) {
        this.entries.set(name, previousEntry);
      } else {
        this.entries.delete(name);
      }
    };

    const support = definition._support;
    if (typeof support === 'boolean' || support === undefined) {
      entry.supported = support ?? true;
      entry.supportPromise = Promise.resolve(entry.supported);
      return Promise.resolve();
    }

    let supportResult: boolean | Promise<boolean>;
    try {
      supportResult = support.call(definition);
    } catch (error) {
      restorePreviousEntry();
      return Promise.reject(error);
    }

    if (
      !supportResult ||
      typeof (supportResult as Promise<boolean>).then !== 'function'
    ) {
      entry.supported = !!supportResult;
      entry.supportPromise = Promise.resolve(entry.supported);
      return Promise.resolve();
    }

    entry.supportPromise = Promise.resolve(supportResult)
      .then((result) => {
        entry.supported = !!result;
        return entry.supported;
      })
      .catch((error) => {
        restorePreviousEntry();
        throw error;
      });
    return entry.supportPromise.then(() => undefined);
  }

  hasOwn(name: string): boolean {
    return this.entries.has(name);
  }

  has(name: string): boolean {
    return this.entries.has(name) || this.parent?.has(name) === true;
  }

  get(name: string): Readonly<Driver> | undefined {
    return this.entries.get(name)?.definition ?? this.parent?.get(name);
  }

  supports(name: string): boolean {
    const entry = this.entries.get(name);
    return entry
      ? entry.supported === true
      : this.parent?.supports(name) === true;
  }

  async resolveSupport(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry) return entry.supportPromise;
    return this.parent?.resolveSupport(name) ?? false;
  }
}

export const globalDriverRegistry = new DriverRegistry();

export const registerDriver = async (
  driver: Driver,
  options?: DriverRegistrationOptions
): Promise<void> => {
  await globalDriverRegistry.register(driver, options);
};

export const registerBuiltInDriver = (driver: Driver): Promise<void> =>
  globalDriverRegistry.register(driver, { overwrite: true });
