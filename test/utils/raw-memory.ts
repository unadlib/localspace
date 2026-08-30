import { memoryDriver, type LocalSpaceConfig } from '../../src';

type RawMemoryReceiver = {
  _config: LocalSpaceConfig;
  _defaultConfig: LocalSpaceConfig;
  _dbInfo?: unknown;
  ready(): Promise<void>;
  config(): LocalSpaceConfig;
};

const createReceiver = async (
  config: LocalSpaceConfig
): Promise<RawMemoryReceiver> => {
  const receiver: RawMemoryReceiver = {
    _config: config,
    _defaultConfig: config,
    ready: async () => undefined,
    config: () => config,
  };
  await memoryDriver._initStorage.call(receiver as never, config);
  return receiver;
};

/** Bypass the 3.0 facade writer to seed a physical 2.x compatibility value. */
export const setRawMemoryValue = async (
  config: LocalSpaceConfig,
  key: string,
  value: unknown
): Promise<void> => {
  const receiver = await createReceiver(config);
  await memoryDriver.setItem.call(receiver as never, key, value as never);
};

/** Inspect the physical Memory-driver value without decoding core records. */
export const getRawMemoryValue = async (
  config: LocalSpaceConfig,
  key: string
): Promise<unknown> => {
  const receiver = await createReceiver(config);
  return memoryDriver.getItem.call(receiver as never, key);
};

export const setRawMemoryItems = async (
  config: LocalSpaceConfig,
  entries: Array<{ key: string; value: unknown }>
): Promise<void> => {
  const receiver = await createReceiver(config);
  await memoryDriver.setItems!.call(receiver as never, entries as never);
};
