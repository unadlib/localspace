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
  onError?: (error: unknown, context: PluginContext) => Promise<void> | void;
}

type NotificationMetadata = {
  channel?: BroadcastChannel;
  source: string;
};

const METADATA_KEY = '__broadcast_notification_plugin';

const defaultChannelName = (context: PluginContext): string =>
  `localspace-notifications:${JSON.stringify([
    context.driver,
    context.config.bucket?.name ?? null,
    context.config.name ?? 'localforage',
    context.config.storeName ?? 'keyvaluepairs',
  ])}`;

const runInBackground = (operation: Promise<void>): void => {
  operation.catch(() => undefined);
};

const isStorageNotification = (
  value: unknown
): value is StorageNotification => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<StorageNotification>;
  return (
    typeof candidate.key === 'string' &&
    (candidate.operation === 'set' || candidate.operation === 'remove') &&
    typeof candidate.source === 'string' &&
    typeof candidate.timestamp === 'number' &&
    Number.isFinite(candidate.timestamp)
  );
};

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
  const reportError = async (
    error: unknown,
    context: PluginContext,
    message: string
  ): Promise<void> => {
    try {
      if (options.onError) {
        await options.onError(error, context);
      } else {
        console.error(`[localspace example] ${message}`, error);
      }
    } catch (reportingError) {
      console.error(
        '[localspace example] broadcast notification error handler failed',
        reportingError
      );
    }
  };

  const receive = async (
    message: StorageNotification,
    context: PluginContext
  ): Promise<void> => {
    try {
      await options.onMessage?.(message, context);
    } catch (error) {
      await reportError(
        error,
        context,
        'broadcast notification handler failed'
      );
    }
  };

  const send = (
    context: PluginContext,
    key: string,
    operation: StorageNotification['operation']
  ) => {
    const metadata = getMetadata(context);
    try {
      metadata.channel?.postMessage({
        key,
        operation,
        source: metadata.source,
        timestamp: Date.now(),
      } satisfies StorageNotification);
    } catch (error) {
      runInBackground(
        reportError(error, context, 'broadcast notification send failed')
      );
    }
  };

  return {
    name: 'broadcast-notification',
    onInit: (context) => {
      if (typeof BroadcastChannel === 'undefined') {
        return;
      }

      const metadata = getMetadata(context);
      try {
        const channel = new BroadcastChannel(
          options.channelName ?? defaultChannelName(context)
        );
        channel.onmessage = (event) => {
          const message: unknown = event.data;
          if (!isStorageNotification(message)) {
            return;
          }
          if (message.source !== metadata.source) {
            runInBackground(receive(message, context));
          }
        };
        metadata.channel = channel;
      } catch (error) {
        runInBackground(
          reportError(
            error,
            context,
            'broadcast notification channel initialization failed'
          )
        );
      }
    },
    onDestroy: (context) => {
      const metadata = getMetadata(context);
      try {
        metadata.channel?.close();
      } catch (error) {
        runInBackground(
          reportError(
            error,
            context,
            'broadcast notification channel close failed'
          )
        );
      } finally {
        metadata.channel = undefined;
      }
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
