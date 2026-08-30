import localspace, {
  LocalSpace,
  memoryDriver,
  registerDriver,
  setDeprecationWarnings,
  type BatchItems,
  type Driver,
  type DriverCapabilities,
  type LocalSpaceConfig,
  type LocalSpaceConfigSnapshot,
  type LocalSpaceCapabilities,
  type LocalSpaceInstance,
  type LocalSpaceOptions,
  type StorageValue,
  type TransactionMode,
} from 'localspace';
import {
  createReactNativeInstance,
  type ReactNativeInstanceOptions,
} from 'localspace/react-native';

const instance: LocalSpaceInstance = new LocalSpace();
const items: BatchItems<number> = [{ key: 'count', value: 1 }];
const mode: TransactionMode = 'readwrite';
const options = {} as ReactNativeInstanceOptions;
const localOptions: LocalSpaceOptions = { drivers: [memoryDriver] };
const declaredCapabilities: DriverCapabilities = { persistent: false };
const selectedCapabilities: LocalSpaceCapabilities = instance.capabilities();
const configSnapshot: LocalSpaceConfigSnapshot = instance.config();
const migrationValue: StorageValue = {
  binary: new Uint8Array([1, 2, 3]),
  nested: [null, true, 1, 'value'],
};
const customDriver: Driver = {
  ...memoryDriver,
  _driver: 'package-types-esm',
  _capabilities: declaredCapabilities,
  _initStorage: async function () {
    const lifecycleInstance: LocalSpaceInstance = this;
    void lifecycleInstance.close;
  },
  _closeStorage: async function () {
    const lifecycleInstance: LocalSpaceInstance = this;
    void lifecycleInstance.getItem;
  },
};
const typecheckDirectLifecycleCalls = (
  driver: Driver,
  config: LocalSpaceConfig
): void => {
  void driver._initStorage(config);
  void driver._closeStorage?.();
};
const typecheckRemovedApis = (): void => {
  // @ts-expect-error config(options) was removed in 3.0
  instance.config({ name: 'changed' });
  // @ts-expect-error instance driver registration was removed in 3.0
  instance.defineDriver(customDriver);
  // @ts-expect-error destroy() was removed in 3.0
  instance.destroy();
  // @ts-expect-error config snapshots are readonly
  configSnapshot.name = 'changed';
  // @ts-expect-error mutable internal config is not public
  instance._config.name = 'changed';
};
setDeprecationWarnings(false);
void registerDriver(customDriver, { overwrite: true });

void [
  localspace,
  instance,
  items,
  mode,
  options,
  localOptions,
  declaredCapabilities,
  selectedCapabilities,
  configSnapshot,
  migrationValue,
  customDriver,
  typecheckDirectLifecycleCalls,
  typecheckRemovedApis,
  createReactNativeInstance,
  setDeprecationWarnings,
  registerDriver,
];
