import type {
  LocalSpacePlugin,
  PluginContext,
  BatchItems,
  BatchResponse,
} from '../types.js';
import { normalizeBatchEntries } from '../utils/helpers.js';
import { createLocalSpaceError, toLocalSpaceError } from '../errors.js';
import {
  hasOwnPayloadField,
  readPluginEnvelope,
} from '../core/plugin-envelope.js';
import {
  hasPluginInternalOperation,
  markBuiltInStorageTransformPlugin,
  markPluginBackgroundTaskController,
  TTL_BACKGROUND_CLEANUP_OPERATION,
  type PluginBackgroundTaskPause,
} from '../core/plugin-capabilities.js';

export interface TTLPluginOptions {
  /** Default TTL in milliseconds applied when key-specific TTL is not defined */
  defaultTTL?: number;
  /** Per-key TTL overrides in milliseconds */
  keyTTL?: Record<string, number>;
  /** Optional cleanup interval in milliseconds */
  cleanupInterval?: number;
  /**
   * Batch size for cleanup operations (default: 100).
   * Larger batches are more efficient but may cause longer pauses.
   */
  cleanupBatchSize?: number;
  /**
   * Callback invoked after an expired key is removed. Background-sweep
   * callbacks are notifications and are not part of the close/destroy barrier.
   */
  onExpire?: (key: string, value: unknown) => Promise<void> | void;
}

type TTLMetadata = {
  timer?: ReturnType<typeof setInterval> | null;
  cleanupPromise?: Promise<void> | null;
  paused?: boolean;
  stopped?: boolean;
};

type TtlPayloadBody<T> = {
  data: T;
  expiresAt: number;
};

type TtlPayload<T> = TtlPayloadBody<T> & {
  __ls_ttl: true;
};

const TTL_METADATA_KEY = '__localspace_ttl_metadata';

const invalidTtlPayload = () =>
  createLocalSpaceError(
    'DESERIALIZATION_FAILED',
    'Failed to read TTL payload: invalid TTL payload.'
  );

const validateVersionedTtlPayload = (
  value: unknown
): TtlPayloadBody<unknown> => {
  const payload = value as Partial<TtlPayloadBody<unknown>>;
  if (
    !payload ||
    typeof payload !== 'object' ||
    !hasOwnPayloadField(payload, 'data') ||
    typeof payload.expiresAt !== 'number' ||
    !Number.isFinite(payload.expiresAt)
  ) {
    throw invalidTtlPayload();
  }
  return payload as TtlPayloadBody<unknown>;
};

const validateLegacyTtlPayload = (value: unknown): TtlPayloadBody<unknown> => {
  const payload = value as Partial<TtlPayloadBody<unknown>>;
  if (
    !payload ||
    typeof payload !== 'object' ||
    !hasOwnPayloadField(payload, 'expiresAt') ||
    typeof payload.expiresAt !== 'number' ||
    (!Number.isFinite(payload.expiresAt) &&
      payload.expiresAt !== Number.POSITIVE_INFINITY)
  ) {
    throw invalidTtlPayload();
  }

  // JSON serialization omits an own `data: undefined` field. Legacy 2.x
  // readers treated that representation as a valid TTL-wrapped undefined.
  return {
    data: payload.data,
    expiresAt: payload.expiresAt,
  };
};

const parseTtlPayload = (value: unknown): TtlPayloadBody<unknown> | null => {
  const envelope = readPluginEnvelope<unknown>(value, 'ttl');
  if (envelope.matched) {
    return validateVersionedTtlPayload(envelope.payload);
  }

  if (
    !value ||
    typeof value !== 'object' ||
    (value as Partial<TtlPayload<unknown>>).__ls_ttl !== true
  ) {
    return null;
  }

  const hasLegacyPayloadFields = ['data', 'expiresAt'].some((field) =>
    hasOwnPayloadField(value, field)
  );
  if (!hasLegacyPayloadFields) {
    return null;
  }

  return validateLegacyTtlPayload(value);
};

const unwrapTtlData = <T>(payload: TtlPayloadBody<unknown>): T | null =>
  (typeof payload.data === 'undefined' ? null : payload.data) as T | null;

const getMetadata = (context: PluginContext): TTLMetadata => {
  const existing = context.metadata[TTL_METADATA_KEY] as
    | TTLMetadata
    | undefined;
  if (existing) {
    return existing;
  }
  const created: TTLMetadata = {
    timer: null,
    cleanupPromise: null,
    paused: false,
    stopped: false,
  };
  context.metadata[TTL_METADATA_KEY] = created;
  return created;
};

