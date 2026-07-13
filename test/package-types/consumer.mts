import localspace, {
  LocalSpace,
  setDeprecationWarnings,
  type BatchItems,
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
setDeprecationWarnings(false);

void [
  localspace,
  instance,
  items,
  mode,
  options,
  legacySizeResult,
  legacySize,
  createReactNativeInstance,
  setDeprecationWarnings,
];
