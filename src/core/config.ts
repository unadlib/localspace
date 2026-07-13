import type { LocalSpaceConfig } from '../types.js';
import { createLocalSpaceError } from '../errors.js';

const POSITIVE_INTEGER_OPTIONS = [
  'version',
  'maxBatchSize',
  'connectionIdleMs',
  'maxConcurrentTransactions',
] as const satisfies ReadonlyArray<keyof LocalSpaceConfig>;

const validatePositiveInteger = (
  key: (typeof POSITIVE_INTEGER_OPTIONS)[number],
  value: unknown
): void => {
  if (key === 'version' && typeof value !== 'number') {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Database version must be a number.',
      { configKey: key, providedType: typeof value }
    );
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      `Configuration option "${key}" must be a positive integer.`,
      {
        configKey: key,
        providedType: typeof value,
        providedValue: value,
      }
    );
  }
};

export function normalizeConfigOptions(
  options: Partial<LocalSpaceConfig>
): Partial<LocalSpaceConfig> {
  const normalized: Partial<LocalSpaceConfig> = { ...options };

  for (const key of POSITIVE_INTEGER_OPTIONS) {
    const value = options[key];
    if (value !== undefined) {
      validatePositiveInteger(key, value);
    }
  }

  if (
    options.name !== undefined &&
    (typeof options.name !== 'string' || options.name.length === 0)
  ) {
    throw createLocalSpaceError(
      'INVALID_CONFIG',
      'Database name must be a non-empty string.',
      { configKey: 'name', providedType: typeof options.name }
    );
  }

  if (options.storeName !== undefined) {
    if (
      typeof options.storeName !== 'string' ||
      options.storeName.length === 0
    ) {
      throw createLocalSpaceError(
        'INVALID_CONFIG',
        'Store name must be a non-empty string.',
        { configKey: 'storeName', providedType: typeof options.storeName }
      );
    }
    normalized.storeName = options.storeName;
  }

  if (Array.isArray(options.driver)) {
    normalized.driver = [...options.driver];
  }

  return normalized;
}