const resolveTtl = (
  key: string,
  options: TTLPluginOptions
): number | undefined => {
  if (options.keyTTL && typeof options.keyTTL[key] === 'number') {
    return options.keyTTL[key];
  }
  return options.defaultTTL;
};

const notifyExpired = async (
  key: string,
  value: unknown,
  context: PluginContext,
  options: TTLPluginOptions
): Promise<void> => {
  if (!options.onExpire) {
    return;
  }

  try {
    await options.onExpire(key, value);
  } catch (error) {
    const wrapped = toLocalSpaceError(
      error,
      'OPERATION_FAILED',
      `TTL onExpire callback failed for key "${key}"`,
      { key, operation: 'ttl.onExpire' }
    );

    if (context.config.pluginErrorPolicy === 'strict') {
      throw wrapped;
    }

    console.warn(
      `[localspace] TTL onExpire callback failed for key "${key}"`,
      wrapped
    );
  }
};

const notifyExpiredInBackground = (
  key: string,
  value: unknown,
  context: PluginContext,
  options: TTLPluginOptions
): void => {
  // A periodic sweep has no caller to receive notification failures. More
  // importantly, keeping the sweep dependent on user code would deadlock when
  // onExpire awaits close() or destroy() on this same instance.
  void notifyExpired(key, value, context, options).catch(() => undefined);
};

const scheduleCleanup = (
  context: PluginContext,
  options: TTLPluginOptions,
  metadata: TTLMetadata
) => {
  if (metadata.paused || metadata.stopped) {
    return;
  }
  if (!options.cleanupInterval || options.cleanupInterval <= 0) {
    return;
  }
  if (metadata.timer) {
    return;
  }
  metadata.timer = setInterval(() => {
    if (!metadata.paused && !metadata.stopped) {
      void cleanupExpired(context, options, metadata);
    }
  }, options.cleanupInterval);
};

const stopCleanupTimer = (metadata: TTLMetadata): boolean => {
  if (!metadata.timer) {
    return false;
  }
  clearInterval(metadata.timer);
  metadata.timer = null;
  return true;
};

const pauseCleanup = (
  context: PluginContext,
  options: TTLPluginOptions
): PluginBackgroundTaskPause => {
  const metadata = getMetadata(context);
  metadata.paused = true;
  const shouldResume = stopCleanupTimer(metadata);
  const cleanupPromise = metadata.cleanupPromise;
  let resumed = false;

  return {
    pending: cleanupPromise !== null && cleanupPromise !== undefined,
    settled: cleanupPromise?.catch(() => undefined) ?? Promise.resolve(),
    resume: () => {
      if (resumed) {
        return;
      }
      resumed = true;
      if (metadata.stopped) {
        return;
      }
      metadata.paused = false;
      if (shouldResume) {
        scheduleCleanup(context, options, metadata);
      }
    },
  };
};

/**
 * Chunk an array into batches of a given size.
 */
