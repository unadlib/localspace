import localspace, {
  LocalSpace,
  memoryDriver,
  registerDriver,
  setDeprecationWarnings,
  type BatchItems,
  type Driver,
  type LocalSpaceConfig,
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
const legacySizeResult = instance.config({ size: 4_980_736 });
const legacySize: number | undefined = instance.config('size');
const migrationValue: StorageValue = {
  binary: new Uint8Array([1, 2, 3]),
  nested: [null, true, 1, 'value'],
};
const customDriver: Driver = {
  ...memoryDriver,
  _driver: 'package-types-cjs',
  async _initStorage() {
    const lifecycleInstance: LocalSpaceInstance = this;
    void lifecycleInstance.close;
  },
  async _closeStorage() {
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
  legacySizeResult,
  legacySize,
  migrationValue,
  customDriver,
  typecheckDirectLifecycleCalls,
  createReactNativeInstance,
  setDeprecationWarnings,
  registerDriver,
];
