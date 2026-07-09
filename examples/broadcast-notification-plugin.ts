import type { LocalSpacePlugin, PluginContext } from '../src';

export interface StorageNotification {
  key: string;
  operation: 'set' | 'remove';
  source: string;
  timestamp: number;
}

export interface BroadcastNotificationOptions {
  channelName?: string;
  onMessage?: (
    message: StorageNotification,
    context: PluginContext
  ) => Promise<void> | void;
}

type NotificationMetadata = {
  channel?: BroadcastChannel;
  source: string;
};

const METADATA_KEY = '__broadcast_notification_plugin';

const getMetadata = (context: PluginContext): NotificationMetadata => {
  const existing = context.metadata[METADATA_KEY] as
    | NotificationMetadata
    | undefined;
  if (existing) {
    return existing;
  }

  const metadata: NotificationMetadata = {
    source:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
  };
  context.metadata[METADATA_KEY] = metadata;
  return metadata;
};

/**
 * Example only: broadcasts best-effort single-item change notifications.
 * It does not replicate values, guarantee delivery/order, or handle batches.
 */
export const broadcastNotificationPlugin = (
  options: BroadcastNotificationOptions = {}
): LocalSpacePlugin => {
  const channelName = options.channelName ?? 'localspace-notifications';

  const send = (
    context: PluginContext,
    key: string,
    operation: StorageNotification['operation']
  ) => {
    const metadata = getMetadata(context);
    metadata.channel?.postMessage({
      key,
      operation,
      source: metadata.source,
      timestamp: Date.now(),
    } satisfies StorageNotification);
  };

  return {
    name: 'broadcast-notification',
    onInit: (context) => {
      if (typeof BroadcastChannel === 'undefined') {
        return;
      }

      const metadata = getMetadata(context);
      const channel = new BroadcastChannel(channelName);
      channel.onmessage = (event) => {
        const message = event.data as StorageNotification;
        if (message.source !== metadata.source) {
          void options.onMessage?.(message, context);
        }
      };
      metadata.channel = channel;
    },
    onDestroy: (context) => {
      const metadata = getMetadata(context);
      metadata.channel?.close();
      metadata.channel = undefined;
    },
    afterSet: (key, _value, context) => {
      if (!context.operationState.isBatch) {
        send(context, key, 'set');
      }
    },
    afterRemove: (key, context) => {
      if (!context.operationState.isBatch) {
        send(context, key, 'remove');
      }
    },
  };
};