const chunkArray = <T>(arr: T[], size: number): T[][] => {
  if (size <= 0 || arr.length === 0) return [arr];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

const cleanupExpired = (
  context: PluginContext,
  options: TTLPluginOptions,
  metadata: TTLMetadata
): Promise<void> => {
  if (metadata.cleanupPromise) {
    return metadata.cleanupPromise;
  }
  const cleanupPromise = (async () => {
    const batchSize = options.cleanupBatchSize ?? 100;
    const keys = await context.instance.keys();
    const batches = chunkArray(keys, batchSize);

    for (const batch of batches) {
      try {
        // Use batch getItems for efficient cleanup.
        // The TTL afterGetItems hook will handle expiration and removal.
        await (
          context.instance.getItems as <T>(
            keys: string[],
            internalOperation: typeof TTL_BACKGROUND_CLEANUP_OPERATION
          ) => Promise<BatchResponse<T>>
        )(batch, TTL_BACKGROUND_CLEANUP_OPERATION);
      } catch {
        // If batch fails, fall back to individual gets
        for (const key of batch) {
          try {
            await (
              context.instance.getItem as <T>(
                itemKey: string,
                internalOperation: typeof TTL_BACKGROUND_CLEANUP_OPERATION
              ) => Promise<T | null>
            )(key, TTL_BACKGROUND_CLEANUP_OPERATION);
          } catch {
            // Ignore individual key failures during cleanup.
          }
        }
      }
    }
  })();

  metadata.cleanupPromise = cleanupPromise;
  void cleanupPromise
    .catch(() => undefined)
    .finally(() => {
      if (metadata.cleanupPromise === cleanupPromise) {
        metadata.cleanupPromise = null;
      }
    });
  return cleanupPromise;
};

const createTtlPlugin = (options: TTLPluginOptions = {}): LocalSpacePlugin => ({
  name: 'ttl',
  priority: 10,
  onInit: async (context) => {
    const metadata = getMetadata(context);
    metadata.stopped = false;
    metadata.paused = false;
    scheduleCleanup(context, options, metadata);
  },
  onDestroy: async (context) => {
    const metadata = getMetadata(context);
    metadata.stopped = true;
    metadata.paused = true;
    stopCleanupTimer(metadata);
    await metadata.cleanupPromise?.catch(() => undefined);
  },
  beforeSet: async <T>(
    key: string,
    value: T,
    context: PluginContext
  ): Promise<T> => {
    // Skip if already processed by batch hook
    if (context.operationState.isBatch) {
      return value;
    }
    const ttlMs = resolveTtl(key, options);
    if (!ttlMs || ttlMs <= 0) {
      return value;
    }
    return {
      __ls_ttl: true,
      data: value,
      expiresAt: Date.now() + ttlMs,
    } as unknown as T;
  },
  afterGet: async <T>(
    key: string,
    value: T | null,
    context: PluginContext
  ): Promise<T | null> => {
    // Skip if already processed by batch hook
    if (context.operationState.isBatch) {
      return value;
    }
    const payload = parseTtlPayload(value);
    if (!payload) {
      return value;
    }

    if (payload.expiresAt <= Date.now()) {
      const removed = await context.instance.removeItem(key).then(
        () => true,
        () => false
      );
      if (removed) {
        if (
          hasPluginInternalOperation(context, TTL_BACKGROUND_CLEANUP_OPERATION)
        ) {
          notifyExpiredInBackground(key, payload.data, context, options);
        } else {
          await notifyExpired(key, payload.data, context, options);
        }
      }
      return null;
    }

    return unwrapTtlData<T>(payload);
  },
  beforeSetItems: async <T>(
    entries: BatchItems<T>,
    _context: PluginContext
  ): Promise<BatchItems<T>> => {
    const normalized = normalizeBatchEntries(entries);
    const now = Date.now();
    const wrapped = normalized.map(({ key, value }) => {
      const ttlMs = resolveTtl(key, options);
      if (!ttlMs || ttlMs <= 0) {
        return { key, value };
      }
      return {
        key,
        value: {
          __ls_ttl: true,
          data: value,
          expiresAt: now + ttlMs,
        } as unknown as T,
      };
    });
    return wrapped;
  },
  afterGetItems: async <T>(
    entries: BatchResponse<T>,
    context: PluginContext
  ): Promise<BatchResponse<T>> => {
    const now = Date.now();
    const expiredKeys: string[] = [];
    const expiredEntries: Array<{ key: string; value: unknown }> = [];

    const result = entries.map(({ key, value }) => {
      const payload = parseTtlPayload(value);
      if (!payload) {
        return { key, value };
      }
      if (payload.expiresAt <= now) {
        expiredKeys.push(key);
        expiredEntries.push({ key, value: payload.data });
        return { key, value: null };
      }
      return { key, value: unwrapTtlData<T>(payload) };
    });

    // Remove expired keys in batch
    if (expiredKeys.length > 0) {
      const removed = await context.instance.removeItems(expiredKeys).then(
        () => true,
        () => false
      );
      if (removed) {
        // Notify only after every expired key has been removed.
        for (const entry of expiredEntries) {
          if (
            hasPluginInternalOperation(
              context,
              TTL_BACKGROUND_CLEANUP_OPERATION
            )
          ) {
            notifyExpiredInBackground(entry.key, entry.value, context, options);
          } else {
            await notifyExpired(entry.key, entry.value, context, options);
          }
        }
      }
    }

    return result;
  },
});

export const ttlPlugin = (options: TTLPluginOptions = {}): LocalSpacePlugin => {
  const plugin = markPluginBackgroundTaskController(
    createTtlPlugin(options),
    (context) => pauseCleanup(context, options)
  );
  return markBuiltInStorageTransformPlugin(plugin, 'ttl');
};

export default ttlPlugin;
