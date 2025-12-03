import type { LocalSpacePlugin, PluginContext } from '../types';
import { createLocalSpaceError } from '../errors';
import serializer from '../utils/serializer';

export type QuotaEvictionPolicy = 'error' | 'lru';

export interface QuotaPluginOptions {
  /** Maximum storage size in bytes */
  maxSize?: number;
  /** Strategy when quota is exceeded */
  evictionPolicy?: QuotaEvictionPolicy;
  /** Callback invoked when eviction fails */
  onQuotaExceeded?: (info: QuotaExceededInfo) => Promise<void> | void;
  /** Use navigator.storage.estimate when available */
  useNavigatorEstimate?: boolean;
}

export interface QuotaExceededInfo {
  key: string;
  attemptedSize: number;
  delta: number;
  maxSize: number;
  currentUsage: number;
}

type QuotaMetadata = {
  initialized: boolean;
  usage: number;
  keySizes: Map<string, number>;
  access: Map<string, number>;
  accessCounter: number;
  computePromise?: Promise<void>;
  navigatorQuota?: number;
};

const QUOTA_METADATA_KEY = '__localspace_quota_metadata';
const encoder = new TextEncoder();

const getMetadata = (context: PluginContext): QuotaMetadata => {
  const existing = context.metadata[QUOTA_METADATA_KEY] as
    | QuotaMetadata
    | undefined;
  if (existing) {
    return existing;
  }
  const created: QuotaMetadata = {
    initialized: false,
    usage: 0,
    keySizes: new Map<string, number>(),
    access: new Map<string, number>(),
    accessCounter: 0,
  };
  context.metadata[QUOTA_METADATA_KEY] = created;
  return created;
};

const measureValueSize = async (value: unknown): Promise<number> => {
  const serialized = await serializer.serialize(value);
  return encoder.encode(serialized).byteLength;
};

const rebuildUsage = async (
  context: PluginContext,
  metadata: QuotaMetadata
): Promise<void> => {
  if (metadata.computePromise) {
    await metadata.computePromise;
    return;
  }

  metadata.computePromise = (async () => {
    const entries: Array<{ key: string; value: unknown }> = [];
    await context.instance.iterate<unknown, void>((value, key) => {
      entries.push({ key, value });
    });

    const previousAccess = new Map(metadata.access);
    metadata.keySizes.clear();
    metadata.access.clear();
    metadata.usage = 0;

    for (const entry of entries) {
      const size = await measureValueSize(entry.value);
      metadata.keySizes.set(entry.key, size);
      const existingAccess = previousAccess.get(entry.key);
      if (typeof existingAccess === 'number') {
        metadata.access.set(entry.key, existingAccess);
      } else {
        metadata.access.set(entry.key, ++metadata.accessCounter);
      }
      metadata.usage += size;
    }

    metadata.initialized = true;
    metadata.computePromise = undefined;
  })();

  await metadata.computePromise;
};

const resolveCapacity = async (
  context: PluginContext,
  metadata: QuotaMetadata,
  options: QuotaPluginOptions
): Promise<number> => {
  if (options.useNavigatorEstimate && typeof navigator !== 'undefined') {
    const estimate = navigator.storage?.estimate;
    if (typeof estimate === 'function') {
      try {
        const result = await estimate();
        if (typeof result.quota === 'number') {
          metadata.navigatorQuota = result.quota;
        }
      } catch (error) {
        console.warn(
          'localspace quota: navigator.storage.estimate failed',
          error
        );
      }
    }
  }
  const configured = options.maxSize ?? Infinity;
  const navigatorQuota = metadata.navigatorQuota ?? Infinity;
  return Math.min(configured, navigatorQuota);
};

const evictEntries = async (
  requiredDelta: number,
  capacity: number,
  metadata: QuotaMetadata,
  context: PluginContext,
  options: QuotaPluginOptions
): Promise<boolean> => {
  if (options.evictionPolicy !== 'lru') {
    return false;
  }

  const sorted = [...metadata.access.entries()].sort((a, b) => a[1] - b[1]);
  for (const [key] of sorted) {
    if (metadata.usage + requiredDelta <= capacity) {
      break;
    }
    await context.instance.removeItem(key);
  }

  return metadata.usage + requiredDelta <= capacity;
};

export const quotaPlugin = (
  options: QuotaPluginOptions = {}
): LocalSpacePlugin => {
  const evictionPolicy = options.evictionPolicy ?? 'error';

  return {
    name: 'quota',
    priority: -10,
    beforeSet: async (key, value, context) => {
      const metadata = getMetadata(context);
      if (!metadata.initialized) {
        await rebuildUsage(context, metadata);
      }

      const size = await measureValueSize(value);
      const previousSize = metadata.keySizes.get(key) ?? 0;
      const delta = size - previousSize;

      const capacity = await resolveCapacity(context, metadata, options);
      if (!Number.isFinite(capacity)) {
        return value;
      }

      if (metadata.usage + delta > capacity) {
        if (evictionPolicy === 'lru') {
          const success = await evictEntries(
            delta,
            capacity,
            metadata,
            context,
            options
          );
          if (!success) {
            await options.onQuotaExceeded?.({
              key,
              attemptedSize: size,
              delta,
              maxSize: capacity,
              currentUsage: metadata.usage,
            });
            throw createLocalSpaceError(
              'QUOTA_EXCEEDED',
              'Storage quota exceeded.'
            );
          }
        } else {
          await options.onQuotaExceeded?.({
            key,
            attemptedSize: size,
            delta,
            maxSize: capacity,
            currentUsage: metadata.usage,
          });
          throw createLocalSpaceError(
            'QUOTA_EXCEEDED',
            'Storage quota exceeded.'
          );
        }
      }

      context.operationState.quota = { key, size, delta };
      return value;
    },
    afterSet: async (key, _value, context) => {
      const metadata = getMetadata(context);
      const quotaState = context.operationState.quota as
        | { key: string; size: number; delta: number }
        | undefined;
      if (!quotaState) {
        return;
      }
      metadata.keySizes.set(key, quotaState.size);
      metadata.access.set(key, ++metadata.accessCounter);
      metadata.usage += quotaState.delta;
      delete context.operationState.quota;
    },
    afterGet: async (key, value, context) => {
      const metadata = getMetadata(context);
      if (metadata.access.has(key)) {
        metadata.access.set(key, ++metadata.accessCounter);
      }
      return value;
    },
    afterRemove: async (key, context) => {
      const metadata = getMetadata(context);
      const size = metadata.keySizes.get(key) ?? 0;
      if (size > 0) {
        metadata.usage = Math.max(0, metadata.usage - size);
      }
      metadata.keySizes.delete(key);
      metadata.access.delete(key);
    },
  };
};

export default quotaPlugin;
