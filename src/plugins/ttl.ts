import type { LocalSpacePlugin, PluginContext } from '../types';

export interface TTLPluginOptions {
  /** Default TTL in milliseconds applied when key-specific TTL is not defined */
  defaultTTL?: number;
  /** Per-key TTL overrides in milliseconds */
  keyTTL?: Record<string, number>;
  /** Optional cleanup interval in milliseconds */
  cleanupInterval?: number;
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

const cleanupExpired = async (
  context: PluginContext,
  options: TTLPluginOptions,
  metadata: TTLMetadata
): Promise<void> => {
  if (metadata.running) {
    return;
  }
  metadata.running = true;
  try {
    const keys = await context.instance.keys();
    for (const key of keys) {
      try {
        // Use plugin-aware getItem so TTL + encryption/compression are respected.
        await context.instance.getItem(key);
      } catch {
        // Ignore individual key failures during cleanup.
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
  beforeSet: async <T>(key: string, value: T): Promise<T> => {
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
});

export default ttlPlugin;
