import type { LocalSpacePlugin, PluginContext } from '../types';

export interface SyncPluginOptions {
  channelName?: string;
  syncKeys?: string[];
  conflictStrategy?: 'last-write-wins' | 'custom';
  onConflict?: (
    payload: SyncConflictPayload
  ) => Promise<boolean | void> | boolean | void;
}

export interface SyncConflictPayload {
  key: string;
  localTimestamp?: number;
  incomingTimestamp: number;
  value?: unknown;
}

type SyncMessage = {
  key: string;
  type: 'set' | 'remove';
  value?: unknown;
  timestamp: number;
  source: string;
};

type BroadcastHandle = {
  postMessage: (message: SyncMessage) => void;
  close: () => void;
};

type SyncMetadata = {
  instanceId: string;
  channel?: BroadcastHandle;
  versions: Map<string, number>;
  suppress?: boolean;
  storageHandler?: (event: StorageEvent) => void;
};

const SYNC_METADATA_KEY = '__localspace_sync_metadata';
const STORAGE_PREFIX = '__localspace_sync__';
const VERSION_STORAGE_PREFIX = '__localspace_sync_versions__';

const randomId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const getMetadata = (context: PluginContext): SyncMetadata => {
  const existing = context.metadata[SYNC_METADATA_KEY] as
    | SyncMetadata
    | undefined;
  if (existing) {
    return existing;
  }
  const created: SyncMetadata = {
    instanceId: randomId(),
    versions: new Map<string, number>(),
  };
  context.metadata[SYNC_METADATA_KEY] = created;
  return created;
};

const getVersionStorageKey = (context: PluginContext, channelName: string) => {
  const name = context.config.name ?? 'default';
  const storeName = context.config.storeName ?? 'keyvaluepairs';
  return `${VERSION_STORAGE_PREFIX}:${channelName}:${name}:${storeName}`;
};

const loadPersistedVersions = (
  context: PluginContext,
  channelName: string,
  metadata: SyncMetadata
) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  const key = getVersionStorageKey(context, channelName);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as Record<string, number>;
    for (const [k, v] of Object.entries(parsed)) {
      const ts = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(ts)) continue;
      metadata.versions.set(k, ts);
    }
  } catch (error) {
    console.warn('localspace sync: failed to load version map', error);
  }
};

const persistVersions = (
  context: PluginContext,
  channelName: string,
  metadata: SyncMetadata
) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  const key = getVersionStorageKey(context, channelName);
  try {
    const obj: Record<string, number> = {};
    for (const [k, v] of metadata.versions.entries()) {
      obj[k] = v;
    }
    window.localStorage.setItem(key, JSON.stringify(obj));
  } catch (error) {
    console.warn('localspace sync: failed to persist version map', error);
  }
};

const createBroadcastChannel = (
  name: string,
  context: PluginContext,
  options: SyncPluginOptions,
  metadata: SyncMetadata
): BroadcastHandle | undefined => {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(name);
    channel.onmessage = (event) => {
      void handleIncoming(
        event.data as SyncMessage,
        context,
        options,
        metadata
      );
    };
    return {
      postMessage: (message) => channel.postMessage(message),
      close: () => channel.close(),
    };
  }

  if (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    const storageKey = `${STORAGE_PREFIX}:${name}`;
    const handler = (event: StorageEvent) => {
      if (event.key !== storageKey || !event.newValue) {
        return;
      }
      try {
        const message = JSON.parse(event.newValue) as SyncMessage;
        void handleIncoming(message, context, options, metadata);
      } catch (error) {
        console.warn('localspace sync: failed to parse storage message', error);
      }
    };
    window.addEventListener('storage', handler);
    metadata.storageHandler = handler;

    return {
      postMessage: (message) => {
        try {
          window.localStorage?.setItem(storageKey, JSON.stringify(message));
          window.localStorage?.removeItem(storageKey);
        } catch (error) {
          console.warn('localspace sync: failed to broadcast message', error);
        }
      },
      close: () => {
        window.removeEventListener('storage', handler);
      },
    };
  }

  return undefined;
};

const shouldSyncKey = (key: string, options: SyncPluginOptions): boolean => {
  if (!options.syncKeys || options.syncKeys.length === 0) {
    return true;
  }
  return options.syncKeys.includes(key);
};

