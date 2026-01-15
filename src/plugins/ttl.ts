import type {
  LocalSpacePlugin,
  PluginContext,
  BatchItems,
  BatchResponse,
} from '../types';
import { normalizeBatchEntries } from '../utils/helpers';

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
  /** Callback invoked when a key expires */
  onExpire?: (key: string, value: unknown) => Promise<void> | void;
}

type TTLMetadata = {
  timer?: ReturnType<typeof setInterval> | null;
  running?: boolean;
};

type TtlPayload<T> = {
  __ls_ttl: true;
  data: T;
  expiresAt: number;
};

const TTL_METADATA_KEY = '__localspace_ttl_metadata';

const isTtlPayload = (value: unknown): value is TtlPayload<unknown> =>
  !!value &&
  typeof value === 'object' &&
  (value as TtlPayload<unknown>).__ls_ttl === true;

const getMetadata = (context: PluginContext): TTLMetadata => {
  const existing = context.metadata[TTL_METADATA_KEY] as
    | TTLMetadata
    | undefined;
  if (existing) {
    return existing;
  }
  const created: TTLMetadata = { timer: null, running: false };
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

const scheduleCleanup = (
  context: PluginContext,
  options: TTLPluginOptions,
  metadata: TTLMetadata
) => {
  if (!options.cleanupInterval || options.cleanupInterval <= 0) {
    return;
  }
  if (metadata.timer) {
    return;
  }
  metadata.timer = setInterval(() => {
    void cleanupExpired(context, options, metadata);
  }, options.cleanupInterval);
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

const cleanupExpired = async (
  context: PluginContext,
  options: TTLPluginOptions,
  metadata: TTLMetadata
): Promise<void> => {
  if (metadata.running) {
    return;
  }
  metadata.running = true;
  const batchSize = options.cleanupBatchSize ?? 100;

  try {
    const keys = await context.instance.keys();
    const batches = chunkArray(keys, batchSize);

    for (const batch of batches) {
      try {
        // Use batch getItems for efficient cleanup.
        // The TTL afterGetItems hook will handle expiration and removal.
        await context.instance.getItems(batch);
      } catch {
        // If batch fails, fall back to individual gets
        for (const key of batch) {
          try {
            await context.instance.getItem(key);
          } catch {
            // Ignore individual key failures during cleanup.
          }
        }
      }
    }
  } finally {
    metadata.running = false;
  }
};

export const ttlPlugin = (
  options: TTLPluginOptions = {}
): LocalSpacePlugin => ({
  name: 'ttl',
  priority: 10,
  onInit: async (context) => {
    const metadata = getMetadata(context);
    scheduleCleanup(context, options, metadata);
  },
  onDestroy: async (context) => {
    const metadata = getMetadata(context);
    if (metadata.timer) {
      clearInterval(metadata.timer);
      metadata.timer = null;
    }
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
    if (!isTtlPayload(value)) {
      return value;
    }

    if (value.expiresAt <= Date.now()) {
      await context.instance.removeItem(key).catch(() => undefined);
      if (options.onExpire) {
        await options.onExpire(key, value.data);
      }
      return null;
    }

    return value.data as T;
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
      if (!isTtlPayload(value)) {
        return { key, value };
      }
      if (value.expiresAt <= now) {
        expiredKeys.push(key);
        expiredEntries.push({ key, value: value.data });
        return { key, value: null };
      }
      return { key, value: value.data as T };
    });

    // Remove expired keys in batch
    if (expiredKeys.length > 0) {
      await context.instance.removeItems(expiredKeys).catch(() => undefined);
      // Call onExpire for each expired entry
      if (options.onExpire) {
        for (const entry of expiredEntries) {
          await options.onExpire(entry.key, entry.value);
        }
      }
    }

    return result;
  },
});

export default ttlPlugin;
