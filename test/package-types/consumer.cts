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
  type LocalSpacePlugin,
  type PluginIterateSummary,
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
void instance.setItem('migration', migrationValue);
void instance.setItems([{ key: 'migration', value: migrationValue }]);
void instance.getItem<StorageValue>('migration');
void instance.getItems<StorageValue>(['migration']);
const iterateResult: Promise<string | undefined> = instance.iterate<
  StorageValue,
  string
>(async () => 'done');
const observerPlugin: LocalSpacePlugin = {
  name: 'package-types-observer',
  afterIterate(summary: Readonly<PluginIterateSummary>) {
    void summary.iterations;
  },
  afterKeys(keys) {
    void keys.length;
  },
  afterKey(index, key) {
    void [index, key];
  },
  afterLength(length) {
    void length;
  },
  afterClear() {},
  afterDropInstance(options) {
    void options?.name;
  },
};
void instance.runTransaction('readwrite', async (transaction) => {
  await transaction.set('migration', migrationValue);
  await transaction.get<StorageValue>('migration');
  await transaction.iterate<StorageValue>(() => undefined);
});
const customDriver: Driver = {
  ...memoryDriver,
  _driver: 'package-types-cjs',
  _capabilities: declaredCapabilities,
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
  // @ts-expect-error strictValues was a 2.1 migration-only option
  const strictOptions: LocalSpaceOptions = { strictValues: true };
  // @ts-expect-error Date is outside the 3.0 StorageValue contract
  void instance.setItem('date', new Date());
  // @ts-expect-error undefined is outside the 3.0 StorageValue contract
  void instance.setItem('undefined', undefined);
  // @ts-expect-error Map is outside the 3.0 StorageValue contract
  void instance.setItems([{ key: 'map', value: new Map() }]);
  // @ts-expect-error reads cannot promise values outside StorageValue
  void instance.getItem<Date>('date');
  void instance.runTransaction('readwrite', (transaction) => {
    // @ts-expect-error transaction writes use the same StorageValue contract
    return transaction.set('date', new Date());
  });
  void strictOptions;
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
  iterateResult,
  observerPlugin,
  customDriver,
  typecheckDirectLifecycleCalls,
  typecheckRemovedApis,
  createReactNativeInstance,
  setDeprecationWarnings,
  registerDriver,
];