const broadcast = (
  message: SyncMessage,
  metadata: SyncMetadata,
  name: string,
  context: PluginContext,
  options: SyncPluginOptions
) => {
  if (!metadata.channel) {
    metadata.channel = createBroadcastChannel(name, context, options, metadata);
    if (!metadata.channel) {
      return;
    }
  }
  metadata.channel.postMessage(message);
  metadata.versions.set(message.key, message.timestamp);
  persistVersions(context, name, metadata);
};

const handleIncoming = async (
  message: SyncMessage,
  context: PluginContext,
  options: SyncPluginOptions,
  metadata: SyncMetadata
) => {
  if (message.source === metadata.instanceId) {
    return;
  }
  if (!shouldSyncKey(message.key, options)) {
    return;
  }

  const localTimestamp = metadata.versions.get(message.key) ?? 0;
  if (
    options.conflictStrategy !== 'custom' &&
    localTimestamp > message.timestamp
  ) {
    await options.onConflict?.({
      key: message.key,
      localTimestamp,
      incomingTimestamp: message.timestamp,
      value: message.value,
    });
    return;
  }

  if (options.conflictStrategy === 'custom' && options.onConflict) {
    const decision = await options.onConflict({
      key: message.key,
      localTimestamp,
      incomingTimestamp: message.timestamp,
      value: message.value,
    });
    if (decision === false) {
      return;
    }
  }

  metadata.suppress = true;
  try {
    if (message.type === 'set') {
      await context.instance.setItem(message.key, message.value);
    } else {
      await context.instance.removeItem(message.key);
    }
    metadata.versions.set(message.key, message.timestamp);
    persistVersions(context, options.channelName ?? 'localspace-sync', metadata);
  } finally {
    metadata.suppress = false;
  }
};

export const syncPlugin = (
  options: SyncPluginOptions = {}
): LocalSpacePlugin => {
  const channelName = options.channelName ?? 'localspace-sync';

  return {
    name: 'sync',
    // Low priority so afterSet runs last (afterSet executes plugins in reverse order)
    priority: -100,
    onInit: async (context) => {
      const metadata = getMetadata(context);
      loadPersistedVersions(context, channelName, metadata);
      if (!metadata.channel) {
        metadata.channel = createBroadcastChannel(
          channelName,
          context,
          options,
          metadata
        );
      }
    },
    onDestroy: async (context) => {
      const metadata = getMetadata(context);
      metadata.channel?.close();
      metadata.channel = undefined;
      if (metadata.storageHandler && typeof window !== 'undefined') {
        window.removeEventListener('storage', metadata.storageHandler);
        metadata.storageHandler = undefined;
      }
    },
    afterSet: async (key, value, context) => {
      // Skip if already processed by batch hook
      if (context.operationState.isBatch) {
        return;
      }
      if (!shouldSyncKey(key, options)) {
        return;
      }
      const metadata = getMetadata(context);
      if (metadata.suppress) {
        return;
      }
      const payload =
        context.operationState.originalValue ??
        context.operationState.returnValue ??
        value;
      const message: SyncMessage = {
        key,
        type: 'set',
        value: payload,
        timestamp: Date.now(),
        source: metadata.instanceId,
      };
      broadcast(message, metadata, channelName, context, options);
    },
    afterRemove: async (key, context) => {
      // Skip if already processed by batch hook
      if (context.operationState.isBatch) {
        return;
      }
      if (!shouldSyncKey(key, options)) {
        return;
      }
      const metadata = getMetadata(context);
      if (metadata.suppress) {
        return;
      }
      const message: SyncMessage = {
        key,
        type: 'remove',
        timestamp: Date.now(),
        source: metadata.instanceId,
      };
      broadcast(message, metadata, channelName, context, options);
    },
    // Note: Batch operations (setItems/removeItems) are not synced via broadcast
    // because the original values are transformed before reaching afterSetItems.
    // Instances sharing the same database will still work correctly since they
    // read from the shared IndexedDB. For cross-tab sync with batch operations,
    // consider using single-item operations or implement custom sync logic.
  };
};

// Test hooks
if (process.env.NODE_ENV === 'test') {
  (syncPlugin as any).__test__ = {
    VERSION_STORAGE_PREFIX,
    getVersionStorageKey,
    loadPersistedVersions,
    persistVersions,
  };
}

export default syncPlugin;
