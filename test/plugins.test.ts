import { describe, it, expect, vi, beforeAll } from 'vitest';
import localspace, {
  LocalSpace,
  ttlPlugin,
  encryptionPlugin,
  compressionPlugin,
  syncPlugin,
  quotaPlugin,
  LocalSpacePlugin,
} from '../src';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

declare global {
  // eslint-disable-next-line no-var
  var BroadcastChannel: typeof globalThis.BroadcastChannel;
}

beforeAll(() => {
  class MockBroadcastChannel {
    static channels: Record<string, Set<MockBroadcastChannel>> = {};

    name: string;

    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(name: string) {
      this.name = name;
      MockBroadcastChannel.channels[name] = MockBroadcastChannel.channels[name] || new Set();
      MockBroadcastChannel.channels[name]!.add(this);
    }

    postMessage(data: unknown) {
      const peers = MockBroadcastChannel.channels[this.name];
      if (!peers) return;
      for (const peer of peers) {
        if (peer === this) continue;
        peer.onmessage?.({ data } as MessageEvent);
      }
    }

    close() {
      MockBroadcastChannel.channels[this.name]?.delete(this);
    }
  }

  (globalThis as any).BroadcastChannel = MockBroadcastChannel;
});

describe('Plugin system', () => {
  it('applies custom plugins in registration order', async () => {
    const order: string[] = [];
    const augmentPlugin: LocalSpacePlugin = {
      name: 'augment',
      beforeSet: (key, value) => {
        order.push(`before-${key}`);
        return `a:${value}`;
      },
      afterGet: async (key, value) => {
        order.push(`after-${key}`);
        return typeof value === 'string' ? value.replace(/^a:/, '') : value;
      },
    };

    const suffixPlugin: LocalSpacePlugin = {
      name: 'suffix',
      beforeSet: (_key, value) => `${value}:b`,
      afterGet: (_key, value) =>
        typeof value === 'string' ? value.replace(/:b$/, '') : value,
    };

    const instance = new LocalSpace({
      name: 'plugin-order',
      storeName: 'plugin-order-store',
    });
    instance.use([augmentPlugin, suffixPlugin]);

    await instance.setItem('foo', 'value');
    const result = await instance.getItem('foo');

    expect(result).toBe('value');
    expect(order).toEqual(['before-foo', 'after-foo']);
  });

  it('expires values via ttl plugin', async () => {
    const store = localspace.createInstance({
      name: 'ttl-plugin',
      storeName: 'ttl-store',
      plugins: [ttlPlugin({ defaultTTL: 10 })],
    });

    await store.setItem('session', 'token');
    await sleep(25);
    const value = await store.getItem('session');

    expect(value).toBeNull();
  });

  it('cleans up expired ttl entries via scheduled sweep', async () => {
    const onExpire = vi.fn();
    const store = localspace.createInstance({
      name: 'ttl-cleanup-plugin',
      storeName: 'ttl-cleanup-store',
      plugins: [
        ttlPlugin({
          defaultTTL: 5,
          cleanupInterval: 10,
          onExpire,
        }),
      ],
    });

    await store.setItem('ephemeral', 'value');
    await sleep(40);

    expect(onExpire).toHaveBeenCalledWith('ephemeral', 'value');
    const remaining = await store.getItem('ephemeral');
    expect(remaining).toBeNull();
  });

  it('encrypts and decrypts values', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const secure = localspace.createInstance({
      name: 'secure-db',
      storeName: 'secure-store',
      plugins: [encryptionPlugin({ key })],
    });

    await secure.setItem('secret', { user: 'ada' });

    const rawReader = localspace.createInstance({
      name: 'secure-db',
      storeName: 'secure-store',
    });

    const raw = await rawReader.getItem('secret');
    expect(raw).toMatchObject({ __ls_encrypted: true });

    const decrypted = await secure.getItem<{ user: string }>('secret');
    expect(decrypted?.user).toBe('ada');
  });

  it('derives encryption keys and detects tampered payloads', async () => {
    const secure = localspace.createInstance({
      name: 'secure-derived-db',
      storeName: 'secure-derived-store',
      plugins: [
        encryptionPlugin({
          keyDerivation: {
            passphrase: 'correct horse battery staple',
            salt: 'salty-salt',
            iterations: 1000,
            hash: 'SHA-256',
            length: 256,
          },
        }),
      ],
    });

    await secure.setItem('record', { id: 42 });

    const rawReader = localspace.createInstance({
      name: 'secure-derived-db',
      storeName: 'secure-derived-store',
    });
    const raw = await rawReader.getItem('record');
    expect(raw).not.toBeNull();
    expect(raw).toMatchObject({ __ls_encrypted: true });

    if (!raw || typeof raw !== 'object') {
      throw new Error('Encrypted payload missing');
    }

    type RawEncryptedPayload = {
      __ls_encrypted: true;
      algorithm: string;
      iv: string;
      data: string;
    };
    const encryptedPayload = raw as RawEncryptedPayload;
    const tampered: RawEncryptedPayload = {
      ...encryptedPayload,
      data: `tampered-${encryptedPayload.data}`,
    };
    await rawReader.setItem('record', tampered);

    await expect(secure.getItem('record')).rejects.toThrow(
      'Failed to decrypt payload'
    );
  });

  it('compresses large payloads transparently', async () => {
    const payload = 'x'.repeat(5000);
    const compressedStore = localspace.createInstance({
      name: 'compress-db',
      storeName: 'compress-store',
      plugins: [compressionPlugin({ threshold: 512 })],
    });

    await compressedStore.setItem('blob', payload);

    const rawReader = localspace.createInstance({
      name: 'compress-db',
      storeName: 'compress-store',
    });

    const raw = await rawReader.getItem('blob');
    expect(raw).toMatchObject({ __ls_compressed: true });

    const restored = await compressedStore.getItem<string>('blob');
    expect(restored).toBe(payload);
  });

  it('synchronizes changes across instances', async () => {
    const plugins = [syncPlugin({ channelName: 'sync-test' })];
    const primary = localspace.createInstance({
      name: 'sync-db',
      storeName: 'sync-store',
      plugins,
    });
    const secondary = localspace.createInstance({
      name: 'sync-db',
      storeName: 'sync-store',
      plugins,
    });

    await primary.setItem('shared', 'value-1');
    await sleep(5);
    const synced = await secondary.getItem('shared');
    expect(synced).toBe('value-1');
  });

  it('enforces quota limits with errors', async () => {
    const store = localspace.createInstance({
      name: 'quota-db',
      storeName: 'quota-store',
      plugins: [quotaPlugin({ maxSize: 200, evictionPolicy: 'error' })],
    });

    await store.setItem('alpha', 'a'.repeat(100));
    await expect(store.setItem('beta', 'b'.repeat(500))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('evicts least-recently-used entries when quota allows', async () => {
    const store = localspace.createInstance({
      name: 'quota-db-lru',
      storeName: 'quota-store-lru',
      plugins: [quotaPlugin({ maxSize: 400, evictionPolicy: 'lru' })],
    });

    await store.setItem('k1', 'a'.repeat(150));
    await store.setItem('k2', 'b'.repeat(150));
    await store.getItem('k1'); // refresh access

    await store.setItem('k3', 'c'.repeat(200));
    const removed = await store.getItem('k2');
    const kept = await store.getItem('k3');

    expect(removed).toBeNull();
    expect(kept).toBe('c'.repeat(200));
  });

  it('unwinds plugin transformations in reverse order', async () => {
    const order: string[] = [];
    const makePlugin = (name: string): LocalSpacePlugin => ({
      name,
      beforeSet: (_key, value) => {
        order.push(`before:${name}`);
        return typeof value === 'string' ? `${name}|${value}` : value;
      },
      afterSet: () => {
        order.push(`afterSet:${name}`);
      },
      afterGet: (_key, value) => {
        order.push(`afterGet:${name}`);
        if (typeof value === 'string' && value.startsWith(`${name}|`)) {
          return value.slice(name.length + 1);
        }
        return value;
      },
    });

    const instance = new LocalSpace({
      name: 'plugin-unwind',
      storeName: 'plugin-unwind-store',
    });
    instance.use([makePlugin('alpha'), makePlugin('beta')]);

    await instance.setItem('topic', 'value');
    const result = await instance.getItem('topic');

    expect(result).toBe('value');
    expect(order).toEqual([
      'before:alpha',
      'before:beta',
      'afterSet:beta',
      'afterSet:alpha',
      'afterGet:beta',
      'afterGet:alpha',
    ]);
  });

  it('runs onDestroy hooks via instance.destroy()', async () => {
    const onDestroy = vi.fn();
    const plugin: LocalSpacePlugin = {
      name: 'cleanup',
      onDestroy,
    };
    const instance = new LocalSpace({
      name: 'plugin-destroy',
      storeName: 'plugin-destroy-store',
    });
    instance.use(plugin);

    await instance.setItem('foo', 'bar');
    await instance.destroy();
    await instance.destroy();

    expect(onDestroy).toHaveBeenCalledTimes(1);
  });

  it('combines encryption + compression + ttl correctly', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const store = localspace.createInstance({
      name: 'combo-db',
      storeName: 'combo-store',
      plugins: [
        ttlPlugin({ defaultTTL: 60000 }),
        encryptionPlugin({ key }),
        compressionPlugin({ threshold: 10 }),
      ],
    });

    const payload = { message: 'x'.repeat(100) };
    await store.setItem('combo', payload);

    // Raw reader sees encrypted payload (encryption wraps compressed+ttl payload)
    const rawReader = localspace.createInstance({
      name: 'combo-db',
      storeName: 'combo-store',
    });
    const raw = await rawReader.getItem('combo');
    expect(raw).toMatchObject({ __ls_encrypted: true });

    // Same store can decompress, decrypt, and unwrap TTL
    const restored = await store.getItem<{ message: string }>('combo');
    expect(restored?.message).toBe('x'.repeat(100));
  });

  it('handles plugin errors via onError hook', async () => {
    const errorHandler = vi.fn();
    const failingPlugin: LocalSpacePlugin = {
      name: 'failing',
      onError: errorHandler,
      beforeSet: () => {
        throw new Error('intentional');
      },
    };

    const store = localspace.createInstance({
      name: 'error-db',
      storeName: 'error-store',
      plugins: [failingPlugin],
      pluginErrorPolicy: 'lenient',
    });

    await store.setItem('key', 'value');
    expect(errorHandler).toHaveBeenCalled();
    expect(errorHandler.mock.calls[0][0].message).toBe('intentional');
  });

  it('propagates plugin init errors by default (fail policy)', async () => {
    const failingInitPlugin: LocalSpacePlugin = {
      name: 'failing-init',
      onInit: () => {
        throw new Error('init failed');
      },
    };

    const store = localspace.createInstance({
      name: 'init-fail-db',
      storeName: 'init-fail-store',
      plugins: [failingInitPlugin],
    });

    await store.ready();
    // Plugin init is lazy - triggered on first storage operation
    await expect(store.setItem('key', 'value')).rejects.toThrow('init failed');
  });

  it('disables plugin and continues when pluginInitPolicy is disable-and-continue', async () => {
    const initCalls: string[] = [];
    const setCalls: string[] = [];

    const failingInitPlugin: LocalSpacePlugin = {
      name: 'failing-init',
      onInit: () => {
        initCalls.push('failing');
        throw new Error('init failed');
      },
      beforeSet: (_key, value) => {
        setCalls.push('failing');
        return value;
      },
    };

    const workingPlugin: LocalSpacePlugin = {
      name: 'working',
      onInit: () => {
        initCalls.push('working');
      },
      beforeSet: (_key, value) => {
        setCalls.push('working');
        return value;
      },
    };

    const store = localspace.createInstance({
      name: 'init-disable-db',
      storeName: 'init-disable-store',
      plugins: [failingInitPlugin, workingPlugin],
      pluginInitPolicy: 'disable-and-continue',
    });

    await store.ready();

    // First storage operation triggers plugin init
    await store.setItem('key', 'value');

    // Both plugins attempted init
    expect(initCalls).toContain('failing');
    expect(initCalls).toContain('working');

    // Only working plugin should run hooks (failing one is disabled)
    expect(setCalls).not.toContain('failing');
    expect(setCalls).toContain('working');
  });

  it('provides batch context to plugins', async () => {
    const contexts: Array<{ isBatch?: boolean; batchSize?: number }> = [];
    const observerPlugin: LocalSpacePlugin = {
      name: 'observer',
      beforeSet: (_key, value, context) => {
        contexts.push({
          isBatch: context.operationState.isBatch as boolean,
          batchSize: context.operationState.batchSize as number,
        });
        return value;
      },
    };

    const store = localspace.createInstance({
      name: 'batch-ctx-db',
      storeName: 'batch-ctx-store',
      plugins: [observerPlugin],
    });

    await store.setItem('single', 'value');
    await store.setItems([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ]);

    expect(contexts[0].isBatch).toBeFalsy();
    expect(contexts[1].isBatch).toBe(true);
    expect(contexts[1].batchSize).toBe(2);
    expect(contexts[2].isBatch).toBe(true);
    expect(contexts[2].batchSize).toBe(2);
  });

  it('sync plugin broadcasts original value, not transformed', async () => {
    const broadcastedValues: unknown[] = [];

    // Intercept what sync plugin broadcasts
    const interceptor: LocalSpacePlugin = {
      name: 'interceptor',
      priority: -101, // After sync
      afterSet: (_key, _value, context) => {
        // Sync runs at -100, so by the time we get here the message is sent
        // We can check operationState to see what was available
        broadcastedValues.push(context.operationState.originalValue);
      },
    };

    const transformer: LocalSpacePlugin = {
      name: 'transformer',
      priority: 50,
      beforeSet: <T>(_key: string, value: T): T => {
        return `transformed:${value}` as unknown as T;
      },
    };

    const primary = localspace.createInstance({
      name: 'sync-transform-db-2',
      storeName: 'sync-transform-store-2',
      plugins: [
        syncPlugin({ channelName: 'sync-transform-test-2' }),
        transformer,
        interceptor,
      ],
    });

    await primary.setItem('msg', 'hello');

    // The sync plugin should have access to originalValue = 'hello'
    expect(broadcastedValues[0]).toBe('hello');
  });
});
