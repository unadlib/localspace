import { afterEach, describe, expect, it, vi } from 'vitest';
import { broadcastNotificationPlugin } from '../examples/broadcast-notification-plugin';
import type { PluginContext } from '../src';

class BroadcastChannelMock {
  static instances: BroadcastChannelMock[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly name: string) {
    BroadcastChannelMock.instances.push(this);
  }

  postMessage() {}

  close() {}
}

const createContext = (): PluginContext =>
  ({
    metadata: Object.create(null),
    operationState: Object.create(null),
  }) as PluginContext;

describe('broadcast notification plugin example', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    BroadcastChannelMock.instances = [];
  });

  it('exposes notification hooks without entering the package surface', () => {
    const plugin = broadcastNotificationPlugin();

    expect(plugin.name).toBe('broadcast-notification');
    expect(plugin.onInit).toBeTypeOf('function');
    expect(plugin.onDestroy).toBeTypeOf('function');
    expect(plugin.afterSet).toBeTypeOf('function');
    expect(plugin.afterRemove).toBeTypeOf('function');
  });

  it('routes rejected message handlers through onError', async () => {
    vi.stubGlobal('BroadcastChannel', BroadcastChannelMock);
    const failure = new Error('message failed');
    const onError = vi.fn();
    const plugin = broadcastNotificationPlugin({
      onMessage: async () => {
        throw failure;
      },
      onError,
    });
    const context = createContext();

    await plugin.onInit?.(context);
    const channel = BroadcastChannelMock.instances[0];
    channel.onmessage?.({
      data: {
        key: 'key',
        operation: 'set',
        source: 'remote',
        timestamp: Date.now(),
      },
    } as MessageEvent);

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(failure, context)
    );
  });

  it('ignores malformed messages from a shared channel', async () => {
    vi.stubGlobal('BroadcastChannel', BroadcastChannelMock);
    const onMessage = vi.fn();
    const plugin = broadcastNotificationPlugin({ onMessage });
    const context = createContext();

    await plugin.onInit?.(context);
    const channel = BroadcastChannelMock.instances[0];

    expect(() =>
      channel.onmessage?.({ data: null } as MessageEvent)
    ).not.toThrow();
    expect(() =>
      channel.onmessage?.({
        data: { source: 'remote', operation: 'unknown' },
      } as MessageEvent)
    ).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
