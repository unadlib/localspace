import localspace, {
  LocalSpace,
  memoryDriver,
  setDeprecationWarnings,
  type BatchItems,
  type Driver,
  type LocalSpaceConfig,
  type LocalSpaceInstance,
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
const legacySizeResult = instance.config({ size: 4_980_736 });
const legacySize: number | undefined = instance.config('size');
const customDriver: Driver = {
  ...memoryDriver,
  _driver: 'package-types-esm',
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

void [
  localspace,
  instance,
  items,
  mode,
  options,
  legacySizeResult,
  legacySize,
  customDriver,
  typecheckDirectLifecycleCalls,
  createReactNativeInstance,
  setDeprecationWarnings,
];
