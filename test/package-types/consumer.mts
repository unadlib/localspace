import localspace, {
  LocalSpace,
  memoryDriver,
  registerDriver,
  setDeprecationWarnings,
  type BatchItems,
  type Driver,
  type DriverCapabilities,
  type LocalSpaceConfig,
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
const legacySizeResult = instance.config({ size: 4_980_736 });
const legacySize: number | undefined = instance.config('size');
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
  legacySizeResult,
  legacySize,
  migrationValue,
  customDriver,
  typecheckDirectLifecycleCalls,
  createReactNativeInstance,
  setDeprecationWarnings,
  registerDriver,
];
