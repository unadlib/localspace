import localspace, {
  LocalSpace,
  compressionPlugin,
  encryptionPlugin,
  legacyEncryptionMigrationPlugin,
  memoryDriver,
  registerDriver,
  setDeprecationWarnings,
  type BatchItems,
  type CompressionCodec,
  type Driver,
  type DriverCapabilities,
  type EncryptionAlgorithm,
  type EncryptionPluginOptions,
  type LegacyEncryptionMigrationOptions,
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
  type ReactNativeAsyncStorage,
  type ReactNativeInstanceOptions,
} from 'localspace/react-native';

const instance: LocalSpaceInstance = new LocalSpace();
const items: BatchItems<number> = [{ key: 'count', value: 1 }];
const mode: TransactionMode = 'readwrite';
const asyncStorage: ReactNativeAsyncStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
  getAllKeys: async () => [],
};
const options: ReactNativeInstanceOptions = {
  reactNativeAsyncStorage: asyncStorage,
};
const localOptions: LocalSpaceOptions = { drivers: [memoryDriver] };
const declaredCapabilities: DriverCapabilities = { persistent: false };
const selectedCapabilities: LocalSpaceCapabilities = instance.capabilities();
const configSnapshot: LocalSpaceConfigSnapshot = instance.config();
const migrationValue: StorageValue = {
  binary: new Uint8Array([1, 2, 3]),
  nested: [null, true, 1, 'value'],
};
const compressionCodec: CompressionCodec = {
  compress: async (bytes) => bytes.slice(),
  decompress: async (bytes) => bytes.slice(),
};
const compression = compressionPlugin({
  threshold: 256,
  codec: compressionCodec,
  algorithm: 'package-types-codec-v1',
});
const encryptionAlgorithm: EncryptionAlgorithm = {
  name: 'AES-GCM',
  tagLength: 128,
};
const encryptionOptions: EncryptionPluginOptions = {
  key: '0123456789abcdef0123456789abcdef',
  algorithm: encryptionAlgorithm,
};
const encryption = encryptionPlugin(encryptionOptions);
const legacyEncryptionOptions: LegacyEncryptionMigrationOptions = {
  key: '0123456789abcdef0123456789abcdef',
  algorithm: { name: 'AES-CBC' },
};
const legacyEncryption = legacyEncryptionMigrationPlugin(
  legacyEncryptionOptions
);
void instance.setItem('migration', migrationValue);
void instance.setItems([{ key: 'migration', value: migrationValue }]);
void instance.getItem<StorageValue>('migration');
void instance.getItems<StorageValue>(['migration']);
const iterateResult: Promise<string | undefined> = instance.iterate<
  StorageValue,
  string
>(async () => 'done');
const driverDefinition = instance.getDriver('package-types-esm');
void driverDefinition.then((definition) => {
  // @ts-expect-error registered definitions are exposed as readonly snapshots
  definition._driver = 'changed';
});
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
// @ts-expect-error a raw driver iteration can finish without a callback result
const narrowDriverIteration: Promise<string> = customDriver.iterate<
  StorageValue,
  string
>(() => 'done');
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
  // @ts-expect-error getAllKeys is required by the complete RN facade contract
  const incompleteAsyncStorage: ReactNativeAsyncStorage = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  };
  void incompleteAsyncStorage;
  // @ts-expect-error strictValues was a 2.1 migration-only option
  const strictOptions: LocalSpaceOptions = { strictValues: true };
  const strictTransactionOptions: LocalSpaceOptions = {
    // @ts-expect-error strictTransactions was a 2.1 migration-only option
    strictTransactions: true,
  };
  // @ts-expect-error Date is outside the 3.0 StorageValue contract
  void instance.setItem('date', new Date());
  // @ts-expect-error undefined is outside the 3.0 StorageValue contract
  void instance.setItem('undefined', undefined);
  // @ts-expect-error Map is outside the 3.0 StorageValue contract
  void instance.setItems([{ key: 'map', value: new Map() }]);
  // @ts-expect-error reads cannot promise values outside StorageValue
  void instance.getItem<Date>('date');
  const legacyAlgorithm: EncryptionPluginOptions = {
    key: '0123456789abcdef0123456789abcdef',
    // @ts-expect-error AES-CBC was removed from normal encryption configuration
    algorithm: { name: 'AES-CBC', iv: new Uint8Array(16) },
  };
  const callerOwnedIv: EncryptionPluginOptions = {
    key: '0123456789abcdef0123456789abcdef',
    algorithm: {
      name: 'AES-GCM',
      // @ts-expect-error encryptionPlugin generates a fresh IV for every write
      iv: new Uint8Array(12),
    },
  };
  // @ts-expect-error encryption requires exactly one key source
  const missingKeySource: EncryptionPluginOptions = {};
  // @ts-expect-error key and keyDerivation are mutually exclusive
  const ambiguousKeySource: EncryptionPluginOptions = {
    key: '0123456789abcdef0123456789abcdef',
    keyDerivation: {
      passphrase: 'passphrase',
      salt: '0123456789abcdef',
    },
  };
  void instance.runTransaction('readwrite', (transaction) => {
    // @ts-expect-error transaction writes use the same StorageValue contract
    return transaction.set('date', new Date());
  });
  void strictOptions;
  void strictTransactionOptions;
  void legacyAlgorithm;
  void callerOwnedIv;
  void missingKeySource;
  void ambiguousKeySource;
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
  compressionCodec,
  compression,
  encryptionAlgorithm,
  encryptionOptions,
  encryption,
  legacyEncryptionOptions,
  legacyEncryption,
  iterateResult,
  driverDefinition,
  observerPlugin,
  customDriver,
  narrowDriverIteration,
  typecheckDirectLifecycleCalls,
  typecheckRemovedApis,
  createReactNativeInstance,
  setDeprecationWarnings,
  registerDriver,
];
