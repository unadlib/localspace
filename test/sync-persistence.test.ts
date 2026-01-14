import { describe, it, expect, beforeEach } from 'vitest';
import syncPlugin from '../src/plugins/sync';
import type { PluginContext } from '../src/types';

const testHooks = (syncPlugin as any).__test__;

const createContext = (overrides: Partial<PluginContext> = {}): PluginContext =>
  ({
    instance: {
      setItem: async () => {},
      removeItem: async () => {},
    } as any,
    driver: null,
    dbInfo: null,
    config: { name: 'db', storeName: 'store' },
    metadata: Object.create(null),
    operation: null,
    operationState: Object.create(null),
    ...overrides,
  } satisfies PluginContext);

describe('sync plugin version persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('loads persisted versions on init', async () => {
    const channelName = 'channel';
    const context = createContext();
    const plugin = syncPlugin({ channelName });

    const key = testHooks.getVersionStorageKey(context, channelName);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        foo: 123,
        bar: 456,
      })
    );

    await plugin.onInit?.(context);

    const metadata = (context.metadata as any).__localspace_sync_metadata;
    expect(metadata.versions.get('foo')).toBe(123);
    expect(metadata.versions.get('bar')).toBe(456);
  });

  it('persists versions when broadcasting', async () => {
    const channelName = 'channel';
    const context = createContext();
    const plugin = syncPlugin({ channelName });

    await plugin.onInit?.(context);

    await plugin.afterSet?.('k1', 'v1', context);

    const metadata = (context.metadata as any).__localspace_sync_metadata;
    const key = testHooks.getVersionStorageKey(context, channelName);
    const stored = window.localStorage.getItem(key);
    expect(stored).toBeTruthy();
    const parsed = stored ? JSON.parse(stored) : {};
    expect(parsed.k1).toBe(metadata.versions.get('k1'));
  });
});
