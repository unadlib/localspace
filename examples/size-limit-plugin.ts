import {
  PluginAbortError,
  serializer,
  type BatchItems,
  type LocalSpacePlugin,
  type PluginContext,
} from '../src';

export interface SizeLimitExceededInfo {
  keys: string[];
  currentBytes: number;
  attemptedBytes: number;
  projectedBytes: number;
  maxBytes: number;
}

export interface SizeLimitPluginOptions {
  maxBytes: number;
  onLimitExceeded?: (info: SizeLimitExceededInfo) => Promise<void> | void;
}

export class SizeLimitExceededError extends PluginAbortError {
  readonly info: SizeLimitExceededInfo;

  constructor(info: SizeLimitExceededInfo) {
    super(
      `Application storage size limit exceeded: ${info.projectedBytes}/${info.maxBytes} bytes`
    );
    this.name = 'SizeLimitExceededError';
    this.info = info;
  }
}

export class SizeLimitMeasurementError extends PluginAbortError {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Application storage size could not be measured');
    this.name = 'SizeLimitMeasurementError';
    this.cause = cause;
  }
}

const encoder = new TextEncoder();

const measureValue = async (value: unknown): Promise<number> => {
  try {
    return encoder.encode(await serializer.serialize(value)).byteLength;
  } catch (error) {
    throw new SizeLimitMeasurementError(error);
  }
};

const normalizeEntries = <T>(entries: BatchItems<T>): Map<string, T> => {
  if (Array.isArray(entries)) {
    return new Map(entries.map(({ key, value }) => [String(key), value]));
  }
  if (entries instanceof Map) {
    return new Map(
      [...entries].map(([key, value]) => [String(key), value] as const)
    );
  }
  return new Map(Object.entries(entries) as Array<[string, T]>);
};

const readCurrentValues = async (
  context: PluginContext
): Promise<Map<string, unknown>> => {
  const values = new Map<string, unknown>();
  await context.instance.iterate<unknown, void>((value, key) => {
    values.set(key, value);
  });
  return values;
};

const measureValues = async (values: Map<string, unknown>): Promise<number> => {
  let total = 0;
  for (const value of values.values()) {
    total += await measureValue(value);
  }
  return total;
};

/**
 * Example only: rejects writes whose serialized values exceed an application
 * limit. This is a best-effort policy, not browser quota management. The scan
 * and write are not atomic, so concurrent writers can exceed the limit.
 */
export const sizeLimitPlugin = (
  options: SizeLimitPluginOptions
): LocalSpacePlugin => {
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError('maxBytes must be a finite non-negative number');
  }

  const assertWithinLimit = async (
    proposed: Map<string, unknown>,
    context: PluginContext
  ): Promise<void> => {
    const current = await readCurrentValues(context);
    const currentBytes = await measureValues(current);
    let attemptedBytes = 0;

    for (const [key, value] of proposed) {
      attemptedBytes += await measureValue(value);
      current.set(key, value);
    }

    const projectedBytes = await measureValues(current);
    if (projectedBytes <= options.maxBytes) {
      return;
    }

    const info: SizeLimitExceededInfo = {
      keys: [...proposed.keys()],
      currentBytes,
      attemptedBytes,
      projectedBytes,
      maxBytes: options.maxBytes,
    };
    try {
      await options.onLimitExceeded?.(info);
    } catch (error) {
      console.error(
        '[localspace example] size limit notification handler failed',
        error
      );
    }
    throw new SizeLimitExceededError(info);
  };

  return {
    name: 'size-limit-example',
    priority: -10,
    beforeSet: async (key, value, context) => {
      if (!context.operationState.isBatch) {
        await assertWithinLimit(new Map([[key, value]]), context);
      }
      return value;
    },
    beforeSetItems: async (entries, context) => {
      await assertWithinLimit(normalizeEntries(entries), context);
      return entries;
    },
  };
};
